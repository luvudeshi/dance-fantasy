"""Announcer voice: line ids, the known-line store, the WAV cache, PCM -> WAV and the voice route's limits.
No network: GEMINI_API_KEY is unset, so every request is answered from the cache, as a 404, 429 or 503."""

from __future__ import annotations

import io
import json
import wave
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.ai.prompts import CANNED, CANNED_BY_ID, COMBO_MILESTONES, MAX_LINE, line_id
from app.ai.voice import (
    DEFAULT_VOICE,
    LEAD_PAD_SEC,
    TAIL_PAD_SEC,
    TTS_MODELS,
    known_text,
    pcm_to_wav,
    remember,
    sample_rate,
    to_pcm,
    trim_silence,
    wav_path,
)
from app.api import announcer as announcer_api
from app.config import REPO_ROOT, get_settings
from app.main import app


@pytest.fixture(autouse=True)
def _no_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("MUSE_API_KEY", "GEMINI_API_KEY", "GEMINI_TTS_VOICE", "AI_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
    announcer_api._cache.clear()
    announcer_api._hits.clear()


@pytest.fixture
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    (tmp_path / "moves").symlink_to(REPO_ROOT / "assets" / "moves")
    (tmp_path / "songs").mkdir()
    monkeypatch.setenv("ASSETS_DIR", str(tmp_path))
    get_settings.cache_clear()
    yield get_settings().cache_dir
    get_settings.cache_clear()


@pytest.fixture
def client(cache_dir: Path) -> TestClient:
    return TestClient(app)


def _wav(cache_dir: Path, lid: str, model: str = TTS_MODELS[0]) -> bytes:
    data = pcm_to_wav(b"\x01\x00" * 2400)
    path = wav_path(cache_dir, lid, DEFAULT_VOICE, model)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


# ---- ids and the line store ----------------------------------------------------------------------


def test_fixed_canned_lines_have_stable_known_ids() -> None:
    fixed = [t for bank in CANNED.values() for t in bank if "{" not in t]
    assert all(CANNED_BY_ID[line_id(t)] == t for t in fixed)
    assert CANNED_BY_ID[line_id("The ballroom ERUPTS! 10 in a row, Your Highness!")]  # count lines at milestones
    assert len(CANNED_BY_ID) >= len(fixed) + 4 * len(COMBO_MILESTONES)
    assert all(len(t) <= MAX_LINE and len(t) <= 80 for t in CANNED_BY_ID.values())
    assert line_id("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"  # sha256, as the web hashes it


def test_canned_bank_has_a_dozen_lines_per_event() -> None:
    assert all(len(bank) >= 12 for bank in CANNED.values())


def test_announcer_returns_ids_and_remembers_the_lines_it_gave_out(client: TestClient, cache_dir: Path) -> None:
    body = {"event": "results", "context": {"songTitle": "Vibe Ace", "playerName": "Ella", "score": 1234, "stars": 4}}
    reply = client.post("/api/announcer", json=body).json()
    assert reply["lines"] == [item["text"] for item in reply["items"]]
    assert all(item["id"] == line_id(item["text"]) for item in reply["items"])
    assert reply["items"][0]["id"] in CANNED_BY_ID  # the first line is pre-voiced
    for item in reply["items"]:
        assert known_text(cache_dir, item["id"]) == item["text"]
        stored = cache_dir / "voice-lines" / f"{item['id']}.json"
        assert stored.exists() == (item["id"] not in CANNED_BY_ID)  # fixed lines need no store


def test_known_text_rejects_non_ids_unknown_ids_and_tampered_files(cache_dir: Path) -> None:
    assert known_text(cache_dir, "../../etc/passwd") is None
    assert known_text(cache_dir, "A" * 64) is None
    assert known_text(cache_dir, "0" * 64) is None
    remember(cache_dir, ["Make way for Ella!"])
    lid = line_id("Make way for Ella!")
    assert known_text(cache_dir, lid) == "Make way for Ella!"
    (cache_dir / "voice-lines" / f"{lid}.json").write_text(json.dumps({"text": "Something else entirely"}))
    assert known_text(cache_dir, lid) is None  # the id must stay the hash of the text
    (cache_dir / "voice-lines" / f"{lid}.json").write_text("{oops")
    assert known_text(cache_dir, lid) is None


# ---- the route -----------------------------------------------------------------------------------


def test_unknown_ids_are_404(client: TestClient) -> None:
    for lid in ("0" * 64, "not-an-id", line_id("Say anything I like")):
        r = client.get(f"/api/announcer/voice/{lid}")
        assert r.status_code == 404 and r.json()["detail"] == "Unknown announcer line."


def test_cache_hit_serves_the_wav_without_a_key(client: TestClient, cache_dir: Path) -> None:
    lid = next(iter(CANNED_BY_ID))
    data = _wav(cache_dir, lid)
    r = client.get(f"/api/announcer/voice/{lid}")
    assert r.status_code == 200 and r.content == data
    assert r.headers["content-type"] == "audio/wav" and "max-age" in r.headers["cache-control"]
    # a line voiced by the fallback model is a hit too, and so is a remembered (non-canned) line
    remember(cache_dir, ["Make way for Ella!"])
    other = line_id("Make way for Ella!")
    data2 = _wav(cache_dir, other, TTS_MODELS[1])
    assert client.get(f"/api/announcer/voice/{other}").content == data2


def test_cache_is_per_voice(client: TestClient, cache_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    lid = next(iter(CANNED_BY_ID))
    _wav(cache_dir, lid)
    monkeypatch.setenv("GEMINI_TTS_VOICE", "Kore" if DEFAULT_VOICE != "Kore" else "Puck")
    r = client.get(f"/api/announcer/voice/{lid}")
    assert r.status_code == 503  # another voice is another file, and there is no key to make it


def test_uncached_line_without_a_key_is_503(client: TestClient) -> None:
    r = client.get(f"/api/announcer/voice/{next(iter(CANNED_BY_ID))}")
    assert r.status_code == 503 and "GEMINI_API_KEY" in r.json()["detail"]


def test_voice_requests_are_rate_limited_per_client(client: TestClient, cache_dir: Path) -> None:
    lid = next(iter(CANNED_BY_ID))
    _wav(cache_dir, lid)
    for _ in range(announcer_api.RATE_LIMIT):
        assert client.get(f"/api/announcer/voice/{lid}").status_code == 200
    r = client.get(f"/api/announcer/voice/{lid}")
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1
    assert client.get(f"/api/announcer/voice/{'0' * 64}").status_code == 429  # every request counts
    announcer_api._hits.clear()  # another window (or another client) starts fresh
    assert client.get(f"/api/announcer/voice/{lid}").status_code == 200


def test_rate_limiter_forgets_quiet_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(announcer_api, "MAX_TRACKED_CLIENTS", 3)
    for i in range(5):
        announcer_api._hits[f"old-{i}"] = announcer_api.deque([-1e9])
    announcer_api._rate_limit("new")
    assert set(announcer_api._hits) == {"new"}


# ---- PCM -> WAV ----------------------------------------------------------------------------------


def test_pcm_to_wav_wraps_16_bit_mono() -> None:
    pcm = bytes(range(256)) * 10 + b"\x07"  # an odd trailing byte is dropped
    with wave.open(io.BytesIO(pcm_to_wav(pcm)), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 24_000)
        assert w.readframes(w.getnframes()) == pcm[:-1]
    with wave.open(io.BytesIO(pcm_to_wav(b"\x00\x00", 16_000)), "rb") as w:
        assert w.getframerate() == 16_000


def test_to_pcm_takes_a_wav_or_raw_pcm() -> None:
    pcm = (b"\x10\x00\xf0\xff") * 100
    assert to_pcm(pcm_to_wav(pcm, 22_050), "audio/wav") == (pcm, 22_050)  # what gemini-3.8-flash-tts returns
    assert to_pcm(pcm, "audio/L16;codec=pcm;rate=24000") == (pcm, 24_000)  # the older raw-PCM reply
    stereo = io.BytesIO()
    with wave.open(stereo, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(24_000)
        w.writeframes(pcm)
    with pytest.raises(ValueError, match="2 channels"):
        to_pcm(stereo.getvalue(), "audio/wav")
    with pytest.raises(ValueError, match="unreadable"):
        to_pcm(b"RIFF....WAVEjunk", "audio/wav")


def test_trim_silence_keeps_the_speech_and_a_short_pad() -> None:
    rate = 24_000
    quiet, loud = np.zeros(rate, dtype="<i2"), np.full(rate // 2, 12_000, dtype="<i2")
    hiss = np.full(rate // 4, 200, dtype="<i2")  # below the silence threshold
    out = np.frombuffer(trim_silence(np.concatenate([quiet, hiss, loud, quiet]).tobytes(), rate), dtype="<i2")
    lead, tail = int(LEAD_PAD_SEC * rate), int(TAIL_PAD_SEC * rate)
    assert len(out) == lead + len(loud) + tail
    assert (out[lead : lead + len(loud)] == 12_000).all()
    assert trim_silence(quiet.tobytes(), rate) == quiet.tobytes()  # all quiet: left alone


def test_sample_rate_comes_from_the_mime_type() -> None:
    assert sample_rate("audio/L16;codec=pcm;rate=24000") == 24_000
    assert sample_rate("audio/L16;rate=16000") == 16_000
    assert sample_rate("audio/L16") == 24_000 and sample_rate(None) == 24_000
