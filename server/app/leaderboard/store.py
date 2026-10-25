"""Hall of Fame queries over ``df_rounds`` + ``df_accounts`` (read-only; the accounts tables and database).

A song's board keeps each account's best round for that song (ties go to whoever danced it first). The
top-dancers board sums every round. Rounds outside the sane range (score 0..1,000,000, accuracy 0..100) are
ignored everywhere. Time scopes are UTC days: ``today`` since midnight UTC, ``week`` the last 7 UTC days
(today included), so they line up with the daily continuous aggregate on Tiger Data.
"""

from __future__ import annotations

import logging
import os
from typing import Literal

import pg8000.dbapi
from fastapi import HTTPException, status
from pydantic import BaseModel

from app.accounts.db import transaction
from app.accounts.store import DAY, _lookup
from app.rooms.db import Row, Tx

log = logging.getLogger(__name__)

SongScope = Literal["all", "today", "week", "friends"]
TopScope = Literal["all", "week"]
MAX_SCORE = 1_000_000
_SANE = f"score between 0 and {MAX_SCORE} and accuracy between 0 and 100"
TOP_SONGS = 30

# Tiger Data (TimescaleDB): daily per-account totals over the df_rounds hypertable. materialized_only = false
# keeps reads current between refreshes. If any step fails, the top board reads df_rounds itself.
_DAILY_VIEW = (
    "create or replace function df_now_ms() returns bigint language sql stable as"
    " $$ select (extract(epoch from now()) * 1000)::bigint $$",
    "select set_integer_now_func('df_rounds', 'df_now_ms', replace_if_exists => true)",
    "create materialized view df_round_daily"
    " with (timescaledb.continuous, timescaledb.materialized_only = false) as"
    " select account_id, time_bucket(bigint '86400000', at) as day, sum(score) as total, count(*) as n,"
    f" max(max_combo) as best_combo, min(at) as first_at from df_rounds where {_SANE}"
    " group by account_id, day with no data",
    "select add_continuous_aggregate_policy('df_round_daily', start_offset => bigint '34560000000',"
    " end_offset => bigint '60000', schedule_interval => interval '15 minutes', if_not_exists => true)",
)
_daily: dict[str, bool] = {}  # DATABASE_URL -> whether df_round_daily is there


class BoardEntry(BaseModel):
    rank: int
    accountId: str
    name: str
    avatar: str
    color: str
    score: int
    accuracy: float
    maxCombo: int
    stars: float
    at: int
    isYou: bool


class SongRef(BaseModel):
    analysisId: str
    title: str | None  # library title, else the server's cached analysis title; null when the server has neither


class YourRank(BaseModel):
    rank: int
    score: int


class SongBoard(BaseModel):
    scope: SongScope
    song: SongRef
    entries: list[BoardEntry]
    you: YourRank | None


class TopEntry(BaseModel):
    rank: int
    accountId: str
    name: str
    avatar: str
    color: str
    total: int
    rounds: int
    bestCombo: int
    isYou: bool


class TopBoard(BaseModel):
    scope: TopScope
    entries: list[TopEntry]


class BoardSong(BaseModel):
    analysisId: str
    title: str
    dancers: int


def since(scope: str, now: int) -> int:
    """Earliest round time (epoch ms) a scope counts."""
    today = now // DAY * DAY
    return today if scope == "today" else today - 6 * DAY if scope == "week" else 0


def _me_id(tx: Tx, token: str | None, now: int) -> str | None:
    me = _lookup(tx, token, now)
    return str(me["id"]) if me else None


def song_board(token: str | None, analysis_id: str, title: str | None, scope: SongScope, limit: int, now: int) -> SongBoard:
    def run(tx: Tx) -> SongBoard:
        me = _me_id(tx, token, now)
        if scope == "friends" and me is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No session: call POST /api/session first.")
        friends = (
            " and (account_id = :me or account_id in (select friend_id from df_friends where account_id = :me))"
            if scope == "friends"
            else ""
        )
        rows = tx.all(
            "with best as (select account_id, score, accuracy, max_combo, stars, at,"
            "   row_number() over (partition by account_id order by score desc, at asc) as k"
            f"   from df_rounds where analysis_id = :aid and at >= :since and {_SANE}{friends}),"
            " ranked as (select b.*, row_number() over (order by score desc, at asc, account_id) as pos"
            "   from best b where k = 1)"
            " select r.*, a.name, a.avatar, a.color from ranked r join df_accounts a on a.id = r.account_id"
            " where r.pos <= :n or r.account_id = :me order by r.pos",
            aid=analysis_id, since=since(scope, now), n=limit, me=me,
        )  # fmt: skip
        mine = next((r for r in rows if r["account_id"] == me), None)
        return SongBoard(
            scope=scope,
            song=SongRef(analysisId=analysis_id, title=title),
            entries=[_entry(r, me) for r in rows if int(r["pos"]) <= limit],
            you=YourRank(rank=int(mine["pos"]), score=int(mine["score"])) if mine else None,
        )

    return transaction(run)


def _entry(r: Row, me: str | None) -> BoardEntry:
    return BoardEntry(
        rank=int(r["pos"]), accountId=r["account_id"], name=r["name"], avatar=r["avatar"], color=r["color"],
        score=int(r["score"]), accuracy=float(r["accuracy"]), maxCombo=int(r["max_combo"]), stars=float(r["stars"]),
        at=int(r["at"]), isYou=r["account_id"] == me,
    )  # fmt: skip


def _daily_view() -> bool:
    """Create df_round_daily once per database (Postgres with timescaledb) in its own transaction and savepoint,
    so a failure only means the top board reads df_rounds."""
    key = os.environ.get("DATABASE_URL", "").strip()
    if not key:
        return False  # SQLite

    def create(tx: Tx) -> bool:
        tx.run("select pg_advisory_xact_lock(7743)")  # cold-starting instances must not race the DDL
        row = tx.one("select to_regclass('df_round_daily') is not null as ok")
        if row and row["ok"]:
            return True
        if not tx.one("select 1 as x from pg_extension where extname = 'timescaledb'"):
            return False
        tx.run("savepoint df_daily")
        try:
            for stmt in _DAILY_VIEW:
                tx.run(stmt)
        except pg8000.dbapi.DatabaseError as exc:
            tx.run("rollback to savepoint df_daily")
            log.warning("leaderboard: no df_round_daily aggregate, top dancers read df_rounds: %s", exc)
            return False
        tx.run("release savepoint df_daily")
        log.info("leaderboard: df_round_daily continuous aggregate ready")
        return True

    if key not in _daily:
        _daily[key] = transaction(create)
    return _daily[key]


def top_board(token: str | None, scope: TopScope, limit: int, now: int) -> TopBoard:
    daily = _daily_view()

    def run(tx: Tx) -> TopBoard:
        me = _me_id(tx, token, now)
        if daily:
            src = (
                "select account_id, sum(total) as total, sum(n) as rounds, max(best_combo) as best_combo,"
                " min(first_at) as first_at from df_round_daily where day >= :since group by account_id"
            )
        else:
            src = (
                "select account_id, sum(score) as total, count(*) as rounds, max(max_combo) as best_combo,"
                f" min(at) as first_at from df_rounds where at >= :since and {_SANE} group by account_id"
            )
        rows = tx.all(
            f"select t.*, a.name, a.avatar, a.color from ({src}) t join df_accounts a on a.id = t.account_id"
            " order by t.total desc, t.first_at asc, t.account_id limit :n",
            since=since(scope, now), n=limit,
        )  # fmt: skip
        return TopBoard(
            scope=scope,
            entries=[
                TopEntry(rank=i, accountId=r["account_id"], name=r["name"], avatar=r["avatar"], color=r["color"],
                         total=int(r["total"]), rounds=int(r["rounds"]), bestCombo=int(r["best_combo"]),
                         isYou=r["account_id"] == me)  # fmt: skip
                for i, r in enumerate(rows, 1)
            ],
        )

    return transaction(run)


def song_dancers(token: str | None, library: list[str], now: int) -> dict[str, int]:
    """analysisId -> dancers, for the library songs and the viewer's own songs (never other players' uploads),
    most dancers first."""

    def run(tx: Tx) -> dict[str, int]:
        me = _me_id(tx, token, now)
        lib = ", ".join(f":l{i}" for i in range(len(library))) or "null"
        rows = tx.all(
            "select analysis_id, count(distinct account_id) as dancers, max(at) as last_at from df_rounds"
            f" where {_SANE} and (analysis_id in ({lib}) or analysis_id in"
            " (select analysis_id from df_rounds where account_id = :me))"
            " group by analysis_id order by dancers desc, last_at desc limit :n",
            me=me, n=len(library) + TOP_SONGS, **{f"l{i}": aid for i, aid in enumerate(library)},
        )  # fmt: skip
        return {r["analysis_id"]: int(r["dancers"]) for r in rows}

    return transaction(run)
