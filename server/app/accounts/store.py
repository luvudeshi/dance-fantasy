"""Account rules on the rooms database (``app.rooms.db``: Postgres via DATABASE_URL, else SQLite).

Every visitor is an account: ``start_session`` makes a guest the first time, and claiming a
username + password only adds a way to log in from another browser. A browser's session is a
random token in an httpOnly cookie; only its sha256 is stored. Every function takes ``now`` (epoch
ms) and runs as one transaction that first resolves the session and stamps the account as seen.

Failures that must be remembered (wrong passwords, unknown friend codes) are *returned* as an
``HTTPException`` and raised after commit, because raising inside rolls the transaction back.
"""

from __future__ import annotations

import logging
import os
import secrets
import threading
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException, status

from app.accounts import security
from app.accounts.models import (
    COLORS,
    GUEST_AVATARS,
    Friend,
    History,
    Invite,
    Me,
    Partner,
    ProfilePatch,
    Round,
    RoundBody,
    Stats,
)
from app.config import get_settings
from app.rooms import db
from app.rooms import store as rooms
from app.rooms.db import Row, Tx

log = logging.getLogger(__name__)

SEC, MIN, DAY = 1000, 60_000, 86_400_000
SESSION_MS = 180 * DAY  # idle sessions expire; the cookie's max-age matches and slides on POST /api/session
ONLINE_MS = 60 * SEC
TOUCH_MS = 10 * SEC  # last-seen writes are skipped while the previous one is fresher than this
INVITE_TTL_MS = 10 * MIN
PARTNER_WINDOW_MS = 30 * DAY
MAX_FRIENDS = 200
HISTORY_PAGE = 20
# (attempts, window ms) per key. Guests and the per-IP login limit are generous: a venue shares one NAT address.
GUEST_LIMIT = (300, 60 * MIN)  # new guest accounts per IP-ish key
LOGIN_USER_LIMIT = (5, 15 * MIN)  # failed logins per username
LOGIN_IP_LIMIT = (50, 15 * MIN)  # failed logins per IP-ish key
FRIEND_FAIL_LIMIT = (10, 10 * MIN)  # unknown friend codes per account
INVITE_LIMIT = (20, 10 * MIN)  # invites sent per account
ROUND_LIMIT = (120, 60 * MIN)  # rounds recorded per account

_ADJECTIVES = ("Golden", "Velvet", "Moonlit", "Twirling", "Starry", "Merry", "Dapper", "Gilded")
_NOUNS = ("Pumpkin", "Slipper", "Frog", "Wolf", "Lantern", "Spindle", "Wand", "Crown")

_SCHEMA = """
create table if not exists df_accounts (
  id text primary key,
  name text not null,
  avatar text not null,
  color text not null,
  friend_code text not null unique,
  username text unique,
  pw_hash text,
  created_at bigint not null,
  seen_at bigint not null
);
create table if not exists df_sessions (
  token_hash text primary key,
  account_id text not null,
  created_at bigint not null,
  seen_at bigint not null
);
create index if not exists df_sessions_account_idx on df_sessions (account_id);
create table if not exists df_friends (
  account_id text not null,
  friend_id text not null,
  at bigint not null,
  primary key (account_id, friend_id)
);
create table if not exists df_invites (
  id {serial_pk},
  from_id text not null,
  to_id text not null,
  room_code text not null,
  at bigint not null,
  dismissed smallint not null default 0
);
create index if not exists df_invites_to_idx on df_invites (to_id, at);
create index if not exists df_invites_from_idx on df_invites (from_id, at);
create table if not exists df_room_members (
  room_key text not null,
  account_id text not null,
  room_code text not null,
  player_id text not null,
  at bigint not null,
  primary key (room_key, account_id)
);
create index if not exists df_room_members_account_idx on df_room_members (account_id, at);
create table if not exists df_hits (
  bucket text not null,
  at bigint not null
);
create index if not exists df_hits_bucket_idx on df_hits (bucket, at);
create index if not exists df_hits_at_idx on df_hits (at);
create table if not exists df_rounds (
  account_id text not null,
  at bigint not null,
  analysis_id text not null,
  song_title text not null,
  score bigint not null,
  accuracy double precision not null,
  max_combo integer not null,
  stars double precision not null,
  mode text not null
);
create index if not exists df_rounds_account_idx on df_rounds (account_id, at);
"""

_ready: set[str] = set()
_ready_lock = threading.Lock()


def _bootstrap(tx: Tx) -> None:
    if tx.postgres:
        tx.run("select pg_advisory_xact_lock(7742)")  # cold-starting instances must not race the DDL
    serial = "bigserial primary key" if tx.postgres else "integer primary key autoincrement"
    for stmt in _SCHEMA.format(serial_pk=serial).split(";"):
        if stmt.strip():
            tx.run(stmt)
    # Tiger Data (TimescaleDB): rounds are a time series, so make them a hypertable on ``at`` (epoch ms, 7-day
    # chunks). Plain Postgres and SQLite keep a plain table; every query below works on both.
    if tx.postgres and tx.one("select 1 as x from pg_extension where extname = 'timescaledb'"):
        tx.run(
            "select create_hypertable('df_rounds', 'at', chunk_time_interval => 604800000,"
            " if_not_exists => true, migrate_data => true)"
        )
        log.info("accounts: df_rounds is a hypertable")


def transaction[T](fn: Callable[[Tx], T | HTTPException]) -> T:
    """``app.rooms.db.transaction`` plus this module's tables; a returned HTTPException is raised after commit."""
    get_settings()  # loads the repo-root .env, which may hold DATABASE_URL
    key = os.environ.get("DATABASE_URL", "").strip() or str(get_settings().cache_dir)
    with _ready_lock:
        if key not in _ready:
            db.transaction(_bootstrap)
            _ready.add(key)
    result = db.transaction(fn)
    if isinstance(result, HTTPException):
        raise result
    return result


# --- helpers ------------------------------------------------------------------------------------


def _scalar(tx: Tx, sql: str, **params: Any) -> Any:
    row = tx.one(sql, **params)
    return next(iter(row.values())) if row else None


def _limited(tx: Tx, bucket: str, limit: tuple[int, int], now: int) -> bool:
    n, window = limit
    return int(_scalar(tx, "select count(*) from df_hits where bucket = :b and at > :since", b=bucket, since=now - window)) >= n


def _hit(tx: Tx, bucket: str, now: int) -> None:
    tx.run("delete from df_hits where at < :old", old=now - DAY)
    tx.run("insert into df_hits (bucket, at) values (:b, :now)", b=bucket, now=now)


def _lookup(tx: Tx, token: str | None, now: int) -> Row | None:
    """The session's account (plus ``session_hash``), stamped as seen; None for a missing/unknown/expired token."""
    if not token or len(token) > 100:
        return None
    me = tx.one(
        "select a.*, s.token_hash as session_hash, s.seen_at as session_seen"
        " from df_sessions s join df_accounts a on a.id = s.account_id where s.token_hash = :th",
        th=security.token_hash(token),
    )
    if me is None or me["session_seen"] < now - SESSION_MS:
        return None
    if me["seen_at"] < now - TOUCH_MS:
        tx.run("update df_accounts set seen_at = :now where id = :id", now=now, id=me["id"])
        me["seen_at"] = now
    if me["session_seen"] < now - TOUCH_MS:
        tx.run("update df_sessions set seen_at = :now where token_hash = :th", now=now, th=me["session_hash"])
    return me


def _authed[T](token: str | None, now: int, fn: Callable[[Tx, Row], T | HTTPException]) -> T:
    def run(tx: Tx) -> T | HTTPException:
        me = _lookup(tx, token, now)
        if me is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No session: call POST /api/session first.")
        return fn(tx, me)

    return transaction(run)


def _new_session(tx: Tx, account_id: str, now: int) -> str:
    token = security.new_token()
    tx.run(
        "insert into df_sessions (token_hash, account_id, created_at, seen_at) values (:th, :id, :now, :now)",
        th=security.token_hash(token), id=account_id, now=now,
    )  # fmt: skip
    return token


def _end_session(tx: Tx, token: str | None) -> None:
    if token:
        tx.run("delete from df_sessions where token_hash = :th", th=security.token_hash(token))


def _guest_session(tx: Tx, client: str, now: int) -> tuple[Me, str] | HTTPException:
    bucket = f"guest:{client}"
    if _limited(tx, bucket, GUEST_LIMIT, now):
        return HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many new guests from this network. Try later.")
    _hit(tx, bucket, now)
    for _ in range(20):
        account = {
            "id": secrets.token_urlsafe(9),
            "name": f"{secrets.choice(_ADJECTIVES)} {secrets.choice(_NOUNS)}",
            "avatar": secrets.choice(GUEST_AVATARS),
            "color": secrets.choice(COLORS),
            "friend_code": security.new_friend_code(),
            "username": None,
        }
        inserted = tx.run(
            "insert into df_accounts (id, name, avatar, color, friend_code, created_at, seen_at)"
            " values (:id, :name, :avatar, :color, :friend_code, :now, :now) on conflict do nothing",
            now=now, **{k: v for k, v in account.items() if k != "username"},
        )  # fmt: skip
        if inserted == 1:
            return _me(tx, account), _new_session(tx, str(account["id"]), now)
    raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Could not make a guest account. Try again.")


def _me(tx: Tx, a: Row) -> Me:
    agg = tx.one("select count(*) as n, max(score) as best from df_rounds where account_id = :id", id=a["id"]) or {}
    friends = _scalar(tx, "select count(*) from df_friends where account_id = :id", id=a["id"])
    return Me(
        id=a["id"], name=a["name"], avatar=a["avatar"], color=a["color"], friendCode=a["friend_code"],
        isGuest=a["username"] is None, username=a["username"],
        stats=Stats(rounds=int(agg.get("n") or 0), bestScore=int(agg.get("best") or 0), friends=int(friends)),
    )  # fmt: skip


def _online(seen_at: int, now: int) -> bool:
    return bool(now - seen_at < ONLINE_MS)


def _friends(tx: Tx, me_id: str, now: int) -> list[Friend]:
    rows = tx.all(
        "select a.id, a.name, a.avatar, a.color, a.seen_at,"
        " (select m.room_code from df_room_members m join df_players p on p.id = m.player_id"
        "   where m.account_id = a.id and p.seen_at > :since order by m.at desc limit 1) as in_room"
        " from df_friends f join df_accounts a on a.id = f.friend_id where f.account_id = :me",
        me=me_id, since=now - ONLINE_MS,
    )  # fmt: skip
    friends = [
        Friend(id=r["id"], name=r["name"], avatar=r["avatar"], color=r["color"], online=_online(r["seen_at"], now),
               inRoom=r["in_room"])  # fmt: skip
        for r in rows
    ]
    return sorted(friends, key=lambda f: (not f.online, f.name.casefold()))


def _are_friends(tx: Tx, a: str, b: str) -> bool:
    return tx.one("select 1 as x from df_friends where account_id = :a and friend_id = :b", a=a, b=b) is not None


# --- sessions and login -------------------------------------------------------------------------


def start_session(token: str | None, client: str, now: int) -> tuple[Me, str]:
    """The cookie's account, or a new guest; returns the (possibly new) session token to set."""

    def run(tx: Tx) -> tuple[Me, str] | HTTPException:
        me = _lookup(tx, token, now)
        if me is not None and token:
            return _me(tx, me), token
        return _guest_session(tx, client, now)

    return transaction(run)


def logout(token: str | None, client: str, now: int) -> tuple[Me, str]:
    def run(tx: Tx) -> tuple[Me, str] | HTTPException:
        _end_session(tx, token)
        return _guest_session(tx, client, now)

    return transaction(run)


def claim(token: str | None, username: str, password: str, now: int) -> tuple[Me, str]:
    pw_hash = security.hash_password(password)  # ~50 ms: outside the transaction

    def run(tx: Tx, me: Row) -> tuple[Me, str] | HTTPException:
        if me["username"] is not None:
            return HTTPException(status.HTTP_409_CONFLICT, "This account already has a username.")
        if tx.one("select 1 as x from df_accounts where username = :u", u=username):
            return HTTPException(status.HTTP_409_CONFLICT, "That username is taken.")
        tx.run("update df_accounts set username = :u, pw_hash = :pw where id = :id", u=username, pw=pw_hash, id=me["id"])
        _end_session(tx, token)  # new privileges, new session token
        me["username"] = username
        return _me(tx, me), _new_session(tx, me["id"], now)

    return _authed(token, now, run)


def login(token: str | None, username: str, password: str, client: str, now: int) -> tuple[Me, str]:
    def run(tx: Tx) -> tuple[Me, str] | HTTPException:
        user_bucket, ip_bucket = f"login:{username}", f"login-ip:{client}"
        if _limited(tx, user_bucket, LOGIN_USER_LIMIT, now) or _limited(tx, ip_bucket, LOGIN_IP_LIMIT, now):
            return HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many wrong passwords. Wait a few minutes.")
        account = tx.one("select * from df_accounts where username = :u", u=username)
        if not security.verify_password(password, account["pw_hash"] if account else None):
            _hit(tx, user_bucket, now)
            _hit(tx, ip_bucket, now)
            return HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong username or password.")
        assert account is not None
        _end_session(tx, token)
        tx.run("update df_accounts set seen_at = :now where id = :id", now=now, id=account["id"])
        return _me(tx, account), _new_session(tx, account["id"], now)

    return transaction(run)


# --- profile --------------------------------------------------------------------------------------


def get_me(token: str | None, now: int) -> Me:
    return _authed(token, now, lambda tx, me: _me(tx, me))


def heartbeat(token: str | None, now: int) -> None:
    _authed(token, now, lambda tx, me: None)


def update_profile(token: str | None, patch: ProfilePatch, now: int) -> Me:
    def run(tx: Tx, me: Row) -> Me:
        tx.run(
            "update df_accounts set name = coalesce(:name, name), avatar = coalesce(:avatar, avatar),"
            " color = coalesce(:color, color) where id = :id",
            name=patch.name, avatar=patch.avatar, color=patch.color, id=me["id"],
        )  # fmt: skip
        me.update({k: v for k, v in patch.model_dump().items() if v is not None})
        return _me(tx, me)

    return _authed(token, now, run)


# --- friends and invites --------------------------------------------------------------------------


def list_friends(token: str | None, now: int) -> list[Friend]:
    return _authed(token, now, lambda tx, me: _friends(tx, me["id"], now))


def add_friend(token: str | None, code: str, now: int) -> Friend:
    def run(tx: Tx, me: Row) -> Friend | HTTPException:
        bucket = f"friend:{me['id']}"
        if _limited(tx, bucket, FRIEND_FAIL_LIMIT, now):
            return HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many unknown codes. Wait a few minutes.")
        other = tx.one("select id from df_accounts where friend_code = :c", c=code)
        if other is None:
            _hit(tx, bucket, now)
            return HTTPException(status.HTTP_404_NOT_FOUND, "No dancer has that friend code.")
        if other["id"] == me["id"]:
            return HTTPException(status.HTTP_400_BAD_REQUEST, "That's your own friend code.")
        if _are_friends(tx, me["id"], other["id"]):
            return HTTPException(status.HTTP_409_CONFLICT, "You're already friends.")
        if int(_scalar(tx, "select count(*) from df_friends where account_id = :id", id=me["id"])) >= MAX_FRIENDS:
            return HTTPException(status.HTTP_409_CONFLICT, f"Friends list is full ({MAX_FRIENDS}).")
        tx.run(
            "insert into df_friends (account_id, friend_id, at) values (:a, :b, :now), (:b, :a, :now)"
            " on conflict do nothing",
            a=me["id"], b=other["id"], now=now,
        )  # fmt: skip
        return next(f for f in _friends(tx, me["id"], now) if f.id == other["id"])

    return _authed(token, now, run)


def remove_friend(token: str | None, friend_id: str, now: int) -> None:
    def run(tx: Tx, me: Row) -> None:
        removed = tx.run(
            "delete from df_friends where (account_id = :a and friend_id = :b) or (account_id = :b and friend_id = :a)",
            a=me["id"], b=friend_id,
        )  # fmt: skip
        if not removed:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That dancer isn't in your friends list.")

    _authed(token, now, run)


def invite(token: str | None, friend_id: str, room_code: str, now: int) -> None:
    def run(tx: Tx, me: Row) -> None:
        if not _are_friends(tx, me["id"], friend_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That dancer isn't in your friends list.")
        sent = _scalar(tx, "select count(*) from df_invites where from_id = :me and at > :since",
                       me=me["id"], since=now - INVITE_LIMIT[1])  # fmt: skip
        if int(sent) >= INVITE_LIMIT[0]:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many invites. Wait a few minutes.")
        room = rooms._live_room(tx, room_code, now, lock=False)  # 404 for unknown or expired codes
        tx.run("delete from df_invites where at < :old", old=now - DAY)
        params = {"me": me["id"], "to": friend_id, "code": room["code"], "now": now}
        renewed = tx.run(
            "update df_invites set at = :now where from_id = :me and to_id = :to and room_code = :code"
            " and dismissed = 0 and at > :since",
            since=now - INVITE_TTL_MS, **params,
        )  # fmt: skip
        if not renewed:
            tx.run("insert into df_invites (from_id, to_id, room_code, at) values (:me, :to, :code, :now)", **params)

    _authed(token, now, run)


def list_invites(token: str | None, now: int) -> list[Invite]:
    def run(tx: Tx, me: Row) -> list[Invite]:
        rows = tx.all(
            "select i.id, i.room_code, i.at, a.id as from_id, a.name, a.avatar, a.color"
            " from df_invites i join df_accounts a on a.id = i.from_id"
            " where i.to_id = :me and i.dismissed = 0 and i.at > :since order by i.at desc limit 20",
            me=me["id"], since=now - INVITE_TTL_MS,
        )  # fmt: skip
        return [
            Invite(id=int(r["id"]), fromId=r["from_id"], fromName=r["name"], fromAvatar=r["avatar"],
                   fromColor=r["color"], roomCode=r["room_code"], at=int(r["at"]))  # fmt: skip
            for r in rows
        ]

    return _authed(token, now, run)


def dismiss_invite(token: str | None, invite_id: int, now: int) -> None:
    def run(tx: Tx, me: Row) -> None:
        if not tx.run("update df_invites set dismissed = 1 where id = :id and to_id = :me", id=invite_id, me=me["id"]):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No such invite.")

    _authed(token, now, run)


# --- rooms played, partners ------------------------------------------------------------------------


def record_room(token: str | None, room_code: str, player_token: str, now: int) -> None:
    def run(tx: Tx, me: Row) -> None:
        room = rooms._live_room(tx, room_code, now, lock=False)  # 404 for unknown or expired codes
        player = rooms._player(tx, room, player_token, now, touch_room=False)  # 401 unless a player of this room
        tx.run(
            "insert into df_room_members (room_key, account_id, room_code, player_id, at)"
            " values (:key, :me, :code, :pid, :now)"
            " on conflict (room_key, account_id) do update set player_id = excluded.player_id, at = excluded.at",
            key=f"{room['code']}:{room['created_at']}",  # codes are reused once a room expires
            me=me["id"], code=room["code"], pid=player["id"], now=now,
        )  # fmt: skip

    _authed(token, now, run)


def list_partners(token: str | None, now: int) -> list[Partner]:
    def run(tx: Tx, me: Row) -> list[Partner]:
        rows = tx.all(
            "select a.id, a.name, a.avatar, a.color, a.friend_code, a.seen_at, max(o.at) as last_at"
            " from df_room_members mine"
            " join df_room_members o on o.room_key = mine.room_key and o.account_id <> mine.account_id"
            " join df_accounts a on a.id = o.account_id"
            " where mine.account_id = :me and mine.at > :since"
            " group by a.id, a.name, a.avatar, a.color, a.friend_code, a.seen_at"
            " order by last_at desc limit 20",
            me=me["id"], since=now - PARTNER_WINDOW_MS,
        )  # fmt: skip
        friends = {r["friend_id"] for r in tx.all("select friend_id from df_friends where account_id = :me", me=me["id"])}
        return [
            Partner(id=r["id"], name=r["name"], avatar=r["avatar"], color=r["color"], friendCode=r["friend_code"],
                    online=_online(r["seen_at"], now), isFriend=r["id"] in friends, lastPlayedAt=int(r["last_at"]))  # fmt: skip
            for r in rows
        ]

    return _authed(token, now, run)


# --- round history (a hypertable on Tiger Data) ----------------------------------------------------


def record_round(token: str | None, body: RoundBody, now: int) -> None:
    def run(tx: Tx, me: Row) -> None:
        recent = _scalar(tx, "select count(*) from df_rounds where account_id = :me and at > :since",
                         me=me["id"], since=now - ROUND_LIMIT[1])  # fmt: skip
        if int(recent) >= ROUND_LIMIT[0]:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many rounds recorded. Wait a little.")
        tx.run(
            "insert into df_rounds (account_id, at, analysis_id, song_title, score, accuracy, max_combo, stars, mode)"
            " values (:me, :now, :aid, :title, :score, :acc, :combo, :stars, :mode)",
            me=me["id"], now=now, aid=body.analysisId, title=body.songTitle, score=body.score, acc=body.accuracy,
            combo=body.maxCombo, stars=body.stars, mode=body.mode,
        )  # fmt: skip

    _authed(token, now, run)


def day_streak(days: set[int], today: int) -> int:
    """Consecutive days with a round, ending today (or yesterday: the streak lives until today is over)."""
    day = today if today in days else today - 1
    streak = 0
    while day in days:
        streak += 1
        day -= 1
    return streak


def history(token: str | None, tz_offset_min: int, now: int) -> History:
    """``tz_offset_min`` is the browser's ``Date.getTimezoneOffset()`` (UTC minus local, in minutes)."""
    off = tz_offset_min * MIN

    def run(tx: Tx, me: Row) -> History:
        rows = tx.all("select * from df_rounds where account_id = :me order by at desc limit :n", me=me["id"], n=HISTORY_PAGE)
        agg = tx.one(
            "select count(*) as n, max(score) as best, avg(accuracy) as acc from df_rounds where account_id = :me",
            me=me["id"],
        ) or {}  # fmt: skip
        days = tx.all(
            "select distinct (at - :off) / 86400000 as d from df_rounds where account_id = :me order by d desc limit 400",
            off=off, me=me["id"],
        )  # fmt: skip
        return History(
            rounds=[
                Round(analysisId=r["analysis_id"], songTitle=r["song_title"], score=int(r["score"]),
                      accuracy=float(r["accuracy"]), maxCombo=int(r["max_combo"]), stars=float(r["stars"]),
                      mode=r["mode"], at=int(r["at"]))  # fmt: skip
                for r in rows
            ],
            totalRounds=int(agg.get("n") or 0),
            bestScore=int(agg.get("best") or 0),
            avgAccuracy=round(float(agg.get("acc") or 0), 2),
            dayStreak=day_streak({int(d["d"]) for d in days}, (now - off) // DAY),
        )

    return _authed(token, now, run)
