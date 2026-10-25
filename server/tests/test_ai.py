"""AI endpoints (announcer, signature dance) and app.ai: prompts, reply parsing, fallbacks. No network:
providers either have no key or point at a closed local port, so every path runs for real and fails fast."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.ai import prompts
from app.ai.prompts import (
    CANNED,
    MAX_LINE,
    announcer_details,
    announcer_user,
    canned_lines,
    clip,
    filter_move_ids,
    move_id_lookup,
    parse_lines,
    parse_signature,
    signature_user,
)
from app.ai.provider import AIUnavailable, generate_text
from app.api import announcer as announcer_api
from app.api import signature as signature_api
from app.api.signature import KeyMoment, Signature, _cache_path, google_hits, youtube_hits
from app.config import REPO_ROOT, get_settings
from app.main import app
from app.moves.library import load_library

CLOSED_PORT = "http://127.0.0.1:9"  # discard port: nothing listens, so connects are refused at once
LIBRARY = load_library(REPO_ROOT / "assets" / "moves")
LOOKUP = move_id_lookup(LIBRARY.moves)


@pytest.fixture(autouse=True)
def _no_ai_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("MUSE_API_KEY", "MUSE_BASE_URL", "MUSE_TEXT_MODEL", "GEMINI_API_KEY", "GEMINI_TEXT_MODEL",
                 "SERPAPI_API_KEY", "AI_PROVIDER"):  # fmt: skip
        monkeypatch.delenv(name, raising=False)
    announcer_api._cache.clear()


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    (tmp_path / "moves").symlink_to(REPO_ROOT / "assets" / "moves")
    (tmp_path / "songs").mkdir()
    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield TestClient(app)
    get_settings.cache_clear()


# ---- text helpers --------------------------------------------------------------------------------


def test_clip_cuts_at_a_word_with_an_ellipsis() -> None:
    assert clip("short", 10) == "short"
    out = clip("The prince dropped his crown in the middle of the ballroom", 30)
    assert len(out) <= 30 and out.endswith("…") and not out[:-1].endswith(" ")
    assert out[:-1] == "The prince dropped his crown"


# ---- announcer -----------------------------------------------------------------------------------


def test_announcer_details_formats_numbers_and_drops_missing() -> None:
    details = announcer_details(
        {"songTitle": "  Vibe\nAce ", "playerName": None, "score": 84210, "accuracy": 87.4, "stars": 3.6, "combo": 0}
    )
    assert details == {"song": "Vibe Ace", "score": "84,210", "accuracy": "87%", "stars": "4", "combo": "0"}


def test_announcer_user_carries_event_and_details_as_json() -> None:
    doc = json.loads(announcer_user("combo", {"song": "Vibe Ace", "combo": "12"}))
    assert doc["event"] == "combo" and doc["details"] == {"song": "Vibe Ace", "combo": "12"}
    assert "combo" in doc["whatHappened"]


@pytest.mark.parametrize("event", list(CANNED))
def test_canned_lines_always_have_something_to_say(event: prompts.AnnouncerEvent) -> None:
    for details in ({"song": "Vibe Ace"}, announcer_details({"songTitle": "x" * 200, "playerName": "Ella" * 10,
                                                              "score": 10**9, "combo": 99999, "maxCombo": 99999,
                                                              "accuracy": 100, "stars": 5, "grade": "g" * 40,
                                                              "bestMove": "b" * 80, "hardestMove": "h" * 80})):  # fmt: skip
        for _ in range(20):
            lines = canned_lines(event, details)
            assert 1 <= len(lines) <= 3 and len(set(lines)) == len(lines)
            assert all(0 < len(line) <= MAX_LINE and "{" not in line for line in lines)


def test_canned_lines_skip_templates_needing_missing_fields() -> None:
    seen = {line for _ in range(200) for line in canned_lines("combo", {"song": "S"})}
    assert len(seen) >= 3  # varied
    assert not any(ch.isdigit() for line in seen for ch in line)  # no {combo} without a combo


def test_parse_lines_tolerates_fences_and_cleans_up() -> None:
    raw = '```json\n{"lines": ["  \\"Hear ye!\\"  ", 42, "", "' + "a " * 80 + '", "four", "five"]}\n```'
    lines = parse_lines(raw)
    assert lines[0] == "Hear ye!" and len(lines) == 3
    assert all(len(line) <= MAX_LINE for line in lines)
    assert parse_lines("no json here") == [] and parse_lines('{"lines": "nope"}') == [] and parse_lines("{oops}") == []


def test_announcer_endpoint_without_keys_is_canned_and_cached(client: TestClient) -> None:
    body = {"event": "results", "context": {"songTitle": "Vibe Ace", "score": 1234, "stars": 4, "unknown": 1}}
    first = client.post("/api/announcer", json=body)
    assert first.status_code == 200
    reply = first.json()
    assert reply["source"] == "canned" and len(reply["lines"]) == 3
    assert all(client.post("/api/announcer", json=body).json() == reply for _ in range(5))  # cache, not chance


def test_announcer_endpoint_rejects_bad_input(client: TestClient) -> None:
    assert client.post("/api/announcer", json={"event": "nope", "context": {"songTitle": "S"}}).status_code == 400
    assert client.post("/api/announcer", json={"event": "intro", "context": {}}).status_code == 400
    assert client.post("/api/announcer", json={"event": "intro", "context": {"songTitle": "S", "stars": 9}}).status_code == 400


def test_announcer_falls_back_fast_when_providers_fail(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MUSE_API_KEY", "test-key")
    monkeypatch.setenv("MUSE_BASE_URL", CLOSED_PORT)
    started = time.monotonic()
    r = client.post("/api/announcer", json={"event": "intro", "context": {"songTitle": "Vibe Ace"}})
    assert time.monotonic() - started < 2.5
    assert r.status_code == 200 and r.json()["source"] == "canned"


# ---- provider ------------------------------------------------------------------------------------


def test_generate_text_without_keys_raises() -> None:
    with pytest.raises(AIUnavailable, match="no AI provider key"):
        generate_text("system", "user", deadline_sec=1)


def test_generate_text_logs_failures_but_never_the_prompt(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("MUSE_API_KEY", "secret-muse-key")
    monkeypatch.setenv("MUSE_BASE_URL", CLOSED_PORT)
    with caplog.at_level(logging.INFO), pytest.raises(AIUnavailable, match="no AI provider answered"):
        generate_text("SYSTEM-PROMPT", "PLAYER-SECRET", deadline_sec=2)
    assert "provider=muse ok=false" in caplog.text
    for secret in ("SYSTEM-PROMPT", "PLAYER-SECRET", "secret-muse-key"):
        assert secret not in caplog.text


# ---- signature dance -----------------------------------------------------------------------------


def test_move_ids_are_validated_mapped_and_deduped() -> None:
    assert "floss_R" in LOOKUP.values()
    ids = filter_move_ids(["floss_R", "FLOSS_R", "floss", "made_up_move", 7, " dab_R "], LOOKUP)
    assert ids[0] == "floss_R" and "dab_R" in ids and "made_up_move" not in ids
    assert len(ids) == len(set(ids)) and all(i in {m.id for m in LIBRARY.moves} for i in ids)
    assert filter_move_ids("floss_R", LOOKUP) == []
    assert len(filter_move_ids([m.id for m in LIBRARY.moves], LOOKUP)) == prompts.MAX_MOVE_IDS


def test_parse_signature_validates_every_field() -> None:
    raw = json.dumps({
        "found": True,
        "summary": "Arms swing side to side while the hips sway. " * 30,
        "keyMoments": [{"label": "Chorus floss", "approxTimeSec": 42.04}, {"label": "Bad time", "approxTimeSec": -3},
                       {"label": ""}, "nope", {"label": "Pose", "approxTimeSec": True}],
        "suggestedMoveIds": ["floss_R", "nope", "hip_sway_R"],
    })  # fmt: skip
    out = parse_signature(f"Here you go: {raw} Enjoy!", LOOKUP)
    assert out is not None and out["found"] is True
    assert len(out["summary"]) <= prompts.MAX_SUMMARY
    assert out["keyMoments"] == [{"label": "Chorus floss", "approxTimeSec": 42.0}, {"label": "Bad time"}, {"label": "Pose"}]
    assert out["suggestedMoveIds"] == ["floss_R", "hip_sway_R"]
    assert parse_signature("not json", LOOKUP) is None
    empty = parse_signature('{"found": true, "summary": ""}', LOOKUP)
    assert empty == {"found": False, "summary": "", "keyMoments": [], "suggestedMoveIds": []}


def test_signature_user_lists_hits_and_base_moves_only() -> None:
    hits = [prompts.Hit(title="Cupid dance", link="https://x.test/a", snippet="s" * 1000, source="TikTok", thumbnail=None)]
    text = signature_user("Cupid", "FIFTY FIFTY", hits, LIBRARY.moves)
    assert "Song: Cupid by FIFTY FIFTY" in text and "1. [TikTok] Cupid dance: " in text
    assert "floss_R: The Floss Right [hiphop, pop;" in text and "floss_L:" not in text  # mirrors left out
    assert "s" * 400 not in text  # snippets clipped


def test_search_result_parsing_keeps_only_safe_links() -> None:
    google = {
        "inline_videos": [{"title": "Cupid challenge", "link": "https://www.tiktok.com/@a/video/1", "platform": "TikTok",
                           "thumbnail": "https://img.test/1.jpg"}],
        "organic_results": [{"title": "Cupid dance tutorial", "link": "https://www.example.com/cupid", "snippet": "Steps",
                             "thumbnail": "data:image/png;base64,AAAA"},
                            {"title": "Bad", "link": "javascript:alert(1)"}, {"title": "", "link": "https://x.test"}, "junk"],
    }  # fmt: skip
    hits = google_hits(google)
    assert [h["link"] for h in hits] == ["https://www.tiktok.com/@a/video/1", "https://www.example.com/cupid"]
    assert hits[0]["source"] == "TikTok" and hits[0]["thumbnail"] == "https://img.test/1.jpg"
    assert hits[1]["source"] == "example.com" and hits[1]["thumbnail"] is None
    yt = youtube_hits({"video_results": [{"title": "Cupid Dance Tutorial", "link": "https://www.youtube.com/watch?v=1",
                                          "description": "Learn it", "thumbnail": {"static": "https://i.ytimg.com/1.jpg"}}]})  # fmt: skip
    assert yt == [prompts.Hit(title="Cupid Dance Tutorial", link="https://www.youtube.com/watch?v=1", snippet="Learn it",
                              source="YouTube", thumbnail="https://i.ytimg.com/1.jpg")]  # fmt: skip
    assert google_hits(None) == [] and youtube_hits({"video_results": "nope"}) == []


def test_signature_endpoint_needs_keys(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    r = client.get("/api/songs/signature", params={"title": "Cupid", "artist": "FIFTY FIFTY"})
    assert r.status_code == 404 and "SERPAPI_API_KEY" in r.json()["detail"]  # our 404, not /songs/{file}'s
    monkeypatch.setenv("SERPAPI_API_KEY", "test-key")
    assert client.get("/api/songs/signature", params={"title": "Cupid"}).status_code == 404  # no LLM key yet
    assert client.get("/api/songs/signature").status_code == 400
    assert client.get("/api/songs/signature", params={"title": "   "}).status_code == 400


def test_signature_endpoint_serves_the_cache_and_rechecks_move_ids(client: TestClient) -> None:
    cached = Signature(
        found=True, summary="Hands make a heart, then the hips sway.", keyMoments=[KeyMoment(label="Heart hands")],
        suggestedMoveIds=["hip_sway_R", "removed_move"], sources=[],
    )  # fmt: skip
    path = _cache_path(get_settings().cache_dir, "Cupid", "FIFTY FIFTY")
    path.parent.mkdir(parents=True)
    path.write_text(cached.model_dump_json(exclude_none=True))
    r = client.get("/api/songs/signature", params={"title": " Cupid ", "artist": "FIFTY FIFTY"})  # no keys: cache only
    assert r.status_code == 200
    assert r.json() == {"found": True, "summary": cached.summary, "keyMoments": [{"label": "Heart hands"}],
                        "suggestedMoveIds": ["hip_sway_R"], "sources": []}  # fmt: skip
    path.write_text("{broken")
    assert client.get("/api/songs/signature", params={"title": "Cupid", "artist": "FIFTY FIFTY"}).status_code == 404


def test_song_files_still_route(client: TestClient) -> None:
    assert client.get("/api/songs").status_code == 200
    assert client.get("/api/songs/nope.wav").status_code == 404


def test_signature_paid_lookups_are_capped_per_hour(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(signature_api, "_fresh", signature_api.deque())
    for _ in range(signature_api.FRESH_PER_HOUR):
        signature_api.spend_lookup(now=100.0)
    with pytest.raises(HTTPException) as exc:
        signature_api.spend_lookup(now=200.0)
    assert exc.value.status_code == 429
    signature_api.spend_lookup(now=100.0 + 3600)  # an hour later the window has room again
