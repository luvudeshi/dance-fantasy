"""Versus and crew modes, per-beat judgements, rematch and the song heatmap, on a real database.

Same backends as test_rooms.py (SQLite always, Postgres when DATABASE_URL is set). Store-level
tests pass explicit times; players count as connected for 10 s after their last request.
"""

from __future__ import annotations

import secrets
import sqlite3
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from test_rooms import ROUTINE, SCORE, auth, backend, client, now_ms, rewind_start  # noqa: F401 - fixtures

from app.config import get_settings
from app.rooms import modes, store
from app.rooms.db import Tx, transaction
from app.rooms.models import BeatJudgement, Created, Joined, RoomMode, RoomView, RoutineChoice, ScoreBody


def judge(*items: tuple[int, float, str]) -> list[BeatJudgement]:
    return [BeatJudgement.model_validate({"beat": b, "score": s, "grade": g}) for b, s, g in items]


def good(*beats: int) -> list[BeatJudgement]:
    return judge(*((b, 80.0, "good") for b in beats))


def song() -> RoutineChoice:
    """A routine on a fresh song id, so heatmaps from other tests (or runs) never mix in."""
    return RoutineChoice.model_validate({**ROUTINE, "analysisId": secrets.token_hex(32)})


def room(guests: int, mode: RoomMode, routine: RoutineChoice | None = None) -> tuple[Created, list[Joined], int]:
    """A room with a host and ``guests`` more, started; returns the players and the song's start time."""
    t = now_ms()
    host = store.create_room("Host", t)
    others = [store.join_room(host.code, f"Guest {i + 1}", t) for i in range(guests)]
    store.set_routine(host.code, host.token, routine or song(), None, t)
    assert store.set_mode(host.code, host.token, mode, None, t).mode == mode
    start_at = store.start(host.code, host.token, None, t).startAt
    assert start_at is not None
    return host, others, start_at


def beats(code: str, p: Joined, items: list[BeatJudgement], at: int) -> RoomView:
    return store.post_beats(code, p.token, items, None, at)


def finish(code: str, p: Joined, score: int, at: int) -> RoomView:
    body = ScoreBody.model_validate({**SCORE, "score": score, "progress": 1.0, "finished": True})
    return store.post_score(code, p.token, body, None, at)


def stored_beats(code: str) -> list[tuple[str, int, float]]:
    def run(tx: Tx) -> list[tuple[str, int, float]]:
        rows = tx.all("select player_id, beat, score from df_room_beats where code = :code", code=code)
        return sorted((r["player_id"], int(r["beat"]), float(r["score"])) for r in rows)

    return transaction(run)


def test_mode_defaults_to_versus_and_only_the_host_switches_it(backend: str) -> None:
    t = now_ms()
    host = store.create_room("Host", t)
    guest = store.join_room(host.code, "Guest", t)
    view = store.get_room(host.code, None, None, t)
    assert view.mode == "versus" and view.leaderId is None
    assert view.crew.model_dump() == {
        "teamScore": 0, "syncBonus": 0, "syncedBeats": 0, "syncStreak": 0, "bestSyncStreak": 0, "lastSyncBeat": None,
    }  # fmt: skip
    assert [p.beatsWon for p in view.players] == [0, 0]
    with pytest.raises(HTTPException) as denied:
        store.set_mode(host.code, guest.token, "crew", None, t)
    assert denied.value.status_code == 403

    store.set_routine(host.code, host.token, song(), None, t)
    assert store.set_mode(host.code, host.token, "crew", None, t).mode == "crew"
    start_at = store.start(host.code, host.token, None, t).startAt
    assert start_at is not None
    for at in (t + 1, start_at + 1):  # countdown, playing
        with pytest.raises(HTTPException) as busy:
            store.set_mode(host.code, host.token, "versus", None, at)
        assert busy.value.status_code == 409
    finish(host.code, host, 10, start_at + 2)
    finish(host.code, guest, 10, start_at + 3)
    # Kept when picking another routine, switchable again once the song is over.
    assert store.set_routine(host.code, host.token, song(), None, start_at + 4).mode == "crew"
    assert store.set_mode(host.code, host.token, "versus", None, start_at + 5).mode == "versus"


def test_beats_are_idempotent_and_only_count_while_dancing(backend: str) -> None:
    host, (guest,), start_at = room(1, "versus")
    code = host.code
    beats(code, guest, good(0, 1), start_at - 10)  # countdown: ignored
    assert stored_beats(code) == []

    beats(code, guest, judge((0, 50, "ok"), (1, 90, "good"), (1, 10, "miss")), start_at + 100)
    beats(code, guest, judge((0, 99, "perfect"), (2, 70, "good")), start_at + 200)  # beat 0 again: first one stays
    gid = guest.playerId
    assert stored_beats(code) == [(gid, 0, 50.0), (gid, 1, 90.0), (gid, 2, 70.0)]

    # Beats the song can't have reached yet (8 a second plus 32) are dropped.
    beats(code, guest, good(40, 41), start_at + 1_000)
    assert [b for _, b, _ in stored_beats(code)] == [0, 1, 2, 40]

    # Once you've finished, and once the song is over, beats are ignored.
    finish(code, guest, 500, start_at + 1_100)
    beats(code, guest, good(3), start_at + 1_200)
    finish(code, host, 400, start_at + 1_300)
    assert store.get_room(code, None, None, start_at + 1_400).state == "finished"
    beats(code, host, good(3), start_at + 1_500)
    assert len(stored_beats(code)) == 4


def test_versus_best_score_wins_each_beat(backend: str) -> None:
    host, (ana, bo), start_at = room(2, "versus")
    code = host.code
    at = start_at + 1_000
    beats(code, host, judge((0, 90, "good"), (1, 60, "ok"), (2, 100, "perfect"), (3, 0, "miss")), at)
    beats(code, ana, judge((0, 70, "good"), (1, 95, "perfect"), (2, 100, "perfect"), (3, 0, "miss")), at)
    view = beats(code, bo, judge((0, 10, "miss"), (1, 20, "miss"), (4, 55, "ok")), at)
    # beat 0: host, 1: Ana, 2: tie (both), 3: everyone 0 (nobody), 4: Bo alone.
    assert [p.beatsWon for p in view.players] == [2, 2, 1]
    assert view.leaderId is None  # host and Ana tie on beats and score
    store.post_score(code, ana.token, ScoreBody.model_validate({**SCORE, "score": 300}), None, at)
    assert store.get_room(code, None, None, at).leaderId == ana.playerId  # same beats, more points
    view = beats(code, host, judge((5, 30, "ok")), at + 1)
    assert view.leaderId == host.playerId and view.players[0].beatsWon == 3


def test_crew_sync_streak_and_bonus(backend: str) -> None:
    host, (guest,), start_at = room(1, "crew")
    code = host.code
    at = start_at + 1_000
    beats(code, host, good(0, 1, 2, 3), at)
    assert store.get_room(code, None, None, at).crew.syncedBeats == 0  # waits for the guest
    view = beats(code, guest, judge((0, 100, "perfect"), (1, 80, "good"), (2, 75, "good"), (3, 90, "perfect")), at)
    step = modes.SYNC_BONUS_STEP
    assert view.crew.syncedBeats == 4 and view.crew.syncStreak == 4 and view.crew.lastSyncBeat == 3
    assert view.crew.syncBonus == step * (1 + 2 + 3 + 4)

    # An "ok" breaks the streak; a beat nobody judged (no checkpoint) neither counts nor breaks it.
    beats(code, host, good(4, 5, 7), at + 1_000)
    view = beats(code, guest, judge((4, 60, "ok"), (5, 85, "good"), (7, 85, "good")), at + 1_000)
    crew = view.crew
    assert (crew.syncedBeats, crew.syncStreak, crew.bestSyncStreak, crew.lastSyncBeat) == (6, 2, 4, 7)
    assert crew.syncBonus == step * (1 + 2 + 3 + 4) + step * (1 + 2)

    # The streak bonus is capped.
    run = list(range(8, 8 + modes.SYNC_BONUS_CAP + 4))
    beats(code, host, good(*run), at + 3_000)
    crew = beats(code, guest, good(*run), at + 3_000).crew
    assert crew.syncStreak == 2 + len(run) and crew.bestSyncStreak == crew.syncStreak
    expected = step * (10 + 3) + sum(step * min(n, modes.SYNC_BONUS_CAP) for n in range(3, 3 + len(run)))
    assert crew.syncBonus == expected

    # teamScore = everyone's score + the bonus.
    store.post_score(code, host.token, ScoreBody.model_validate({**SCORE, "score": 1000}), None, at + 3_100)
    view = store.post_score(code, guest.token, ScoreBody.model_validate({**SCORE, "score": 700}), None, at + 3_100)
    assert view.crew.teamScore == 1700 + expected


def test_crew_sync_follows_who_is_dancing(backend: str) -> None:
    host, (guest, third), start_at = room(2, "crew")
    code = host.code
    at = start_at + 1_000
    for p in (host, guest, third):
        beats(code, p, good(0, 1), at)
    assert store.get_room(code, None, None, at).crew.syncedBeats == 2

    # A mid-song joiner sits out, so they never hold the crew back.
    late = store.join_room(code, "Late", at + 100)
    for p in (host, guest, third):
        view = beats(code, p, good(2), at + 200)
    assert view.crew.syncedBeats == 3
    beats(code, late, judge((3, 0, "miss")), at + 300)  # ignored: they're sitting out

    # Someone who leaves no longer counts.
    store.leave(code, third.token, at + 400)
    beats(code, host, good(3, 4), at + 500)
    assert beats(code, guest, good(3, 4), at + 500).crew.syncedBeats == 5

    # Someone who drops out (no request for 10 s) no longer counts either.
    beats(code, host, good(5), at + 9_000)  # the guest hasn't been seen since at + 500
    assert store.get_room(code, None, None, at + 9_000).crew.syncedBeats == 5
    assert beats(code, host, good(6), at + 11_000).crew.syncedBeats == 7

    # The guest is back but not sending beats: once the host is 16 beats ahead, those beats are out of sync.
    store.get_room(code, guest.token, None, at + 12_000)
    ahead = list(range(7, 7 + modes.SYNC_LAG_BEATS + 3))
    crew = beats(code, host, good(*ahead), at + 12_000).crew
    assert (crew.syncedBeats, crew.syncStreak, crew.lastSyncBeat) == (7, 0, 6)

    # A finished dancer stops counting too: the host alone decides the rest (the 16 beats held back, plus one).
    finish(code, guest, 100, at + 12_100)
    crew = beats(code, host, good(ahead[-1] + 1), at + 12_200).crew
    assert crew.syncedBeats == 7 + modes.SYNC_LAG_BEATS + 1 and crew.lastSyncBeat == ahead[-1] + 1


def test_rematch_replays_the_same_routine_and_mode(backend: str) -> None:
    routine = song()
    host, (guest,), start_at = room(1, "crew", routine)
    code = host.code
    at = start_at + 1_000
    beats(code, host, good(0), at)
    beats(code, guest, good(0), at)
    with pytest.raises(HTTPException) as early:
        store.rematch(code, host.token, None, at)
    assert early.value.status_code == 409
    finish(code, host, 900, at + 100)
    view = finish(code, guest, 800, at + 100)
    assert view.state == "finished" and view.crew.syncedBeats == 1
    with pytest.raises(HTTPException) as denied:
        store.rematch(code, guest.token, None, at + 200)
    assert denied.value.status_code == 403

    again = store.rematch(code, host.token, None, at + 200)
    assert again.state == "countdown" and again.startAt == at + 200 + store.COUNTDOWN_MS
    assert again.routine == routine and again.mode == "crew"
    assert all(p.score == 0 and not p.finished and p.beatsWon == 0 for p in again.players)
    assert again.crew.syncedBeats == 0 and again.crew.syncBonus == 0 and again.crew.teamScore == 0
    # The new round starts clean (the same beat numbers count again); the old one stays in the heatmap.
    assert again.startAt is not None
    beats(code, host, good(0), again.startAt + 100)
    assert beats(code, guest, good(0), again.startAt + 100).crew.syncedBeats == 1
    assert [b.samples for b in modes.heatmap(routine.analysisId).beats] == [4]


def test_heatmap_averages_each_beat_across_rooms(backend: str) -> None:
    routine = song()
    first, (guest,), s1 = room(1, "versus", routine)
    second, _, s2 = room(0, "crew", routine)
    other, _, s3 = room(0, "versus")  # another song
    beats(first.code, first, judge((0, 100, "perfect"), (1, 20, "miss")), s1 + 1_000)
    beats(first.code, guest, judge((0, 80, "good"), (1, 40, "ok")), s1 + 1_000)
    beats(second.code, second, judge((1, 30, "miss"), (2, 66, "ok")), s2 + 1_000)
    beats(other.code, other, judge((0, 1, "miss")), s3 + 1_000)
    heat = modes.heatmap(routine.analysisId)
    assert heat.analysisId == routine.analysisId
    assert [(b.beat, b.avgScore, b.samples) for b in heat.beats] == [(0, 90.0, 2), (1, 30.0, 3), (2, 66.0, 1)]
    assert modes.heatmap(secrets.token_hex(32)).beats == []


def test_an_older_rooms_table_gains_the_new_columns(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    get_settings.cache_clear()
    path = get_settings().cache_dir / "rooms.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    t = now_ms()
    con = sqlite3.connect(path)
    con.executescript(
        "create table df_rooms (code text primary key, host_id text not null, routine text, start_at bigint,"
        " finished_at bigint, created_at bigint not null, active_at bigint not null);"
        f"insert into df_rooms values ('KQWX', 'old-host', null, null, null, {t}, {t});"
    )
    con.close()
    view = store.get_room("KQWX", None, None, t)  # the first request adds the columns
    assert view.mode == "versus" and view.crew.syncedBeats == 0 and view.crew.lastSyncBeat is None
    get_settings.cache_clear()


def test_modes_over_http(client: TestClient) -> None:
    host = client.post("/api/rooms", json={"name": "Host"}).json()
    code = host["code"]
    guest = client.post(f"/api/rooms/{code}/join", json={"name": "Guest"}).json()
    analysis = secrets.token_hex(32)
    client.post(f"/api/rooms/{code}/routine", json={**ROUTINE, "analysisId": analysis}, headers=auth(host["token"]))
    assert client.post(f"/api/rooms/{code}/mode", json={"mode": "solo"}, headers=auth(host["token"])).status_code == 400
    r = client.post(f"/api/rooms/{code}/mode", json={"mode": "crew"}, headers=auth(host["token"]))
    assert r.status_code == 200 and r.json()["mode"] == "crew"
    assert client.post(f"/api/rooms/{code}/rematch", headers=auth(host["token"])).status_code == 409  # lobby
    client.post(f"/api/rooms/{code}/start", headers=auth(host["token"]))
    rewind_start(code, store.COUNTDOWN_MS + 1_000)

    def post(token: str, body: object) -> int:
        return client.post(f"/api/rooms/{code}/beats", json=body, headers=auth(token)).status_code

    one = {"beat": 0, "score": 88.5, "grade": "good"}
    assert post(host["token"], {"beats": [one] * 65}) == 400  # 64 per call at most
    assert post(host["token"], {"beats": [{**one, "grade": "great"}]}) == 400
    assert post(host["token"], {"beats": [{**one, "beat": -1}]}) == 400
    assert post(host["token"], {"beats": [{**one, "score": 101}]}) == 400
    assert post(host["token"], {"beats": [one], "extra": 1}) == 400
    r = client.post(f"/api/rooms/{code}/beats", json={"beats": [one]})
    assert r.status_code == 401
    assert post(host["token"], {"beats": [one]}) == 200
    r = client.post(f"/api/rooms/{code}/beats", json={"beats": [one]}, headers=auth(guest["token"]))
    view = r.json()
    assert view["state"] == "playing" and view["crew"]["syncedBeats"] == 1 and view["crew"]["lastSyncBeat"] == 0
    assert [p["beatsWon"] for p in view["players"]] == [1, 1] and view["leaderId"] is None

    heat = client.get(f"/api/songs/{analysis}/heatmap")
    assert heat.status_code == 200
    assert heat.json() == {"analysisId": analysis, "beats": [{"beat": 0, "avgScore": 88.5, "samples": 2}]}
    assert client.get("/api/songs/not-a-song/heatmap").status_code == 400
