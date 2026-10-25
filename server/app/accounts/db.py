"""Account tables on the rooms database (``app.rooms.db``: Postgres via DATABASE_URL, else SQLite).

``transaction`` creates them on first use per database, then runs ``fn`` like ``app.rooms.db.transaction``.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable

from fastapi import HTTPException

from app.config import get_settings
from app.rooms import db
from app.rooms.db import Tx

log = logging.getLogger(__name__)

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
create table if not exists df_badges (
  account_id text not null,
  badge_id text not null,
  earned_at bigint not null,
  primary key (account_id, badge_id)
);
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
