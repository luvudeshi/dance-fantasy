"""AI endpoints (announcer) and app.ai: prompts, reply parsing, fallbacks. No network:
providers either have no key or point at a closed local port, so every path runs for real and fails fast."""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
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
    line_id,
    parse_lines,
)
from app.ai.provider import AIUnavailable, generate_text
from app.api import announcer as announcer_api
from app.analysis_store import AnalysisStore
from app.config import REPO_ROOT, get_settings
from app.main import app
from app.moves.library import load_library

CLOSED_PORT = "http://127.0.0.1:9"  # discard port: nothing listens, so connects are refused at once
LIBRARY = load_library(REPO_ROOT / "assets" / "moves")


@pytest.fixture(autouse=True)
def _no_ai_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("MUSE_API_KEY", "MUSE_BASE_URL", "MUSE_TEXT_MODEL", "GEMINI_API_KEY", "GEMINI_TEXT_MODEL",
                 "SERPAPI_API_KEY", "AI_PROVIDER"):  # fmt: skip
        monkeypatch.delenv(name, raising=False)
    announcer_api._cache.clear()
    announcer_api._line_hits.clear()


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


def test_canned_lines_open_with_a_recorded_line_when_there_is_one() -> None:
    combo = "The ballroom ERUPTS! 10 in a row, Your Highness!"
    tier = prompts.RESULTS_BY_TIER["high"][-1]
    for _ in range(30):
        assert canned_lines("combo", {"song": "S", "combo": "10"}, {line_id(combo)}) == [combo]
        assert canned_lines("results", {"song": "S", "stars": "5"}, {line_id(tier)})[0] == tier


def test_parse_lines_tolerates_fences_and_cleans_up() -> None:
    raw = '```json\n{"lines": ["  \\"Bravo!\\"  ", 42, "", "Hear ye, hear-ye!", "' + "a " * 80 + '", "four", "five"]}\n```'
    lines = parse_lines(raw)
    assert lines[0] == "Bravo!" and len(lines) == 3
    assert not any("hear" in line.lower() for line in lines)  # "hear ye" is dropped: voiced, it sounds rude
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


def test_generate_text_retries_a_provider_that_fails_instantly(monkeypatch: pytest.MonkeyPatch) -> None:
    hits: list[str] = []

    class Flaky(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.rfile.read(int(self.headers["Content-Length"]))
            hits.append(self.path)
            ok = len(hits) > 2  # the first two answers are Muse's flaky 404s
            body = json.dumps({"choices": [{"message": {"content": '{"lines": ["Bravo!"]}'}}]} if ok else {"error": {"code": "model_not_found"}})
            self.send_response(200 if ok else 404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Flaky)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv("MUSE_API_KEY", "test-key")
        monkeypatch.setenv("MUSE_BASE_URL", f"http://127.0.0.1:{server.server_port}/v1")
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        text, provider = generate_text("system", "user", deadline_sec=5.0, json_mode=True)
        assert provider == "muse" and "Bravo!" in text and len(hits) == 3
    finally:
        server.shutdown()


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


def test_song_files_still_route(client: TestClient) -> None:
    assert client.get("/api/songs").status_code == 200
    assert client.get("/api/songs/nope.wav").status_code == 404
