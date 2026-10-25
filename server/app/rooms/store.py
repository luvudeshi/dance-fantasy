"""Room rules: codes and tokens, joining, the lobby -> countdown -> playing -> finished flow, scores, chat.

Every function takes ``now`` (epoch ms) so the timing rules are testable, and runs as one
transaction (``app.rooms.db``). State is derived from times, never advanced by a timer:

- ``lobby``: no start time. ``countdown``: now < startAt. ``playing``: after startAt until every
  connected player has finished or ``MAX_PLAY_MS`` passed; then ``finished``, which sticks
  (``finished_at``) until the host picks a routine or starts again.
- A player is connected while their last authenticated request is under ``CONNECTED_MS`` old.
- Rooms expire ``ROOM_TTL_MS`` after the last authenticated request; expired rooms read as 404
  and are deleted the next time someone creates a room.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from typing import Any

from fastapi import HTTPException, status

from app.rooms.db import Row, Tx, transaction
from app.rooms.models import (
    MAX_NAME,
    ChatMessage,
    Created,
    Joined,
    PlayerView,
    RoomState,
    RoomView,
    RoutineChoice,
    ScoreBody,
)

log = logging.getLogger(__name__)

CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ"  # no I, L, O: easy to read off a screen
CODE_LEN = 4
MAX_PLAYERS = 8
COUNTDOWN_MS = 5_000
MAX_PLAY_MS = 10 * 60_000
CONNECTED_MS = 10_000
ROOM_TTL_MS = 3 * 60 * 60_000
CHAT_PAGE = 50
CHAT_KEEP = 200  # older messages are trimmed
CHAT_BURST = 5  # messages per player per CHAT_WINDOW_MS
CHAT_WINDOW_MS = 10_000

_RESET_PLAYERS = (
    "update df_players set ready = 0, score = 0, combo = 0, max_combo = 0, accuracy = 0, progress = 0, finished = 0"
    " where code = :code"
)


def normalize_code(code: str) -> str | None:
    code = code.strip().upper()
    return code if len(code) == CODE_LEN and all(c in CODE_LETTERS for c in code) else None


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, "No room with that code (it may have expired).")


def _unique_name(name: str, taken: set[str]) -> str:
    taken = {t.casefold() for t in taken}
    candidate, n = name, 1
    while candidate.casefold() in taken:
        n += 1
        suffix = f" {n}"
        candidate = name[: MAX_NAME - len(suffix)].rstrip() + suffix
    return candidate


def _add_player(tx: Tx, code: str, name: str, now: int, finished: bool = False, player_id: str | None = None) -> Joined:
    player_id, token = player_id or secrets.token_urlsafe(6), secrets.token_urlsafe(24)
    tx.run(
        "insert into df_players (id, code, token_hash, name, joined_at, seen_at, finished)"
        " values (:id, :code, :th, :name, :now, :now, :finished)",
        id=player_id, code=code, th=_hash(token), name=name, now=now, finished=int(finished),
    )  # fmt: skip
    return Joined(playerId=player_id, token=token)


def _live_room(tx: Tx, code: str, now: int, lock: bool) -> Row:
    norm = normalize_code(code)
    room = None
    if norm:
        room = tx.lock_room(norm) if lock else tx.one("select * from df_rooms where code = :code", code=norm)
    if room is None or room["active_at"] < now - ROOM_TTL_MS:
        raise _not_found()
    return room


def _player(tx: Tx, room: Row, token: str | None, now: int) -> Row:
    """The token's player in this room (401 otherwise); marks them seen and the room active."""
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing X-Player-Token.")
    player = tx.one("select * from df_players where code = :code and token_hash = :th", code=room["code"], th=_hash(token))
    if player is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unknown player token for this room.")
    tx.run("update df_rooms set active_at = :now where code = :code", now=now, code=room["code"])
    tx.run("update df_players set seen_at = :now where id = :id", now=now, id=player["id"])
    room["active_at"] = player["seen_at"] = now
    return player


def _require_host(room: Row, player: Row) -> None:
    if room["host_id"] != player["id"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the host can do that.")


def _connected(player: Row, now: int) -> bool:
    return bool(now - player["seen_at"] < CONNECTED_MS)


def _state(room: Row, players: list[Row], now: int) -> RoomState:
    start = room["start_at"]
    if start is None:
        return "lobby"
    if now < start:
        return "countdown"
    if room["finished_at"] is not None or now >= start + MAX_PLAY_MS:
        return "finished"
    if all(p["finished"] for p in players if _connected(p, now)):
        return "finished"
    return "playing"


def _players(tx: Tx, code: str) -> list[Row]:
    return tx.all("select * from df_players where code = :code order by joined_at, id", code=code)


def _settle(tx: Tx, room: Row, players: list[Row], now: int) -> RoomState:
    """The state now; persists ``finished`` the first time it is reached so it can't flip back."""
    state = _state(room, players, now)
    if state == "finished" and room["finished_at"] is None:
        tx.run("update df_rooms set finished_at = :now where code = :code", now=now, code=room["code"])
        room["finished_at"] = now
    return state


def _view(tx: Tx, room: Row, chat_after: int | None, now: int) -> RoomView:
    players = _players(tx, room["code"])
    state = _settle(tx, room, players, now)
    if chat_after is None:  # the latest page, oldest first
        chat = tx.all(
            "select * from (select * from df_chat where code = :code order by id desc limit :n) as c order by id",
            code=room["code"], n=CHAT_PAGE,
        )  # fmt: skip
    else:  # the next page after the cursor, so polling never skips a message
        chat = tx.all(
            "select * from df_chat where code = :code and id > :after order by id limit :n",
            code=room["code"], after=chat_after, n=CHAT_PAGE,
        )  # fmt: skip
    return RoomView(
        code=room["code"],
        state=state,
        hostId=room["host_id"],
        serverNow=now,
        startAt=room["start_at"],
        routine=RoutineChoice.model_validate_json(room["routine"]) if room["routine"] else None,
        players=[
            PlayerView(
                id=p["id"], name=p["name"], isHost=p["id"] == room["host_id"], ready=bool(p["ready"]),
                connected=_connected(p, now), score=int(p["score"]), combo=int(p["combo"]),
                maxCombo=int(p["max_combo"]), accuracy=float(p["accuracy"]), progress=float(p["progress"]),
                finished=bool(p["finished"]),
            )  # fmt: skip
            for p in players
        ],
        chat=[
            ChatMessage(id=int(m["id"]), playerId=m["player_id"], name=m["name"], text=m["text"], at=int(m["at"]))
            for m in chat
        ],
    )


# --- public API (one transaction each) ----------------------------------------------------------


def create_room(name: str, now: int) -> Created:
    def run(tx: Tx) -> Created:
        _sweep(tx, now)
        for _ in range(50):
            code = "".join(secrets.choice(CODE_LETTERS) for _ in range(CODE_LEN))
            host_id = secrets.token_urlsafe(6)
            inserted = tx.run(
                "insert into df_rooms (code, host_id, created_at, active_at) values (:code, :host, :now, :now)"
                " on conflict (code) do nothing",
                code=code, host=host_id, now=now,
            )  # fmt: skip
            if inserted == 1:
                joined = _add_player(tx, code, name, now, player_id=host_id)
                log.info("rooms: created %s", code)
                return Created(code=code, playerId=joined.playerId, token=joined.token)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Could not find a free room code. Try again.")

    return transaction(run)


def _sweep(tx: Tx, now: int) -> None:
    """Delete expired rooms, then rows whose room is gone (rooms first: see the lock order in app.rooms.db)."""
    if tx.run("delete from df_rooms where active_at < :cutoff", cutoff=now - ROOM_TTL_MS):
        tx.run("delete from df_players where code not in (select code from df_rooms)")
        tx.run("delete from df_chat where code not in (select code from df_rooms)")


def join_room(code: str, name: str, now: int) -> Joined:
    def run(tx: Tx) -> Joined:
        room = _live_room(tx, code, now, lock=True)
        players = _players(tx, room["code"])
        if len(players) >= MAX_PLAYERS:
            raise HTTPException(status.HTTP_409_CONFLICT, f"This room is full ({MAX_PLAYERS} dancers).")
        unique = _unique_name(name, {p["name"] for p in players})
        # Mid-song joiners sit this one out (finished, score 0) so they don't hold up the results.
        sit_out = _state(room, players, now) == "playing"
        joined = _add_player(tx, room["code"], unique, now, finished=sit_out)
        tx.run("update df_rooms set active_at = :now where code = :code", now=now, code=room["code"])
        return joined

    return transaction(run)


def get_room(code: str, token: str | None, chat_after: int | None, now: int) -> RoomView:
    def run(tx: Tx) -> RoomView:
        room = _live_room(tx, code, now, lock=token is not None)
        if token is not None:
            _player(tx, room, token, now)
        return _view(tx, room, chat_after, now)

    return transaction(run)


def _write(code: str, token: str | None, chat_after: int | None, now: int, change: Any) -> RoomView:
    """Authenticate, apply ``change(tx, room, player, state)``, and return the room as GET would."""

    def run(tx: Tx) -> RoomView:
        room = _live_room(tx, code, now, lock=True)
        player = _player(tx, room, token, now)
        change(tx, room, player, _settle(tx, room, _players(tx, room["code"]), now))
        return _view(tx, room, chat_after, now)

    return transaction(run)


def set_routine(code: str, token: str | None, routine: RoutineChoice, chat_after: int | None, now: int) -> RoomView:
    def change(tx: Tx, room: Row, player: Row, state: RoomState) -> None:
        _require_host(room, player)
        if state not in ("lobby", "finished"):
            raise HTTPException(status.HTTP_409_CONFLICT, "Wait for this song to finish before picking another.")
        tx.run(
            "update df_rooms set routine = :routine, start_at = null, finished_at = null where code = :code",
            routine=routine.model_dump_json(), code=room["code"],
        )  # fmt: skip
        tx.run(_RESET_PLAYERS, code=room["code"])
        room.update(routine=routine.model_dump_json(), start_at=None, finished_at=None)

    return _write(code, token, chat_after, now, change)


def set_ready(code: str, token: str | None, ready: bool, chat_after: int | None, now: int) -> RoomView:
    def change(tx: Tx, room: Row, player: Row, state: RoomState) -> None:
        tx.run("update df_players set ready = :ready where id = :id", ready=int(ready), id=player["id"])

    return _write(code, token, chat_after, now, change)


def start(code: str, token: str | None, chat_after: int | None, now: int) -> RoomView:
    def change(tx: Tx, room: Row, player: Row, state: RoomState) -> None:
        _require_host(room, player)
        if state not in ("lobby", "finished"):
            raise HTTPException(status.HTTP_409_CONFLICT, "The dance has already started.")
        if not room["routine"]:
            raise HTTPException(status.HTTP_409_CONFLICT, "Pick a routine first.")
        start_at = now + COUNTDOWN_MS
        tx.run("update df_rooms set start_at = :at, finished_at = null where code = :code", at=start_at, code=room["code"])
        tx.run(_RESET_PLAYERS, code=room["code"])
        room.update(start_at=start_at, finished_at=None)

    return _write(code, token, chat_after, now, change)


def post_score(code: str, token: str | None, body: ScoreBody, chat_after: int | None, now: int) -> RoomView:
    def change(tx: Tx, room: Row, player: Row, state: RoomState) -> None:
        if state != "playing":
            return  # late or early packets are ignored; the response's state tells the client why
        tx.run(
            "update df_players set score = :score, combo = :combo, max_combo = :max_combo, accuracy = :accuracy,"
            " progress = :progress, finished = :finished where id = :id",
            score=body.score, combo=body.combo, max_combo=body.maxCombo, accuracy=body.accuracy,
            progress=body.progress, finished=int(body.finished or bool(player["finished"])), id=player["id"],
        )  # fmt: skip

    return _write(code, token, chat_after, now, change)


def post_chat(code: str, token: str | None, text: str, chat_after: int | None, now: int) -> RoomView:
    def change(tx: Tx, room: Row, player: Row, state: RoomState) -> None:
        recent = tx.one(
            "select count(*) as n from df_chat where player_id = :pid and at > :since",
            pid=player["id"], since=now - CHAT_WINDOW_MS,
        )  # fmt: skip
        if recent and int(recent["n"]) >= CHAT_BURST:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Slow down a little: too many messages.")
        tx.run(
            "insert into df_chat (code, player_id, name, text, at) values (:code, :pid, :name, :text, :now)",
            code=room["code"], pid=player["id"], name=player["name"], text=text, now=now,
        )  # fmt: skip
        tx.run(
            "delete from df_chat where code = :code and id < (select id from df_chat where code = :code"
            " order by id desc limit 1 offset :keep)",
            code=room["code"], keep=CHAT_KEEP - 1,
        )  # fmt: skip

    return _write(code, token, chat_after, now, change)


def leave(code: str, token: str | None, now: int) -> None:
    def run(tx: Tx) -> None:
        room = _live_room(tx, code, now, lock=True)
        player = _player(tx, room, token, now)
        tx.run("delete from df_players where id = :id", id=player["id"])
        rest = _players(tx, room["code"])
        if not rest:
            tx.run("delete from df_rooms where code = :code", code=room["code"])
            tx.run("delete from df_chat where code = :code", code=room["code"])
        elif room["host_id"] == player["id"]:
            tx.run("update df_rooms set host_id = :id where code = :code", id=rest[0]["id"], code=room["code"])

    transaction(run)

