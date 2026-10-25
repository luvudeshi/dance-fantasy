"""Hall of Fame against a real database (SQLite always, plus Postgres when DATABASE_URL is a scratch DB)."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.accounts.db import transaction
from app.accounts.store import DAY, MIN
from app.api import leaderboard
from app.config import get_settings
from app.leaderboard.store import since
from app.main import app
from app.rooms.db import Tx

BACKENDS = ["sqlite"] + (["postgres"] if os.environ.get("DATABASE_URL") else [])
H = {"X-DF": "1"}
SONG, OTHER = "ab" * 32, "cd" * 32


@pytest.fixture(params=BACKENDS)
def backend(request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))
    if request.param == "sqlite":
        monkeypatch.delenv("DATABASE_URL", raising=False)
    get_settings.cache_clear()
    yield str(request.param)
    get_settings.cache_clear()


def guest() -> tuple[TestClient, dict[str, Any]]:
    client = TestClient(app)
    r = client.post("/api/session", headers=H)
    assert r.status_code == 200, r.text
    return client, dict(r.json())


def play(client: TestClient, score: int, song: str = SONG, title: str = "Vibe Ace", combo: int = 10) -> None:
    body = {"analysisId": song, "songTitle": title, "score": score, "accuracy": 80.0, "maxCombo": combo, "stars": 3, "mode": "solo"}
    r = client.post("/api/me/rounds", json=body, headers=H)
    assert r.status_code == 200, r.text


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
    play(cy[0], 2_000_000)  # the API takes it; the boards don't
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
    assert board(client, OTHER) == {"scope": "all", "song": {"analysisId": OTHER, "title": None}, "entries": [], "you": None}
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
    play(ana_client, 40, song=OTHER, title="Lets Go Fishin")
    r = ana_client.get("/api/leaderboard/top", params={"scope": "all"})
    assert r.status_code == 200, r.text
    rows = [(e["rank"], e["accountId"], e["total"], e["rounds"], e["bestCombo"], e["isYou"]) for e in r.json()["entries"]]
    assert rows == [(1, ana["id"], 440, 3, 30, True), (2, bo["id"], 300, 1, 12, False), (3, cy["id"], 50, 1, 10, False)]
    sql("update df_rounds set at = at - :d where account_id = :id", d=10 * DAY, id=bo["id"])
    week = ana_client.get("/api/leaderboard/top").json()  # week is the default
    assert week["scope"] == "week" and [e["accountId"] for e in week["entries"]] == [ana["id"], cy["id"]]
    assert len(ana_client.get("/api/leaderboard/top", params={"scope": "all", "limit": 2}).json()["entries"]) == 2


def test_songs_picker(dancers: dict[str, tuple[TestClient, dict[str, Any]]]) -> None:
    play(dancers["ana"][0], 40, song=OTHER, title="Lets Go Fishin")
    r = TestClient(app).get("/api/leaderboard/songs")
    assert r.status_code == 200, r.text
    assert r.json() == [  # no library in this tmp assets dir: songs with rounds, most dancers first
        {"analysisId": SONG, "title": "Vibe Ace", "dancers": 3},
        {"analysisId": OTHER, "title": "Lets Go Fishin", "dancers": 1},
    ]


def test_rate_limit(backend: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(leaderboard, "LIMIT", (2, MIN))
    client = TestClient(app)
    assert [client.get("/api/leaderboard/top").status_code for _ in range(3)] == [200, 200, 429]
