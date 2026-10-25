"""Hall of Fame against a real database (SQLite always, plus Postgres when DATABASE_URL is a scratch DB)."""

from __future__ import annotations

import hashlib
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.accounts import store as accounts
from app.accounts.db import transaction
from app.accounts.store import DAY, MIN
from app.analysis_store import AnalysisStore
from app.api import leaderboard
from app.config import get_settings
from app.leaderboard.store import since
from app.main import app
from app.rooms.db import Tx
from helpers import seed_analysis

BACKENDS = ["sqlite"] + (["postgres"] if os.environ.get("DATABASE_URL") else [])
H = {"X-DF": "1"}
SONG, OTHER, NEW = "ab" * 32, "cd" * 32, "ef" * 32  # NEW: a song the server never analyzed


@pytest.fixture(params=BACKENDS)
def backend(request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))
    if request.param == "sqlite":
        monkeypatch.delenv("DATABASE_URL", raising=False)
    get_settings.cache_clear()
    seed_analysis(get_settings().cache_dir, SONG, "Vibe Ace")
    seed_analysis(get_settings().cache_dir, OTHER, "Lets Go Fishin")
    yield str(request.param)
    get_settings.cache_clear()


def guest() -> tuple[TestClient, dict[str, Any]]:
    client = TestClient(app)
    r = client.post("/api/session", headers=H)
    assert r.status_code == 200, r.text
    return client, dict(r.json())


def post(client: TestClient, score: int, song: str = SONG, combo: int = 10) -> int:
    """Record a round; the posted title is junk on purpose: public boards must never show it."""
    body = {"analysisId": song, "songTitle": "Posted By Client", "score": score, "accuracy": 80.0, "maxCombo": combo,
            "stars": 3, "mode": "solo"}  # fmt: skip
    return client.post("/api/me/rounds", json=body, headers=H).status_code


def play(client: TestClient, score: int, song: str = SONG, combo: int = 10) -> None:
    assert post(client, score, song, combo) == 200


def library_song(root: Path, name: str) -> str:
    """A file in the song library (never decoded here); returns its analysisId."""
    (root / "songs").mkdir(exist_ok=True)
    (root / "songs" / name).write_bytes(name.encode())
    return hashlib.sha256(name.encode()).hexdigest()


def sql(statement: str, **params: Any) -> None:
    def run(tx: Tx) -> None:
        tx.run(statement, **params)

    transaction(run)


def board(client: TestClient, song: str = SONG, **params: Any) -> dict[str, Any]:
    r = client.get(f"/api/leaderboard/song/{song}", params=params)
    assert r.status_code == 200, r.text
    return dict(r.json())


@pytest.fixture
def dancers(backend: str) -> dict[str, tuple[TestClient, dict[str, Any]]]:
    """ana: 100 then 300; bo: 300 (later, so second); cy: 50 plus junk rounds the boards must ignore."""
    ana, bo, cy = guest(), guest(), guest()
    play(ana[0], 100, combo=30)
    play(ana[0], 300, combo=5)
    sql("update df_rounds set at = at - 1000 where account_id = :id", id=ana[1]["id"])  # ana danced it first
    play(bo[0], 300, combo=12)
    play(cy[0], 50)
    play(cy[0], 60)
    sql("update df_rounds set score = 2000000 where score = 60")  # from before the API capped scores; boards skip it
    sql("update df_rounds set accuracy = 250 where account_id = :id and score = 50", id=cy[1]["id"])
    play(cy[0], 50)
    return {"ana": ana, "bo": bo, "cy": cy}


def test_song_board_ranks_best_round_per_account(dancers: dict[str, tuple[TestClient, dict[str, Any]]]) -> None:
    ana, bo, cy = (dancers[k][1]["id"] for k in ("ana", "bo", "cy"))
    b = board(TestClient(app))  # no cookie: nobody is "you"
    assert b["song"] == {"analysisId": SONG, "title": "Vibe Ace"}
    assert [(e["rank"], e["accountId"], e["score"]) for e in b["entries"]] == [(1, ana, 300), (2, bo, 300), (3, cy, 50)]
    assert b["entries"][0]["maxCombo"] == 5  # the best round's own stats, not the account's best combo
    assert not any(e["isYou"] for e in b["entries"]) and b["you"] is None


def test_you_and_limit(dancers: dict[str, tuple[TestClient, dict[str, Any]]]) -> None:
    cy_client, cy = dancers["cy"]
    b = board(cy_client)
    assert [e["isYou"] for e in b["entries"]] == [False, False, True]
    assert b["you"] == {"rank": 3, "score": 50}
    b = board(cy_client, limit=1)
    assert len(b["entries"]) == 1 and b["you"] == {"rank": 3, "score": 50}
    assert cy_client.get(f"/api/leaderboard/song/{SONG}", params={"limit": 0}).status_code == 400
    assert cy_client.get(f"/api/leaderboard/song/{SONG}", params={"limit": 51}).status_code == 400


def test_empty_and_bad_song(backend: str) -> None:
    client, _ = guest()
    assert board(client, NEW) == {"scope": "all", "song": {"analysisId": NEW, "title": None}, "entries": [], "you": None}
    assert client.get("/api/leaderboard/song/nothex").status_code == 400
    assert client.get(f"/api/leaderboard/song/{SONG}", params={"scope": "decade"}).status_code == 400


def test_time_scopes(dancers: dict[str, tuple[TestClient, dict[str, Any]]]) -> None:
    ana, bo, cy = (dancers[k][1]["id"] for k in ("ana", "bo", "cy"))
    sql("update df_rounds set at = at - :d where account_id = :id", d=2 * DAY, id=bo)
    sql("update df_rounds set at = at - :d where account_id = :id", d=10 * DAY, id=cy)
    ids = lambda scope: [e["accountId"] for e in board(TestClient(app), scope=scope)["entries"]]  # noqa: E731
    assert ids("today") == [ana]
    assert ids("week") == [bo, ana]  # same 300, but bo's is now the earlier one
    assert ids("all") == [bo, ana, cy]


def test_since_is_utc_days() -> None:
    now = 100 * DAY + 5 * MIN
    assert (since("all", now), since("today", now), since("week", now)) == (0, 100 * DAY, 94 * DAY)


def test_friends_scope(dancers: dict[str, tuple[TestClient, dict[str, Any]]]) -> None:
    (ana_client, ana), (_, bo) = dancers["ana"], dancers["bo"]
    r = ana_client.post("/api/friends", json={"code": bo["friendCode"]}, headers=H)
    assert r.status_code == 200, r.text
    b = board(ana_client, scope="friends")
    assert [e["accountId"] for e in b["entries"]] == [ana["id"], bo["id"]]
    assert b["you"] == {"rank": 1, "score": 300}
    assert TestClient(app).get(f"/api/leaderboard/song/{SONG}", params={"scope": "friends"}).status_code == 401


def test_top_dancers(dancers: dict[str, tuple[TestClient, dict[str, Any]]]) -> None:
    (ana_client, ana), (_, bo), (_, cy) = dancers["ana"], dancers["bo"], dancers["cy"]
    play(ana_client, 40, song=OTHER)
    r = ana_client.get("/api/leaderboard/top", params={"scope": "all"})
    assert r.status_code == 200, r.text
    rows = [(e["rank"], e["accountId"], e["total"], e["rounds"], e["bestCombo"], e["isYou"]) for e in r.json()["entries"]]
    assert rows == [(1, ana["id"], 440, 3, 30, True), (2, bo["id"], 300, 1, 12, False), (3, cy["id"], 50, 1, 10, False)]
    sql("update df_rounds set at = at - :d where account_id = :id", d=10 * DAY, id=bo["id"])
    week = ana_client.get("/api/leaderboard/top").json()  # week is the default
    assert week["scope"] == "week" and [e["accountId"] for e in week["entries"]] == [ana["id"], cy["id"]]
    assert len(ana_client.get("/api/leaderboard/top", params={"scope": "all", "limit": 2}).json()["entries"]) == 2


def test_songs_picker(backend: str, tmp_path: Path) -> None:
    moon, waltz = library_song(tmp_path, "Moon_River.wav"), library_song(tmp_path, "Waltz.wav")
    (ana, _), (bo, _) = guest(), guest()
    play(ana, 100, song=moon)
    play(ana, 100)
    play(bo, 100)
    play(bo, 40, song=OTHER)  # bo's own upload: nobody else's picker lists it
    AnalysisStore(get_settings().cache_dir).analysis_path(OTHER).unlink()  # its title is now unknown
    picker = lambda c: c.get("/api/leaderboard/songs").json()  # noqa: E731
    lib = [{"analysisId": moon, "title": "Moon River", "dancers": 1}, {"analysisId": waltz, "title": "Waltz", "dancers": 0}]
    assert picker(TestClient(app)) == lib
    assert picker(ana) == lib + [{"analysisId": SONG, "title": "Vibe Ace", "dancers": 2}]
    assert picker(bo) == lib + [
        {"analysisId": SONG, "title": "Vibe Ace", "dancers": 2},
        {"analysisId": OTHER, "title": "Unknown song", "dancers": 1},
    ]


def test_titles_come_from_the_server(backend: str, tmp_path: Path) -> None:
    moon = library_song(tmp_path, "Moon_River.wav")
    seed_analysis(get_settings().cache_dir, moon, "Re-uploaded As Something Else")
    client, _ = guest()
    play(client, 100, song=moon)
    assert board(client, moon)["song"]["title"] == "Moon River"  # library title wins over the cached one
    assert board(client)["song"]["title"] == "Vibe Ace"  # cached analysis, not "Posted By Client"


def test_implausible_rounds_are_rejected(backend: str, tmp_path: Path) -> None:
    seed_analysis(get_settings().cache_dir, NEW, beats=10)  # at most 10 + 32 checkpoints of 400 points
    client, _ = guest()
    assert post(client, 400 * 42, song=NEW, combo=42) == 200
    assert post(client, 400 * 42 + 1, song=NEW) == 400
    assert post(client, 100, song=NEW, combo=43) == 400
    assert post(client, 100, song="12" * 32) == 400  # never analyzed by this server
    assert post(client, 5000, song=library_song(tmp_path, "Waltz.wav")) == 200  # library song, not analyzed yet


def test_song_day_limit(backend: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(accounts, "SONG_DAY_LIMIT", (2, DAY))
    client, me = guest()
    assert [post(client, 100) for _ in range(3)] == [200, 200, 429]
    assert post(client, 100, song=OTHER) == 200  # other songs are fine
    sql("update df_rounds set at = at - :d where account_id = :id", d=DAY, id=me["id"])
    assert post(client, 100) == 200  # a day later


def test_rate_limit(backend: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(leaderboard, "LIMIT", (2, MIN))
    client = TestClient(app)
    assert [client.get("/api/leaderboard/top").status_code for _ in range(3)] == [200, 200, 429]
