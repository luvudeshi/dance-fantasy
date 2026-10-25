"""Versus and crew scoring from per-beat judgements (shared/README.md, "Stage 6 endpoints").

Each round (one start of a routine, keyed by its ``start_at`` = ``round_ms``) collects one judgement
per player per beat in ``df_room_beats``. Both modes' numbers are kept in every room; ``mode`` only
says which one the clients show.

- Versus: a beat goes to the best score on it (ties shared; a beat everyone scored 0 goes to
  nobody). The leader has the most beats won, then the higher score; nobody leads on a tie.
- Crew: a beat is in sync when every active (connected, not finished) dancer judged it good or
  perfect. Beats are decided in order, once every active dancer has posted that far or the furthest
  one is ``SYNC_LAG_BEATS`` ahead (whoever is missing it then breaks the sync); a beat no active
  dancer judged is skipped (the routine has no checkpoint there). Each synced beat adds
  ``SYNC_BONUS_STEP * min(streak, SYNC_BONUS_CAP)`` to the team score.
"""

from __future__ import annotations

from app.rooms.db import Row, Tx, heat_view_exists, transaction
from app.rooms.models import BeatJudgement, CrewStats, HeatBeat, Heatmap, RoutineChoice

SYNC_GRADES = ("perfect", "good")
SYNC_LAG_BEATS = 16
SYNC_BONUS_STEP = 25  # a perfect beat is worth 100 base points to one dancer
SYNC_BONUS_CAP = 8  # so a long streak adds 200 a beat
# Beats past what the song can have reached are dropped: 8 a second (480 bpm) plus a margin.
MAX_BEATS_PER_SEC = 8
BEAT_SLACK = 32

RESET_SYNC = (
    "update df_rooms set sync_upto = -1, synced_beats = 0, sync_streak = 0, best_sync_streak = 0,"
    " last_sync_beat = null, sync_bonus = 0 where code = :code"
)
_SYNC_FRESH = {
    "sync_upto": -1, "synced_beats": 0, "sync_streak": 0, "best_sync_streak": 0, "last_sync_beat": None,
    "sync_bonus": 0,
}  # fmt: skip


def reset_sync(tx: Tx, room: Row) -> None:
    tx.run(RESET_SYNC, code=room["code"])
    room.update(_SYNC_FRESH)


def insert_beats(tx: Tx, room: Row, player_id: str, beats: list[BeatJudgement], now: int) -> None:
    """Store judgements for the current round; a beat the player already sent keeps its first judgement."""
    cap = (now - room["start_at"]) * MAX_BEATS_PER_SEC // 1000 + BEAT_SLACK
    beats = [b for b in beats if b.beat <= cap]
    if not beats:
        return
    routine = RoutineChoice.model_validate_json(room["routine"])
    params: dict[str, object] = {
        "code": room["code"], "round": room["start_at"], "pid": player_id, "aid": routine.analysisId, "now": now,
    }  # fmt: skip
    rows = []
    for i, b in enumerate(beats):  # placeholders are generated names; every value is a bound parameter
        rows.append(f"(:code, :round, :pid, :aid, :b{i}, :s{i}, :g{i}, :now)")
        params.update({f"b{i}": b.beat, f"s{i}": b.score, f"g{i}": b.grade})
    tx.run(
        "insert into df_room_beats (code, round_ms, player_id, analysis_id, beat, score, grade, at) values "
        + ", ".join(rows)
        + " on conflict (code, round_ms, beat, player_id) do nothing",
        **params,
    )


def advance_sync(tx: Tx, room: Row, active: list[str]) -> None:
    """Decide crew sync for the beats that are ready (see the module docstring) and store the totals."""
    if not active:
        return
    upto = int(room["sync_upto"])
    grades: dict[str, dict[int, str]] = {pid: {} for pid in active}
    for r in tx.all(
        "select player_id, beat, grade from df_room_beats where code = :code and round_ms = :round and beat > :upto",
        code=room["code"], round=room["start_at"], upto=upto,
    ):  # fmt: skip
        if r["player_id"] in grades:
            grades[r["player_id"]][int(r["beat"])] = r["grade"]
    reached = [max(g, default=upto) for g in grades.values()]
    decide_to = max(min(reached), max(reached) - SYNC_LAG_BEATS)
    if decide_to <= upto:
        return
    streak, synced, best = int(room["sync_streak"]), int(room["synced_beats"]), int(room["best_sync_streak"])
    last, bonus = room["last_sync_beat"], int(room["sync_bonus"])
    for beat in range(upto + 1, decide_to + 1):
        judged = [g.get(beat) for g in grades.values()]
        if all(j is None for j in judged):
            continue  # no checkpoint on this beat
        if all(j in SYNC_GRADES for j in judged):
            streak += 1
            synced += 1
            best = max(best, streak)
            last = beat
            bonus += SYNC_BONUS_STEP * min(streak, SYNC_BONUS_CAP)
        else:
            streak = 0
    fields = {
        "sync_upto": decide_to, "synced_beats": synced, "sync_streak": streak, "best_sync_streak": best,
        "last_sync_beat": last, "sync_bonus": bonus,
    }  # fmt: skip
    tx.run(
        "update df_rooms set sync_upto = :sync_upto, synced_beats = :synced_beats, sync_streak = :sync_streak,"
        " best_sync_streak = :best_sync_streak, last_sync_beat = :last_sync_beat, sync_bonus = :sync_bonus"
        " where code = :code",
        code=room["code"], **fields,
    )  # fmt: skip
    room.update(fields)


def beats_won(tx: Tx, room: Row) -> dict[str, int]:
    """Versus: player id -> beats where they had the best score this round."""
    if room["start_at"] is None:
        return {}
    rows = tx.all(
        "select b.player_id, count(*) as won from df_room_beats b"
        " join (select beat, max(score) as best from df_room_beats where code = :code and round_ms = :round"
        " group by beat) m on m.beat = b.beat"
        " where b.code = :code and b.round_ms = :round and b.score = m.best and m.best > 0"
        " group by b.player_id",
        code=room["code"], round=room["start_at"],
    )  # fmt: skip
    return {r["player_id"]: int(r["won"]) for r in rows}


def leader(standings: list[tuple[str, int, int]]) -> str | None:
    """Versus leader from (player id, beats won, score): the unique best by beats won, then score."""
    ranked = sorted(standings, key=lambda s: (s[1], s[2]), reverse=True)
    if not ranked or ranked[0][1:] == (0, 0) or (len(ranked) > 1 and ranked[0][1:] == ranked[1][1:]):
        return None
    return ranked[0][0]


def crew_stats(room: Row, total_score: int) -> CrewStats:
    return CrewStats(
        teamScore=total_score + int(room["sync_bonus"]),
        syncBonus=int(room["sync_bonus"]),
        syncedBeats=int(room["synced_beats"]),
        syncStreak=int(room["sync_streak"]),
        bestSyncStreak=int(room["best_sync_streak"]),
        lastSyncBeat=None if room["last_sync_beat"] is None else int(room["last_sync_beat"]),
    )


def heatmap(analysis_id: str) -> Heatmap:
    """Average score per beat of this song: each room round's (clamped) average first, then the mean over
    rounds, so every round weighs the same however many dancers or judgements it had (the continuous
    aggregate if there is one)."""

    def run(tx: Tx) -> Heatmap:
        if heat_view_exists(tx):
            per_round = (
                "select beat, sum(total) * 1.0 / sum(n) as r from df_round_heat where analysis_id = :aid"
                " group by code, round_ms, beat"
            )
        else:
            per_round = (
                "select beat, avg(case when score < 0 then 0 when score > 100 then 100 else score end) as r"
                " from df_room_beats where analysis_id = :aid group by code, round_ms, beat"
            )
        rows = tx.all(
            f"select beat, avg(r) as avg_score, count(*) as rounds from ({per_round}) as per_round"
            " group by beat order by beat",
            aid=analysis_id,
        )
        return Heatmap(
            analysisId=analysis_id,
            beats=[
                HeatBeat(beat=int(r["beat"]), avgScore=round(float(r["avg_score"]), 2), samples=int(r["rounds"]))
                for r in rows
            ],
        )

    return transaction(run)
