"""Badges against a real database (the accounts tests' backends): every rule, no double awards, progress."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.badges import CATALOG
from test_accounts import ROUND, H, backend, browser, friends, guest, named, sql  # noqa: F401  (backend: fixture)

ICONS = Path(__file__).resolve().parents[2] / "web" / "public" / "art" / "icons"
NOON = int(datetime(2026, 10, 25, 18, tzinfo=UTC).timestamp() * 1000)  # 12:00 in UTC-6
LOCAL_MIDNIGHT = int(datetime(2026, 10, 25, 6, tzinfo=UTC).timestamp() * 1000)  # 00:00 in UTC-6
HOUR = 3_600_000


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """The API's notion of now (epoch ms), so the midnight badge doesn't depend on when the tests run."""
    now = [NOON]
    monkeypatch.setattr("app.api.accounts._now", lambda: now[0])
    return now


def play(client: TestClient, **changes: Any) -> list[str]:
    r = client.post("/api/me/rounds", json={**ROUND, **changes}, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True  # still the old { ok: true } shape, plus newBadges
    return [b["id"] for b in body["newBadges"]]


def mine(client: TestClient) -> dict[str, Any]:
    r = client.get("/api/me/badges")
    assert r.status_code == 200, r.text
    return dict(r.json())


def test_catalog() -> None:
    body = browser().get("/api/badges").json()
    assert 12 <= len(body) <= 16
    assert len({b["id"] for b in body}) == len(body)
    assert [b["tier"] for b in body] == sorted((b["tier"] for b in body), key=["bronze", "silver", "gold"].index)
    for b in body:
        assert (ICONS / f"{b['icon']}.svg").is_file(), b["icon"]
        assert b["name"] and b["description"] and b["unit"]


def test_round_rules_progress_and_no_double_awards(backend: str, clock: list[int]) -> None:
    a = browser()
    guest(a)
    locked = {b["id"]: b["progress"] for b in mine(a)["locked"]}
    assert len(locked) == len(CATALOG) and locked["songbird"] == {"have": 0, "need": 5}

    assert play(a, maxCombo=12, stars=3, accuracy=80) == ["first-dance", "spark-of-magic"]
    assert play(a, maxCombo=12, stars=3, accuracy=80) == []  # same song again: nothing twice
    for i in range(3):
        assert play(a, analysisId=f"{i}" * 64, maxCombo=5, stars=3, accuracy=80) == []
    assert {b["id"]: b["progress"] for b in mine(a)["locked"]}["songbird"] == {"have": 4, "need": 5}
    assert play(a, analysisId="c" * 64, maxCombo=5, stars=3, accuracy=80) == ["songbird"]  # 5th different song
    assert play(a, mode="party", maxCombo=30, stars=3, accuracy=80) == ["party-starter", "enchanted-streak"]
    assert play(a, mode="room", maxCombo=5, stars=5, accuracy=70) == ["ballroom-debut", "fairest-of-them-all"]
    assert play(a, maxCombo=100, stars=3, accuracy=80) == ["golden-goose", "hundred-year-spell"]
    clock[0] = LOCAL_MIDNIGHT + 3 * HOUR + 59 * 60_000  # 03:59 local
    assert play(a, maxCombo=5, stars=3, accuracy=80) == ["stroke-of-midnight"]

    got = mine(a)
    order = [r.badge.id for r in CATALOG]
    earned = [b["id"] for b in got["earned"]]
    assert earned == [i for i in order if i in earned]  # catalog order
    assert {b["earnedAt"] for b in got["earned"] if b["id"] == "first-dance"} == {NOON}
    progress = {b["id"]: b["progress"] for b in got["locked"]}
    assert progress["twelve-princesses"] == {"have": 10, "need": 12}
    assert progress["storybook-repertoire"] == {"have": 5, "need": 10}
    assert progress["royal-court"] == {"have": 0, "need": 3}
    assert progress["key-to-the-kingdom"] == {"have": 0, "need": 1}
    assert play(a, maxCombo=5, stars=3, accuracy=80) == []
    assert play(a, maxCombo=5, stars=3, accuracy=80) == ["twelve-princesses"]
    me_id = guest(a)["id"]
    rows = sql("select badge_id from df_badges where account_id = :me", me=me_id)
    assert len(rows) == len({r["badge_id"] for r in rows}) == len(mine(a)["earned"])


def test_accuracy_alone_is_a_perfect_run(backend: str, clock: list[int]) -> None:
    a = browser()
    guest(a)
    assert "fairest-of-them-all" in play(a, maxCombo=0, stars=4, accuracy=98)


def test_midnight_window_edges(backend: str) -> None:
    a = browser()
    me = guest(a)
    for at in (LOCAL_MIDNIGHT + 4 * HOUR, LOCAL_MIDNIGHT - 60_000):  # 04:00 and 23:59 local: not midnight
        sql(
            "insert into df_rounds (account_id, at, analysis_id, song_title, score, accuracy, max_combo, stars, mode)"
            " values (:me, :at, :aid, 'x', 1, 50, 0, 1, 'solo')",
            me=me["id"], at=at, aid="ab" * 32,
        )  # fmt: skip
    assert "stroke-of-midnight" not in [b["id"] for b in mine(a)["earned"]]
    sql(
        "insert into df_rounds (account_id, at, analysis_id, song_title, score, accuracy, max_combo, stars, mode)"
        " values (:me, :at, :aid, 'x', 1, 50, 0, 1, 'solo')",
        me=me["id"], at=LOCAL_MIDNIGHT, aid="ab" * 32,
    )  # fmt: skip
    assert "stroke-of-midnight" in [b["id"] for b in mine(a)["earned"]]


def test_social_rules(backend: str) -> None:
    a, b, c, d = browser(), browser(), browser(), browser()
    me_a, _ = friends(a, b)
    earned = lambda client: [x["id"] for x in mine(client)["earned"]]  # noqa: E731
    assert earned(a) == earned(b) == ["faithful-friend"]  # both sides of the friendship
    for other in (c, d):
        code = guest(other)["friendCode"]
        assert a.post("/api/friends", json={"code": code}, headers=H).status_code == 200
    assert "royal-court" in earned(a)

    named(c, "cinder")  # claiming the account
    assert "key-to-the-kingdom" in earned(c)

    for i in range(3):  # three different rooms played
        sql(
            "insert into df_room_members (room_key, account_id, room_code, player_id, at) values (:k, :me, 'ABCD', :p, 1)",
            k=f"ABCD:{i}", me=me_a["id"], p=f"p{i}",
        )  # fmt: skip
    progress = {x["id"]: x["progress"] for x in mine(a)["locked"]}
    assert "belle-of-the-ball" not in progress and "belle-of-the-ball" in earned(a)
    assert a.get("/api/me/badges").json() == mine(a)  # reading again awards nothing new
