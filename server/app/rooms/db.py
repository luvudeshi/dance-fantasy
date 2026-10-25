"""Where rooms live: Postgres when ``DATABASE_URL`` is set (Tiger Data on Vercel), else SQLite.

Vercel runs the API as many stateless function instances, so room state can never live in
process memory. Locally (and in tests) a SQLite file in the cache dir stands in. Both speak the
same SQL with ``:name`` parameters; ``transaction()`` hands out a ``Tx`` for one transaction.

Lock order, to stay deadlock-free on Postgres: a transaction locks its room row first
(``Tx.lock_room`` / ``update df_rooms``), then player and chat rows.

Per-beat judgements go to ``df_room_beats`` and outlive their room: they feed each song's
"hardest moments" heatmap. On Postgres with the timescaledb extension that table is a hypertable
on ``round_ms`` (the round's start, epoch ms) and ``df_beat_heat`` is a continuous aggregate of
score sums per (analysis_id, beat, day); without timescaledb the heatmap reads the table itself.
"""

from __future__ import annotations

import logging
import os
import queue
import sqlite3
import ssl
import threading
from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import certifi
import pg8000.dbapi
from fastapi import HTTPException, status

from app.config import get_settings

log = logging.getLogger(__name__)

pg8000.dbapi.paramstyle = "named"  # same ":name" placeholders as sqlite3; nothing else here uses pg8000

Row = dict[str, Any]

_SCHEMA = """
create table if not exists df_rooms (
  code text primary key,
  host_id text not null,
  routine text,
  start_at bigint,
  finished_at bigint,
  created_at bigint not null,
  active_at bigint not null
);
create index if not exists df_rooms_active_idx on df_rooms (active_at);
create table if not exists df_players (
  seq {serial_pk},
  id text not null unique,
  code text not null,
  token_hash text not null unique,
  name text not null,
  joined_at bigint not null,
  seen_at bigint not null,
  ready smallint not null default 0,
  score bigint not null default 0,
  combo integer not null default 0,
  max_combo integer not null default 0,
  accuracy double precision not null default 0,
  progress double precision not null default 0,
  finished smallint not null default 0
);
create index if not exists df_players_code_idx on df_players (code);
create table if not exists df_chat (
  id {serial_pk},
  code text not null,
  player_id text not null,
  name text not null,
  text text not null,
  at bigint not null
);
create index if not exists df_chat_code_idx on df_chat (code, id);
create table if not exists df_room_beats (
  code text not null,
  round_ms bigint not null,
  player_id text not null,
  analysis_id text not null,
  beat integer not null,
  score double precision not null,
  grade text not null,
  at bigint not null
);
create unique index if not exists df_room_beats_key on df_room_beats (code, round_ms, beat, player_id);
create index if not exists df_room_beats_song_idx on df_room_beats (analysis_id, beat);
"""

# Added to df_rooms after its first release, so existing tables get them on startup.
_ROOM_COLUMNS = (
    ("mode", "text not null default 'versus'"),
    ("sync_upto", "integer not null default -1"),  # crew sync is decided for every beat up to this one
    ("synced_beats", "integer not null default 0"),
    ("sync_streak", "integer not null default 0"),
    ("best_sync_streak", "integer not null default 0"),
    ("last_sync_beat", "integer"),
    ("sync_bonus", "bigint not null default 0"),
)

# Postgres with timescaledb only; if any of it fails the heatmap reads df_room_beats (_pg_timescale).
_TIMESCALE = (
    "create extension if not exists timescaledb",
    "select create_hypertable('df_room_beats', 'round_ms', chunk_time_interval => bigint '604800000',"
    " if_not_exists => true, migrate_data => true)",
    "create or replace function df_now_ms() returns bigint language sql stable as"
    " $$ select (extract(epoch from now()) * 1000)::bigint $$",
    "select set_integer_now_func('df_room_beats', 'df_now_ms', replace_if_exists => true)",
)
_HEAT_VIEW = (
    # "with no data": creating a continuous aggregate with data can't run inside a transaction.
    # materialized_only = false: reads include rows newer than the last refresh, so it's always current.
    "create materialized view df_beat_heat"
    " with (timescaledb.continuous, timescaledb.materialized_only = false) as"
    " select analysis_id, beat, time_bucket(bigint '86400000', round_ms) as bucket,"
    " sum(score) as total, count(*) as n from df_room_beats group by analysis_id, beat, bucket with no data",
    "select add_continuous_aggregate_policy('df_beat_heat', start_offset => bigint '34560000000',"
    " end_offset => bigint '60000', schedule_interval => interval '15 minutes', if_not_exists => true)",
)


class Tx:
    """One open transaction. ``one``/``all`` return rows as dicts; ``run`` returns the row count."""

    def __init__(self, cursor: Any, postgres: bool) -> None:
        self._cur = cursor
        self.postgres = postgres

    def run(self, sql: str, **params: Any) -> int:
        self._cur.execute(sql, params)
        return int(self._cur.rowcount)

    def all(self, sql: str, **params: Any) -> list[Row]:
        self._cur.execute(sql, params)
        cols = [d[0] for d in self._cur.description]
        return [dict(zip(cols, r, strict=True)) for r in self._cur.fetchall()]

    def one(self, sql: str, **params: Any) -> Row | None:
        rows = self.all(sql, **params)
        return rows[0] if rows else None

    def lock_room(self, code: str) -> Row | None:
        """The room row, locked until commit (SQLite: the whole DB already is, see ``_sqlite``)."""
        if self.postgres:
            return self.one("select * from df_rooms where code = :code for update", code=code)
        return self.one("select * from df_rooms where code = :code", code=code)


def _add_room_columns(tx: Tx, existing: set[str]) -> None:
    for name, decl in _ROOM_COLUMNS:
        if name not in existing:
            tx.run(f"alter table df_rooms add column {name} {decl}")  # constants from _ROOM_COLUMNS only


def heat_view_exists(tx: Tx) -> bool:
    """Whether the df_beat_heat continuous aggregate exists (Postgres with timescaledb)."""
    row = tx.one("select to_regclass('df_beat_heat') is not null as ok") if tx.postgres else None
    return bool(row and row["ok"])


# --- SQLite (local dev, tests) ----------------------------------------------------------------

_sqlite_ready: set[str] = set()
_sqlite_lock = threading.Lock()


def _sqlite[T](fn: Callable[[Tx], T]) -> T:
    path = get_settings().cache_dir / "rooms.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    # ponytail: "begin immediate" makes every transaction a writer, so they all run one at a time. Fine for one
    # machine; deployments use Postgres.
    con = sqlite3.connect(path, timeout=15, isolation_level=None)
    try:
        with _sqlite_lock:
            if str(path) not in _sqlite_ready:
                con.execute("pragma journal_mode=wal")
                con.executescript(_SCHEMA.format(serial_pk="integer primary key autoincrement"))
                tx = Tx(con.cursor(), postgres=False)
                _add_room_columns(tx, {r["name"] for r in tx.all("pragma table_info(df_rooms)")})
                _sqlite_ready.add(str(path))
        cur = con.cursor()
        cur.execute("begin immediate")
        try:
            result = fn(Tx(cur, postgres=False))
        except BaseException:
            cur.execute("rollback")
            raise
        cur.execute("commit")
        return result
    finally:
        con.close()


# --- Postgres (DATABASE_URL) ------------------------------------------------------------------

_PG_IDLE = 4  # connections kept open per instance between requests
_pools: dict[str, queue.LifoQueue[pg8000.dbapi.Connection]] = {}
_pg_ready: set[str] = set()
_pg_lock = threading.Lock()


def _pg_connect(url: str) -> pg8000.dbapi.Connection:
    u = urlparse(url)
    if u.scheme not in ("postgres", "postgresql"):
        raise ValueError("DATABASE_URL must be a postgres:// or postgresql:// URL")
    # TLS with certificate checks unless sslmode=disable (a local Postgres). Hosted Postgres such as Tiger Cloud presents a
    # publicly trusted certificate, so its usual "sslmode=require" URL verifies. "no-verify" (node-postgres' spelling)
    # is the explicit opt-out.
    sslmode = parse_qs(u.query).get("sslmode", ["require"])[0]
    ctx: ssl.SSLContext | None = None
    if sslmode != "disable":
        ctx = ssl.create_default_context(cafile=certifi.where())  # the function image's system CA path may not exist
        if sslmode == "no-verify":
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
    return pg8000.dbapi.connect(
        user=unquote(u.username or ""),
        password=unquote(u.password) if u.password else None,
        host=u.hostname or "localhost",
        port=u.port or 5432,
        database=unquote(u.path.lstrip("/")) or None,
        ssl_context=ctx,
        timeout=15,
        application_name="dance-fantasy-rooms",
    )


def _pg_bootstrap(con: pg8000.dbapi.Connection, url: str) -> None:
    with _pg_lock:
        if url in _pg_ready:
            return
        cur = con.cursor()
        cur.execute("select pg_advisory_xact_lock(7741)")  # two cold-starting instances must not race the DDL
        for stmt in _SCHEMA.format(serial_pk="bigserial primary key").split(";"):
            if stmt.strip():
                cur.execute(stmt)
        tx = Tx(cur, postgres=True)
        cols = tx.all(
            "select column_name from information_schema.columns"
            " where table_schema = current_schema() and table_name = 'df_rooms'"
        )
        _add_room_columns(tx, {r["column_name"] for r in cols})
        _pg_timescale(tx)
        con.commit()
        _pg_ready.add(url)
        log.info("rooms: postgres schema ready")


def _pg_timescale(tx: Tx) -> None:
    """Make df_room_beats a hypertable with the df_beat_heat aggregate, when timescaledb is available."""
    if not tx.one("select 1 as ok from pg_available_extensions where name = 'timescaledb'"):
        log.info("rooms: no timescaledb here; the heatmap reads df_room_beats")
        return
    tx.run("savepoint df_timescale")
    try:
        for stmt in _TIMESCALE:
            tx.run(stmt)
        if not heat_view_exists(tx):
            for stmt in _HEAT_VIEW:
                tx.run(stmt)
    except pg8000.dbapi.DatabaseError as exc:
        # The plain tables are already there; only the timescale extras are skipped.
        tx.run("rollback to savepoint df_timescale")
        log.warning("rooms: timescaledb setup failed, the heatmap reads df_room_beats: %s", exc)
        return
    tx.run("release savepoint df_timescale")
    log.info("rooms: df_room_beats is a hypertable feeding the df_beat_heat aggregate")


def _postgres[T](url: str, fn: Callable[[Tx], T]) -> T:
    pool = _pools.setdefault(url, queue.LifoQueue(maxsize=_PG_IDLE))
    for attempt in (1, 2):
        try:
            con = pool.get_nowait()
        except queue.Empty:
            con = _pg_connect(url)
        try:
            _pg_bootstrap(con, url)
            result = fn(Tx(con.cursor(), postgres=True))
            con.commit()
        except pg8000.dbapi.InterfaceError:
            # Usually a pooled connection the server closed while idle. Nothing committed: retry once fresh.
            _close(con)
            if attempt == 2:
                raise
            continue
        except BaseException:
            try:
                con.rollback()
            except Exception:  # noqa: BLE001 - the connection is unusable; drop it and re-raise the original
                _close(con)
                raise
            _release(pool, con)
            raise
        _release(pool, con)
        return result
    raise AssertionError("unreachable")


def _release(pool: queue.LifoQueue[pg8000.dbapi.Connection], con: pg8000.dbapi.Connection) -> None:
    try:
        pool.put_nowait(con)
    except queue.Full:
        _close(con)


def _close(con: pg8000.dbapi.Connection) -> None:
    try:
        con.close()
    except Exception as exc:  # noqa: BLE001 - closing a dead socket can fail; it's gone either way
        log.debug("rooms: closing a broken connection failed: %s", exc)


# --- entry point ------------------------------------------------------------------------------


def transaction[T](fn: Callable[[Tx], T]) -> T:
    """Run ``fn`` in one transaction (committed if it returns, rolled back if it raises)."""
    get_settings()  # loads the repo-root .env, which may hold DATABASE_URL
    url = os.environ.get("DATABASE_URL", "").strip()
    if url:
        return _postgres(url, fn)
    if os.environ.get("VERCEL"):
        # Function instances share nothing: SQLite in /tmp would split one room across instances.
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Multiplayer rooms need DATABASE_URL on this deployment."
        )
    return _sqlite(fn)
