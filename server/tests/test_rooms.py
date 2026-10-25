"""Multiplayer rooms against a real database: SQLite always, plus Postgres when DATABASE_URL is set.

Point DATABASE_URL at a scratch database: tests create rooms (random codes) and the expiry test
sweeps rooms idle for over 3 hours, like production does. Store-level tests pass explicit times;
API tests use the real clock and fast-forward by moving ``start_at`` back in the database.
"""

from __future__ import annotations

import json
import os
import ssl
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api import rooms as rooms_api
from app.config import get_settings
from app.main import app
from app.rooms import store
from app.rooms.db import Tx, ssl_context_for, transaction
from app.rooms.models import RoutineChoice, ScoreBody

BACKENDS = ["sqlite"] + (["postgres"] if os.environ.get("DATABASE_URL") else [])
ROUTINE = {
    "routineId": "0123456789abcdef",
    "analysisId": "ab" * 32,
    "title": "Vibe Ace",
    "difficulty": "normal",
    "mode": "standing",
}
SCORE = {"score": 1200, "combo": 4, "maxCombo": 9, "accuracy": 81.5, "progress": 0.4, "finished": False}
MIN = 60_000


def write_routine(routine_id: str, analysis_id: str) -> None:
    """A generated routine on disk (the routine store), so rooms accept it for that song."""
    path = get_settings().cache_dir / "routines" / f"{routine_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"meta": {"routineId": routine_id, "analysisId": analysis_id}}))


@pytest.fixture(params=BACKENDS)
def backend(request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))  # SQLite file lands in tmp_path/cache
    if request.param == "sqlite":
        monkeypatch.delenv("DATABASE_URL", raising=False)
    get_settings.cache_clear()
    rooms_api._misses.clear()
    write_routine(ROUTINE["routineId"], ROUTINE["analysisId"])
    yield str(request.param)
    get_settings.cache_clear()


@pytest.fixture
def client(backend: str) -> TestClient:
    return TestClient(app)


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def auth(token: str) -> dict[str, str]:
    return {"X-Player-Token": token}


def rewind_start(code: str, ms: int) -> None:
    """Fast-forward a room's clock by moving its start time into the past."""

    def run(tx: Tx) -> None:
        tx.run("update df_rooms set start_at = start_at - :ms where code = :code", ms=ms, code=code)

    transaction(run)


def test_full_flow(client: TestClient) -> None:
    r = client.post("/api/rooms", json={"name": "  Ana \n Lopez "})
    assert r.status_code == 200, r.text
    host = r.json()
    code = host["code"]
    assert len(code) == 4 and code.isupper() and not set(code) & set("ILO")
    assert len(host["token"]) >= 30

    guest = client.post(f"/api/rooms/{code.lower()}/join", json={"name": "ana lopez"}).json()
    third = client.post(f"/api/rooms/{code}/join", json={"name": "Zoë"}).json()

    # Without a seat token only the public summary: no players, no chat.
    assert client.get(f"/api/rooms/{code}").json() == {"code": code, "state": "lobby", "playerCount": 3, "mode": "versus"}
    room = client.get(f"/api/rooms/{code}", headers=auth(third["token"])).json()
    assert room["state"] == "lobby" and room["startAt"] is None and room["routine"] is None
    assert room["hostId"] == host["playerId"]
    assert [p["name"] for p in room["players"]] == ["Ana Lopez", "ana lopez 2", "Zoë"]
    assert [p["isHost"] for p in room["players"]] == [True, False, False]
    assert all(p["connected"] and not p["ready"] and p["score"] == 0 for p in room["players"])
    assert abs(room["serverNow"] - now_ms()) < 2000

    r = client.post(f"/api/rooms/{code}/routine", json=ROUTINE, headers=auth(host["token"]))
    assert r.status_code == 200 and r.json()["routine"] == ROUTINE
    r = client.post(f"/api/rooms/{code}/ready", json={"ready": True}, headers=auth(guest["token"]))
    assert [p["ready"] for p in r.json()["players"]] == [False, True, False]

    # Synced start: everyone gets the same absolute start time, 5 s out.
    r = client.post(f"/api/rooms/{code}/start", headers=auth(host["token"]))
    started = r.json()
    assert started["state"] == "countdown"
    assert started["startAt"] - started["serverNow"] == store.COUNTDOWN_MS
    polled = client.get(f"/api/rooms/{code}", headers=auth(guest["token"])).json()
    assert polled["startAt"] == started["startAt"] and polled["state"] == "countdown"
    assert not any(p["ready"] for p in polled["players"])  # reset by start

    # Scores sent before the music starts are ignored.
    r = client.post(f"/api/rooms/{code}/score", json=SCORE, headers=auth(guest["token"]))
    assert r.status_code == 200 and r.json()["players"][1]["score"] == 0
    assert client.post(f"/api/rooms/{code}/start", headers=auth(host["token"])).status_code == 409
    assert client.post(f"/api/rooms/{code}/routine", json=ROUTINE, headers=auth(host["token"])).status_code == 409

    rewind_start(code, store.COUNTDOWN_MS)
    r = client.post(f"/api/rooms/{code}/score", json=SCORE, headers=auth(guest["token"]))
    view = r.json()
    assert view["state"] == "playing"
    me = view["players"][1]
    assert (me["score"], me["combo"], me["maxCombo"], me["accuracy"], me["progress"], me["finished"]) == (
        1200, 4, 9, 81.5, 0.4, False,
    )  # fmt: skip

    for player, score in ((host, 3000), (guest, 2500), (third, 900)):
        body = {**SCORE, "score": score, "progress": 1.0, "finished": True}
        view = client.post(f"/api/rooms/{code}/score", json=body, headers=auth(player["token"])).json()
    assert view["state"] == "finished"
    assert [p["score"] for p in view["players"]] == [3000, 2500, 900]
    # Finished sticks: a late packet changes nothing.
    late = client.post(f"/api/rooms/{code}/score", json={**SCORE, "score": 99_999}, headers=auth(third["token"])).json()
    assert late["state"] == "finished" and late["players"][2]["score"] == 900

    # Chat: polling with the last id seen returns only newer messages.
    r = client.post(f"/api/rooms/{code}/chat", json={"text": "  good \n game! 🎉 "}, headers=auth(third["token"]))
    assert r.status_code == 200
    first = client.get(f"/api/rooms/{code}", headers=auth(third["token"])).json()["chat"]
    assert [(m["name"], m["text"], m["playerId"]) for m in first] == [("Zoë", "good game! 🎉", third["playerId"])]
    client.post(f"/api/rooms/{code}/chat", json={"text": "rematch?"}, headers=auth(host["token"]))
    newer = client.get(f"/api/rooms/{code}", params={"chatAfter": first[0]["id"]}, headers=auth(third["token"])).json()[
        "chat"
    ]
    assert [m["text"] for m in newer] == ["rematch?"]

    # Picking a routine after the song resets the room to the lobby.
    view = client.post(
        f"/api/rooms/{code}/routine", json={**ROUTINE, "difficulty": "hard"}, headers=auth(host["token"])
    ).json()
    assert view["state"] == "lobby" and view["startAt"] is None and view["routine"]["difficulty"] == "hard"
    assert all(p["score"] == 0 and not p["finished"] for p in view["players"])


def test_auth_and_unknown_rooms(client: TestClient) -> None:
    host = client.post("/api/rooms", json={"name": "Host"}).json()
    code = host["code"]
    guest = client.post(f"/api/rooms/{code}/join", json={"name": "Guest"}).json()
    other = client.post("/api/rooms", json={"name": "Elsewhere"}).json()

    writes = [
        ("routine", ROUTINE), ("ready", {"ready": True}), ("start", None), ("score", SCORE),
        ("chat", {"text": "hi"}), ("dancing", {"dancing": False}), ("leave", None),
    ]  # fmt: skip
    for path, body in writes:
        url = f"/api/rooms/{code}/{path}"
        assert client.post(url, json=body).status_code == 404, path
        assert client.post(url, json=body, headers=auth("not-a-token")).status_code == 404, path
        assert client.post(url, json=body, headers=auth(other["token"])).status_code == 404, path

    assert client.post(f"/api/rooms/{code}/routine", json=ROUTINE, headers=auth(guest["token"])).status_code == 403
    assert client.post(f"/api/rooms/{code}/start", headers=auth(guest["token"])).status_code == 403
    assert client.post(f"/api/rooms/{code}/start", headers=auth(host["token"])).status_code == 409  # no routine yet

    assert client.get(f"/api/rooms/{code}", headers=auth("stale")).status_code == 404
    assert client.get(f"/api/rooms/{code}", headers=auth(guest["token"])).status_code == 200
    taken = {code, other["code"]}
    missing = next(c for c in ("BCDF", "GHJK", "MNPQ") if c not in taken)
    rooms_api._misses.clear()  # the token misses above counted toward the throttle too
    for bad in (missing, "AB", "ABCDE", "IIII", "12AB"):
        assert client.get(f"/api/rooms/{bad}").status_code == 404, bad
        assert client.post(f"/api/rooms/{bad}/join", json={"name": "x"}).status_code == 404, bad


def test_token_misses_are_throttled_but_seated_players_keep_playing(client: TestClient) -> None:
    host = client.post("/api/rooms", json={"name": "Host"}).json()
    code = host["code"]
    for _ in range(rooms_api.LOOKUP_MISSES):  # a guesser probing with fake tokens: 404 like an unknown room
        assert client.post(f"/api/rooms/{code}/chat", json={"text": "x"}, headers=auth("fake")).status_code == 404
    assert client.post(f"/api/rooms/{code}/chat", json={"text": "x"}, headers=auth("fake")).status_code == 429
    assert client.get(f"/api/rooms/{code}").status_code == 429  # token-less lookups are gated
    assert client.get(f"/api/rooms/{code}", headers=auth(host["token"])).status_code == 200  # the seat still works
    assert client.post(f"/api/rooms/{code}/chat", json={"text": "hi"}, headers=auth(host["token"])).status_code == 200


def test_room_code_guessing_is_throttled(client: TestClient) -> None:
    host = client.post("/api/rooms", json={"name": "Host"}).json()
    missing = next(c for c in ("BCDF", "GHJK", "MNPQ") if c != host["code"])
    for i in range(rooms_api.LOOKUP_MISSES):
        url = f"/api/rooms/{missing}" + ("/join" if i % 2 else "")
        r = client.post(url, json={"name": "x"}) if i % 2 else client.get(url)
        assert r.status_code == 404
    # Out of misses: every lookup from this client waits, hits included; seated polls too.
    r = client.get(f"/api/rooms/{host['code']}")
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1
    assert client.post(f"/api/rooms/{host['code']}/join", json={"name": "x"}).status_code == 429
    rooms_api._misses.clear()  # the window passed
    assert client.get(f"/api/rooms/{host['code']}").json()["playerCount"] == 1


def test_routines_must_exist_for_their_song(client: TestClient) -> None:
    host = client.post("/api/rooms", json={"name": "Host"}).json()
    url, h = f"/api/rooms/{host['code']}/routine", auth(host["token"])
    assert client.post(url, json={**ROUTINE, "routineId": "fedcba9876543210"}, headers=h).status_code == 404
    assert client.post(url, json={**ROUTINE, "analysisId": "cd" * 32}, headers=h).status_code == 404  # another song
    assert client.post(url, json=ROUTINE, headers=h).status_code == 200


def test_validation(client: TestClient) -> None:
    for name in ("", "   ", "x" * 25, "bad\x00name", 7):
        assert client.post("/api/rooms", json={"name": name}).status_code == 400, name
    assert client.post("/api/rooms", json={"name": "ok", "extra": 1}).status_code == 400
    assert client.post("/api/rooms", json={"name": "x" * 24}).status_code == 200

    host = client.post("/api/rooms", json={"name": "Host"}).json()
    code, h = host["code"], auth(host["token"])
    bad_routines = [
        {**ROUTINE, "routineId": "XYZ"}, {**ROUTINE, "analysisId": "ab"}, {**ROUTINE, "difficulty": "insane"},
        {**ROUTINE, "mode": "lying"}, {**ROUTINE, "title": ""}, {**ROUTINE, "seed": 3},
    ]  # fmt: skip
    for body in bad_routines:
        assert client.post(f"/api/rooms/{code}/routine", json=body, headers=h).status_code == 400, body
    bad_scores = [
        {**SCORE, "score": -1}, {**SCORE, "accuracy": 100.5}, {**SCORE, "progress": 1.01}, {**SCORE, "combo": 1.5},
        {k: v for k, v in SCORE.items() if k != "finished"},
    ]  # fmt: skip
    for body in bad_scores:
        assert client.post(f"/api/rooms/{code}/score", json=body, headers=h).status_code == 400, body
    for text in ("", " \n ", "x" * 201):
        assert client.post(f"/api/rooms/{code}/chat", json={"text": text}, headers=h).status_code == 400
    assert client.post(f"/api/rooms/{code}/chat", json={"text": "x" * 200}, headers=h).status_code == 200
    assert client.get(f"/api/rooms/{code}", params={"chatAfter": -1}, headers=h).status_code == 400


def test_room_limits(client: TestClient) -> None:
    host = client.post("/api/rooms", json={"name": "Dancer"}).json()
    code = host["code"]
    names = [
        client.post(f"/api/rooms/{code}/join", json={"name": "dancer"}).json() for _ in range(store.MAX_PLAYERS - 1)
    ]
    assert all("token" in n for n in names)
    r = client.post(f"/api/rooms/{code}/join", json={"name": "Late"})
    assert r.status_code == 409
    room = client.get(f"/api/rooms/{code}", headers=auth(host["token"])).json()
    assert [p["name"] for p in room["players"]] == ["Dancer"] + [f"dancer {i}" for i in range(2, 9)]

    # Unique names stay within 24 characters.
    long = client.post("/api/rooms", json={"name": "y" * 24}).json()
    twin = client.post(f"/api/rooms/{long['code']}/join", json={"name": "Y" * 24}).json()
    names_long = [p["name"] for p in client.get(f"/api/rooms/{long['code']}", headers=auth(long["token"])).json()["players"]]
    assert twin["playerId"] and names_long == ["y" * 24, "Y" * 22 + " 2"]

    # Chat rate limit: a burst of 5, then 429.
    h = auth(host["token"])
    assert [client.post(f"/api/rooms/{code}/chat", json={"text": f"m{i}"}, headers=h).status_code for i in range(6)] == [
        200, 200, 200, 200, 200, 429,
    ]  # fmt: skip
    assert (
        client.post(f"/api/rooms/{code}/chat", json={"text": "other"}, headers=auth(names[0]["token"])).status_code
        == 200
    )


def test_leave_moves_host_and_empty_rooms_close(client: TestClient) -> None:
    host = client.post("/api/rooms", json={"name": "A"}).json()
    code = host["code"]
    b = client.post(f"/api/rooms/{code}/join", json={"name": "B"}).json()
    c = client.post(f"/api/rooms/{code}/join", json={"name": "C"}).json()
    assert client.post(f"/api/rooms/{code}/leave", headers=auth(host["token"])).json() == {"ok": True}
    room = client.get(f"/api/rooms/{code}", headers=auth(b["token"])).json()
    assert room["hostId"] == b["playerId"] and [p["name"] for p in room["players"]] == ["B", "C"]
    assert client.get(f"/api/rooms/{code}", headers=auth(host["token"])).status_code == 404
    client.post(f"/api/rooms/{code}/leave", headers=auth(c["token"]))
    client.post(f"/api/rooms/{code}/leave", headers=auth(b["token"]))
    assert client.get(f"/api/rooms/{code}").status_code == 404


def test_synced_start_timing(backend: str) -> None:
    t = now_ms()
    host = store.create_room("Host", t)
    code = host.code
    guest = store.join_room(code, "Guest", t)
    store.set_routine(code, host.token, RoutineChoice.model_validate(ROUTINE), None, t)
    view = store.start(code, host.token, None, t + 1000)
    start_at = t + 1000 + store.COUNTDOWN_MS
    assert view.startAt == start_at and view.state == "countdown"
    assert store.get_room(code, None, None, start_at - 1).state == "countdown"
    assert store.get_room(code, None, None, start_at).state == "playing"

    # Connected = seen in the last 10 s. Both poll at +1 s; then only the host keeps polling.
    store.get_room(code, host.token, None, start_at + 1_000)
    store.get_room(code, guest.token, None, start_at + 1_000)
    store.get_room(code, host.token, None, start_at + 9_000)
    late = store.get_room(code, None, None, start_at + 9_000)
    assert [p.connected for p in late.players] == [True, True]
    gone = store.get_room(code, host.token, None, start_at + 12_000)
    assert [p.connected for p in gone.players] == [True, False]

    # Every *connected* player finished -> finished, and it sticks when the straggler returns.
    done = ScoreBody.model_validate({**SCORE, "progress": 1.0, "finished": True})
    assert store.post_score(code, host.token, done, None, start_at + 13_000).state == "finished"
    back = store.get_room(code, guest.token, None, start_at + 14_000)
    assert back.state == "finished" and [p.connected for p in back.players] == [True, True]

    # Rematch: start again from finished resets scores; the 10-minute cap ends a song nobody finishes.
    again = store.start(code, host.token, None, start_at + 20_000)
    assert again.state == "countdown" and all(p.score == 0 and not p.finished for p in again.players)
    t2 = again.startAt
    assert t2 is not None
    for offset in (0, 5 * MIN, store.MAX_PLAY_MS - 5_000):  # both keep polling through the song
        store.get_room(code, host.token, None, t2 + offset)
        store.get_room(code, guest.token, None, t2 + offset)
    assert store.get_room(code, None, None, t2 + store.MAX_PLAY_MS - 1).state == "playing"
    assert store.get_room(code, host.token, None, t2 + store.MAX_PLAY_MS).state == "finished"


def test_mid_song_joiner_sits_out(backend: str) -> None:
    t = now_ms()
    host = store.create_room("Host", t)
    store.set_routine(host.code, host.token, RoutineChoice.model_validate(ROUTINE), None, t)
    start_at = store.start(host.code, host.token, None, t).startAt
    assert start_at is not None
    early = store.join_room(host.code, "Early", start_at - 100)  # during the countdown: dances
    late = store.join_room(host.code, "Late", start_at + 100)  # mid-song: waits for the next one
    view = store.get_room(host.code, late.token, None, start_at + 200)
    assert view.state == "playing"
    assert {p.name: p.finished for p in view.players} == {"Host": False, "Early": False, "Late": True}
    assert early.playerId != late.playerId
    # A finished flag never goes back to false.
    store.post_score(host.code, late.token, ScoreBody.model_validate(SCORE), None, start_at + 300)
    assert store.get_room(host.code, None, None, start_at + 300).players[2].finished


def test_a_watching_host_never_holds_up_the_round(backend: str) -> None:
    t = now_ms()
    host = store.create_room("Host", t)
    code = host.code
    guest = store.join_room(code, "Guest", t)
    store.set_routine(code, host.token, RoutineChoice.model_validate(ROUTINE), None, t)
    assert all(p.dancing for p in store.get_room(code, None, None, t).players)  # everyone dances by default
    view = store.set_dancing(code, host.token, False, None, t)
    assert [(p.name, p.dancing) for p in view.players] == [("Host", False), ("Guest", True)]
    start_at = store.start(code, host.token, None, t).startAt  # a watching host still runs the room
    assert start_at is not None
    for at in (t + 1, start_at + 1):  # countdown, playing: switch between songs only
        with pytest.raises(HTTPException) as busy:
            store.set_dancing(code, host.token, True, None, at)
        assert busy.value.status_code == 409

    # The host's screen keeps polling (connected) and never finishes: the round ends when the guest does.
    done = ScoreBody.model_validate({**SCORE, "progress": 1.0, "finished": True})
    assert store.get_room(code, host.token, None, start_at + 1_000).state == "playing"
    assert store.post_score(code, host.token, done, None, start_at + 1_500).state == "playing"  # a watcher's: ignored
    view = store.post_score(code, guest.token, done, None, start_at + 2_000)
    assert view.state == "finished"
    watcher = view.players[0]
    assert watcher.connected and not watcher.dancing and not watcher.finished and watcher.score == 0
    assert view.leaderId == guest.playerId

    # Dancing again from the next song on: then the round waits for the host too.
    assert store.set_dancing(code, host.token, True, None, start_at + 3_000).players[0].dancing
    again = store.rematch(code, host.token, None, start_at + 3_000).startAt
    assert again is not None
    store.get_room(code, host.token, None, again + 1_000)
    assert store.post_score(code, guest.token, done, None, again + 1_000).state == "playing"
    assert store.post_score(code, host.token, done, None, again + 2_000).state == "finished"


def test_a_round_needs_a_dancer(backend: str) -> None:
    t = now_ms()
    host = store.create_room("Host", t)
    code = host.code
    store.set_routine(code, host.token, RoutineChoice.model_validate(ROUTINE), None, t)
    store.set_dancing(code, host.token, False, None, t)
    with pytest.raises(HTTPException) as nobody:  # a watching host alone: the song would end before it began
        store.start(code, host.token, None, t)
    assert nobody.value.status_code == 409 and store.get_room(code, host.token, None, t).state == "lobby"
    guest = store.join_room(code, "Guest", t)
    start_at = store.start(code, host.token, None, t).startAt
    assert start_at is not None
    done = ScoreBody.model_validate({**SCORE, "progress": 1.0, "finished": True})
    assert store.post_score(code, guest.token, done, None, start_at + 1_000).state == "finished"
    store.leave(code, guest.token, start_at + 2_000)
    with pytest.raises(HTTPException) as alone:  # and no rematch once the last dancer has gone
        store.rematch(code, host.token, None, start_at + 2_000)
    assert alone.value.status_code == 409


def test_dancing_over_http(client: TestClient) -> None:
    host = client.post("/api/rooms", json={"name": "Host"}).json()
    code = host["code"]
    guest = client.post(f"/api/rooms/{code}/join", json={"name": "Guest"}).json()
    url, h = f"/api/rooms/{code}/dancing", auth(host["token"])
    assert client.post(url, json={"dancing": "maybe"}, headers=h).status_code == 400
    assert client.post(url, json={"dancing": False, "extra": 1}, headers=h).status_code == 400
    assert client.post(url, json={}, headers=h).status_code == 400
    r = client.post(url, json={"dancing": False}, headers=h)
    assert r.status_code == 200 and [p["dancing"] for p in r.json()["players"]] == [False, True]
    room = client.get(f"/api/rooms/{code}", headers=auth(guest["token"])).json()
    assert [p["dancing"] for p in room["players"]] == [False, True]


def test_rooms_expire_after_3_hours_idle(backend: str) -> None:
    t = now_ms()
    ttl = store.ROOM_TTL_MS
    old = store.create_room("Old", t - ttl - 5_000)  # idle for over 3 h already
    kept = store.create_room("Kept", t - ttl - 60_000)  # created long ago...
    store.get_room(kept.code, kept.token, None, t - ttl + 60_000)  # ...but a player polled since: still live
    with pytest.raises(HTTPException) as missing:
        store.get_room(old.code, None, None, t)
    assert missing.value.status_code == 404
    assert store.get_room(kept.code, None, None, t).code == kept.code

    sweeper = store.create_room("Sweeper", t)  # creating a room deletes expired ones, rows and all
    assert store.get_room(kept.code, None, None, t).code == kept.code

    def leftovers(tx: Tx) -> int:
        row = tx.one("select count(*) as n from df_players where code = :code", code=old.code)
        return int(row["n"]) if row else -1

    assert transaction(leftovers) == 0
    if sweeper.code != old.code:  # codes are random; a freed code may be handed out again
        with pytest.raises(HTTPException) as unknown:
            store.join_room(old.code, "Ghost", t)
        assert unknown.value.status_code == 404


def test_chat_pages_and_trim(backend: str) -> None:
    t = now_ms()
    room = store.create_room("Talker", t)
    friend = store.join_room(room.code, "Friend", t)
    total = store.CHAT_KEEP + 10
    for i in range(total):  # two players alternate, spaced to stay under the rate limit
        token = room.token if i % 2 == 0 else friend.token
        store.post_chat(room.code, token, f"msg {i}", None, t + i * 1_000)
    latest = store.get_room(room.code, None, None, t + total * 1_000).chat
    assert [m.text for m in latest] == [f"msg {i}" for i in range(total - store.CHAT_PAGE, total)]
    first_page = store.get_room(room.code, None, 0, t + total * 1_000).chat
    assert [m.text for m in first_page] == [f"msg {i}" for i in range(10, 10 + store.CHAT_PAGE)]  # oldest 10 trimmed
    rest = store.get_room(room.code, None, first_page[-1].id, t + total * 1_000).chat
    assert rest[0].text == f"msg {10 + store.CHAT_PAGE}" and len(rest) == store.CHAT_PAGE


def test_concurrent_joins_never_overfill(backend: str) -> None:
    t = now_ms()
    host = store.create_room("Host", t)

    def join(i: int) -> int:
        try:
            store.join_room(host.code, "Racer", t + i)
        except HTTPException as exc:
            return exc.status_code
        return 200

    with ThreadPoolExecutor(max_workers=12) as pool:
        codes = sorted(pool.map(join, range(12)))
    assert codes == [200] * (store.MAX_PLAYERS - 1) + [409] * (12 - store.MAX_PLAYERS + 1)
    names = [p.name for p in store.get_room(host.code, None, None, t + 100).players]
    assert len(names) == store.MAX_PLAYERS and len(set(names)) == store.MAX_PLAYERS


def test_vercel_without_database_url_is_503(client: TestClient, backend: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    get_settings.cache_clear()
    r = client.post("/api/rooms", json={"name": "Nobody"})
    assert r.status_code == 503 and "DATABASE_URL" in r.json()["detail"]


def test_postgres_tls_verifies_unless_opted_out() -> None:
    """sslmode=require (Tiger's URL) and no sslmode verify the certificate and host; only no-verify skips it."""
    for url in ("postgres://u:p@db.example.com:5432/x?sslmode=require", "postgres://u:p@db.example.com/x"):
        ctx = ssl_context_for(url)
        assert ctx is not None and ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname
    off = ssl_context_for("postgres://u:p@db.example.com/x?sslmode=no-verify")
    assert off is not None and off.verify_mode == ssl.CERT_NONE and not off.check_hostname
    assert ssl_context_for("postgres://u:p@localhost/x?sslmode=disable") is None
