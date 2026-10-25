"""Accounts against a real database: SQLite always, plus Postgres when DATABASE_URL is set (a scratch DB).

Each TestClient is one browser (its own cookie jar). Time-based rules (presence, invite expiry,
streaks) are exercised by moving timestamps back in the database, like the rooms tests do.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.accounts import store
from app.accounts.store import DAY, MIN, transaction
from app.config import get_settings
from app.main import app
from app.rooms.db import Tx

BACKENDS = ["sqlite"] + (["postgres"] if os.environ.get("DATABASE_URL") else [])
H = {"X-DF": "1"}
ROUND = {
    "analysisId": "ab" * 32,
    "songTitle": "Vibe Ace",
    "score": 12_000,
    "accuracy": 81.5,
    "maxCombo": 40,
    "stars": 4,
    "mode": "solo",
}


@pytest.fixture(params=BACKENDS)
def backend(request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))  # SQLite file lands in tmp_path/cache
    if request.param == "sqlite":
        monkeypatch.delenv("DATABASE_URL", raising=False)
    get_settings.cache_clear()
    yield str(request.param)
    get_settings.cache_clear()


def browser() -> TestClient:
    return TestClient(app)


def sql(statement: str, **params: Any) -> list[dict[str, Any]]:
    def run(tx: Tx) -> list[dict[str, Any]]:
        if statement.lstrip().lower().startswith("select"):
            return tx.all(statement, **params)
        tx.run(statement, **params)
        return []

    return transaction(run)


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def guest(client: TestClient) -> dict[str, Any]:
    r = client.post("/api/session", headers=H)
    assert r.status_code == 200, r.text
    return dict(r.json())


def named(client: TestClient, username: str, password: str = "correct horse") -> dict[str, Any]:
    guest(client)
    r = client.post("/api/account/claim", json={"username": username, "password": password}, headers=H)
    assert r.status_code == 200, r.text
    return dict(r.json())


def friends(a: TestClient, b: TestClient) -> tuple[dict[str, Any], dict[str, Any]]:
    me_a, me_b = guest(a), guest(b)
    assert a.post("/api/friends", json={"code": me_b["friendCode"]}, headers=H).status_code == 200
    return me_a, me_b


# --- sessions -------------------------------------------------------------------------------------


def test_guest_bootstrap_is_idempotent(backend: str) -> None:
    a = browser()
    assert a.get("/api/me").status_code == 401
    r = a.post("/api/session", headers=H)
    assert r.status_code == 200, r.text
    me = r.json()
    token = a.cookies["df_session"]
    assert me["isGuest"] is True and me["username"] is None
    assert re.fullmatch(r"[A-HJKMNP-Z2-9]{6}", me["friendCode"])
    assert me["avatar"] in store.GUEST_AVATARS and me["color"] in store.COLORS
    assert 1 <= len(me["name"]) <= 24
    assert me["stats"] == {"rounds": 0, "bestScore": 0, "friends": 0}

    again = a.post("/api/session", headers=H)
    assert again.json()["id"] == me["id"] and a.cookies["df_session"] == token
    assert a.get("/api/me").json()["id"] == me["id"]
    assert guest(browser())["id"] != me["id"]

    # only the token's sha256 is stored
    rows = sql("select token_hash from df_sessions where account_id = :id", id=me["id"])
    assert rows == [{"token_hash": hashlib.sha256(token.encode()).hexdigest()}]

    # an unknown or junk cookie gets a fresh guest instead of an error
    b = browser()
    b.cookies.set("df_session", "x" * 500)
    assert b.get("/api/me").status_code == 401
    assert guest(b)["id"] != me["id"]


def test_cookie_flags(backend: str) -> None:
    r = browser().post("/api/session", headers=H)
    cookie = r.headers["set-cookie"]
    assert cookie.startswith("df_session=")
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie
    assert f"Max-Age={180 * 24 * 3600}" in cookie
    assert "Secure" not in cookie

    secure = TestClient(app, base_url="https://testserver").post("/api/session", headers=H)
    assert "Secure" in secure.headers["set-cookie"]
    proxied = browser().post("/api/session", headers={**H, "X-Forwarded-Proto": "https"})
    assert "Secure" in proxied.headers["set-cookie"]


def test_mutations_need_the_csrf_header(backend: str) -> None:
    a = browser()
    assert a.post("/api/session").status_code == 403
    assert a.post("/api/session", headers={"X-DF": "0"}).status_code == 403
    guest(a)
    assert a.get("/api/me").status_code == 200  # reads don't need it
    assert a.patch("/api/me", json={"name": "Ana"}).status_code == 403
    assert a.post("/api/logout").status_code == 403
    assert a.post("/api/friends", json={"code": "ABCDEF"}).status_code == 403
    assert a.get("/api/me").json()["name"] != "Ana"


# --- login ----------------------------------------------------------------------------------------


def test_claim_login_logout(backend: str) -> None:
    a = browser()
    me = guest(a)
    guest_token = a.cookies["df_session"]
    r = a.post("/api/account/claim", json={"username": " Ana_B ", "password": "correct horse"}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == me["id"] and r.json()["isGuest"] is False and r.json()["username"] == "ana_b"
    assert a.cookies["df_session"] != guest_token  # rotated on claim
    stale = browser()
    stale.cookies.set("df_session", guest_token)
    assert stale.get("/api/me").status_code == 401

    stored = sql("select pw_hash from df_accounts where id = :id", id=me["id"])[0]["pw_hash"]
    assert stored.startswith("scrypt$") and "correct horse" not in stored

    again = a.post("/api/account/claim", json={"username": "ana_c", "password": "correct horse"}, headers=H)
    assert again.status_code == 409
    b = browser()
    guest(b)
    taken = b.post("/api/account/claim", json={"username": "ANA_B", "password": "another one"}, headers=H)
    assert taken.status_code == 409 and "taken" in taken.json()["detail"]

    for bad in (
        {"username": "ab", "password": "correct horse"},
        {"username": "a" * 21, "password": "correct horse"},
        {"username": "ana-b", "password": "correct horse"},
        {"username": "anab", "password": "short"},
        {"username": "anab", "password": "correct horse", "admin": True},
    ):
        assert b.post("/api/account/claim", json=bad, headers=H).status_code == 400, bad

    out = a.post("/api/logout", headers=H)
    assert out.status_code == 200 and out.json()["isGuest"] is True and out.json()["id"] != me["id"]
    assert a.get("/api/me").json()["id"] == out.json()["id"]

    back = a.post("/api/login", json={"username": "ana_b", "password": "correct horse"}, headers=H)
    assert back.status_code == 200 and back.json()["id"] == me["id"]
    elsewhere = browser()  # a second browser, no guest session first
    r = elsewhere.post("/api/login", json={"username": "ana_b", "password": "correct horse"}, headers=H)
    assert r.status_code == 200 and elsewhere.get("/api/me").json()["id"] == me["id"]
    assert a.get("/api/me").json()["id"] == me["id"]  # both browsers stay logged in


def test_wrong_password_is_rate_limited(backend: str, monkeypatch: pytest.MonkeyPatch) -> None:
    named(browser(), "bella")
    c = browser()
    wrong = {"username": "bella", "password": "not the password"}
    for _ in range(5):
        r = c.post("/api/login", json=wrong, headers=H)
        assert r.status_code == 401 and r.json()["detail"] == "Wrong username or password."
    locked = c.post("/api/login", json={"username": "bella", "password": "correct horse"}, headers=H)
    assert locked.status_code == 429  # even the right password waits out the lock
    assert c.post("/api/login", json={"username": "nobody", "password": "whatever1"}, headers=H).status_code == 401

    # per IP-ish key, across usernames
    monkeypatch.setattr(store, "LOGIN_IP_LIMIT", (3, 15 * MIN))
    named(browser(), "carla")
    d = browser()
    ip = {**H, "X-Forwarded-For": "203.0.113.9, 10.0.0.1"}
    for user in ("u_one", "u_two", "u_three"):
        assert d.post("/api/login", json={"username": user, "password": "whatever1"}, headers=ip).status_code == 401
    assert d.post("/api/login", json={"username": "carla", "password": "correct horse"}, headers=ip).status_code == 429
    other_ip = {**H, "X-Forwarded-For": "198.51.100.7"}
    r = d.post("/api/login", json={"username": "carla", "password": "correct horse"}, headers=other_ip)
    assert r.status_code == 200


# --- profile --------------------------------------------------------------------------------------


def test_profile_patch_and_validation(backend: str) -> None:
    a = browser()
    me = guest(a)
    r = a.patch("/api/me", json={"name": "  Zoë \n the  Brave ", "avatar": "dance-shoe", "color": "night"}, headers=H)
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["avatar"], r.json()["color"]) == ("Zoë the Brave", "dance-shoe", "night")
    r = a.patch("/api/me", json={"color": "sage"}, headers=H)
    assert (r.json()["name"], r.json()["color"]) == ("Zoë the Brave", "sage")
    assert r.json()["friendCode"] == me["friendCode"]

    for bad in (
        {"avatar": "skull"},
        {"avatar": "../../etc/passwd"},
        {"color": "#ff0000"},
        {"name": ""},
        {"name": "x" * 25},
        {"name": "a\x00b"},
        {"friendCode": "AAAAAA"},
        {"isGuest": False},
    ):
        assert a.patch("/api/me", json=bad, headers=H).status_code == 400, bad
    assert a.get("/api/me").json()["color"] == "sage"


# --- friends --------------------------------------------------------------------------------------


def test_friends_by_code(backend: str) -> None:
    a, b, c = browser(), browser(), browser()
    me_a, me_b, me_c = guest(a), guest(b), guest(c)
    typed = me_b["friendCode"].lower()[:3] + "-" + me_b["friendCode"].lower()[3:]
    r = a.post("/api/friends", json={"code": typed}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "id": me_b["id"], "name": me_b["name"], "avatar": me_b["avatar"], "color": me_b["color"],
        "online": True, "inRoom": None,
    }  # fmt: skip
    assert [f["id"] for f in b.get("/api/friends").json()] == [me_a["id"]]  # mutual
    assert a.get("/api/me").json()["stats"]["friends"] == 1

    assert a.post("/api/friends", json={"code": me_b["friendCode"]}, headers=H).status_code == 409
    assert b.post("/api/friends", json={"code": me_a["friendCode"]}, headers=H).status_code == 409
    assert a.post("/api/friends", json={"code": me_a["friendCode"]}, headers=H).status_code == 400
    assert a.post("/api/friends", json={"code": "ILO01X"}, headers=H).status_code == 400  # ambiguous letters
    assert a.post("/api/friends", json={"code": me_c["friendCode"]}, headers=H).status_code == 200
    names = sorted([me_b["name"], me_c["name"]], key=str.casefold)
    assert [f["name"] for f in a.get("/api/friends").json()] == names

    assert a.delete(f"/api/friends/{me_b['id']}", headers=H).status_code == 200
    assert b.get("/api/friends").json() == []
    assert [f["id"] for f in a.get("/api/friends").json()] == [me_c["id"]]
    assert a.delete(f"/api/friends/{me_b['id']}", headers=H).status_code == 404
    assert a.delete("/api/friends/bad%20id", headers=H).status_code == 400


def test_unknown_friend_codes_are_rate_limited(backend: str) -> None:
    a, b = browser(), browser()
    guest(a)
    code_b = guest(b)["friendCode"]
    for code in ("AAAAAA", "BBBBBB", "CCCCCC", "DDDDDD", "EEEEEE", "FFFFFF", "GGGGGG", "HHHHHH", "JJJJJJ", "KKKKKK"):
        assert a.post("/api/friends", json={"code": code}, headers=H).status_code == 404  # 1 in ~10^8 to be real
    assert a.post("/api/friends", json={"code": code_b}, headers=H).status_code == 429


def test_presence_and_heartbeat(backend: str) -> None:
    a, b = browser(), browser()
    _, me_b = friends(a, b)
    assert a.get("/api/friends").json()[0]["online"] is True
    sql("update df_accounts set seen_at = seen_at - :ms where id = :id", ms=2 * MIN, id=me_b["id"])
    assert a.get("/api/friends").json()[0]["online"] is False
    assert b.post("/api/me/heartbeat", headers=H).json() == {"ok": True}
    assert a.get("/api/friends").json()[0]["online"] is True
    sql("update df_accounts set seen_at = seen_at - :ms where id = :id", ms=2 * MIN, id=me_b["id"])
    assert b.get("/api/me").status_code == 200  # any authenticated call counts
    assert a.get("/api/friends").json()[0]["online"] is True


# --- invites --------------------------------------------------------------------------------------


def test_invites(backend: str) -> None:
    a, b, c = browser(), browser(), browser()
    me_a, me_b = friends(a, b)
    me_c = guest(c)
    room = a.post("/api/rooms", json={"name": "Ana"}).json()["code"]

    r = a.post(f"/api/friends/{me_b['id']}/invite", json={"roomCode": room.lower()}, headers=H)
    assert r.status_code == 200, r.text
    assert a.post(f"/api/friends/{me_b['id']}/invite", json={"roomCode": room}, headers=H).status_code == 200
    invites = b.get("/api/me/invites").json()
    assert len(invites) == 1  # re-inviting renews instead of stacking
    inv = invites[0]
    assert (inv["fromId"], inv["fromName"], inv["fromAvatar"], inv["fromColor"], inv["roomCode"]) == (
        me_a["id"], me_a["name"], me_a["avatar"], me_a["color"], room,
    )  # fmt: skip
    assert a.get("/api/me/invites").json() == []

    assert a.post(f"/api/friends/{me_c['id']}/invite", json={"roomCode": room}, headers=H).status_code == 404
    assert a.post(f"/api/friends/{me_b['id']}/invite", json={"roomCode": "ZZZZ"}, headers=H).status_code == 404
    assert a.post(f"/api/friends/{me_b['id']}/invite", json={"roomCode": "toolongcode"}, headers=H).status_code == 400

    assert c.post(f"/api/me/invites/{inv['id']}/dismiss", headers=H).status_code == 404  # not yours
    assert b.post(f"/api/me/invites/{inv['id']}/dismiss", headers=H).status_code == 200
    assert b.get("/api/me/invites").json() == []

    a.post(f"/api/friends/{me_b['id']}/invite", json={"roomCode": room}, headers=H)
    assert len(b.get("/api/me/invites").json()) == 1
    sql("update df_invites set at = at - :ms", ms=11 * MIN)
    assert b.get("/api/me/invites").json() == []  # expired after 10 minutes


def test_invites_are_rate_limited(backend: str) -> None:
    a, b = browser(), browser()
    me_a, me_b = friends(a, b)
    room = a.post("/api/rooms", json={"name": "Ana"}).json()["code"]
    now = now_ms()
    for i in range(store.INVITE_LIMIT[0]):
        sql("insert into df_invites (from_id, to_id, room_code, at) values (:a, :b, :code, :at)",
            a=me_a["id"], b=me_b["id"], code=f"Q{i:03d}", at=now - i)  # fmt: skip
    r = a.post(f"/api/friends/{me_b['id']}/invite", json={"roomCode": room}, headers=H)
    assert r.status_code == 429


# --- rooms played: partners and "in a room" ------------------------------------------------------


def test_partners_and_in_room(backend: str) -> None:
    a, b, c = browser(), browser(), browser()
    me_a, me_b, me_c = guest(a), guest(b), guest(c)
    host = a.post("/api/rooms", json={"name": "Ana"}).json()
    room = host["code"]
    joined = b.post(f"/api/rooms/{room}/join", json={"name": "Bo"}).json()
    other_room = c.post("/api/rooms", json={"name": "Cy"}).json()

    assert a.post("/api/me/rooms", json={"roomCode": room, "playerToken": host["token"]}, headers=H).status_code == 200
    assert b.post("/api/me/rooms", json={"roomCode": room, "playerToken": joined["token"]}, headers=H).status_code == 200
    # tokens are checked against the rooms store
    bad = c.post("/api/me/rooms", json={"roomCode": room, "playerToken": other_room["token"]}, headers=H)
    assert bad.status_code == 401
    assert c.post("/api/me/rooms", json={"roomCode": "ZZZZ", "playerToken": "x"}, headers=H).status_code == 404
    assert c.post("/api/me/rooms", json={"roomCode": room}, headers=H).status_code == 400

    partners = a.get("/api/me/partners").json()
    assert [(p["id"], p["isFriend"], p["friendCode"]) for p in partners] == [(me_b["id"], False, me_b["friendCode"])]
    assert [p["id"] for p in b.get("/api/me/partners").json()] == [me_a["id"]]
    assert c.get("/api/me/partners").json() == []

    assert a.post("/api/friends", json={"code": partners[0]["friendCode"]}, headers=H).status_code == 200
    assert a.get("/api/me/partners").json()[0]["isFriend"] is True
    assert a.get("/api/friends").json()[0]["inRoom"] == room  # B is connected to that room
    assert b.post(f"/api/rooms/{room}/leave", headers={"X-Player-Token": joined["token"]}).status_code == 200
    assert a.get("/api/friends").json()[0]["inRoom"] is None


# --- history --------------------------------------------------------------------------------------


def test_rounds_and_history(backend: str) -> None:
    a = browser()
    me = guest(a)
    assert a.get("/api/me/history").json() == {
        "rounds": [], "totalRounds": 0, "bestScore": 0, "avgAccuracy": 0.0, "dayStreak": 0,
    }  # fmt: skip
    for bad in (
        {**ROUND, "analysisId": "nope"},
        {**ROUND, "stars": 6},
        {**ROUND, "mode": "teach"},
        {**ROUND, "accuracy": 101},
        {**ROUND, "score": -1},
        {**ROUND, "songTitle": ""},
        {**ROUND, "extra": 1},
    ):
        assert a.post("/api/me/rounds", json=bad, headers=H).status_code == 400, bad

    assert a.post("/api/me/rounds", json=ROUND, headers=H).status_code == 200
    second = {**ROUND, "score": 30_000, "accuracy": 90.5, "stars": 4.5, "mode": "room", "songTitle": "  Two  Step "}
    assert a.post("/api/me/rounds", json=second, headers=H).status_code == 200
    h = a.get("/api/me/history").json()
    assert [r["score"] for r in h["rounds"]] == [30_000, 12_000]  # newest first
    assert (h["rounds"][0]["songTitle"], h["rounds"][0]["mode"], h["rounds"][0]["stars"]) == ("Two Step", "room", 4.5)
    assert (h["totalRounds"], h["bestScore"], h["avgAccuracy"], h["dayStreak"]) == (2, 30_000, 86.0, 1)
    assert a.get("/api/me").json()["stats"] == {"rounds": 2, "bestScore": 30_000, "friends": 0}

    # two earlier days in a row, then a gap: streak 3
    for days_ago in (1, 2, 4):
        sql("insert into df_rounds (account_id, at, analysis_id, song_title, score, accuracy, max_combo, stars, mode)"
            " values (:id, :at, :aid, 'Old', 10, 50, 1, 1, 'solo')",
            id=me["id"], at=now_ms() - days_ago * DAY, aid="cd" * 32)  # fmt: skip
    h = a.get("/api/me/history", params={"tzOffset": 0}).json()
    assert h["totalRounds"] == 5 and h["dayStreak"] == 3
    assert a.get("/api/me/history", params={"tzOffset": 900}).status_code == 400
    assert guest(browser())["id"] != me["id"]  # nobody else sees these
    other = browser()
    guest(other)
    assert other.get("/api/me/history").json()["totalRounds"] == 0


def test_day_streak() -> None:
    assert store.day_streak(set(), 100) == 0
    assert store.day_streak({100}, 100) == 1
    assert store.day_streak({99, 98}, 100) == 2  # nothing yet today: yesterday's streak still counts
    assert store.day_streak({100, 99, 97}, 100) == 2
    assert store.day_streak({98}, 100) == 0
