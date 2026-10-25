"""The announcer's voice: Gemini TTS for known announcer lines, synthesized once and cached as WAV forever.

Only known lines are ever voiced (the route takes an id, never text, so it is no open TTS proxy). A line's
id is sha256 of its text (app.ai.prompts.line_id). Fixed canned lines are known from the bank
(``CANNED_BY_ID``); every other line /api/announcer returns (AI lines, filled templates) is remembered at

    <cache_dir>/voice-lines/<id>.json      {"text": ...}
    <cache_dir>/voice/<sha256 of id, voice, model, direction>.wav

Both are written with app.analysis_store's cache helpers, so deployments mirror them to Vercel Blob and
every instance shares them. Env: GEMINI_API_KEY, GEMINI_TTS_VOICE (default ``DEFAULT_VOICE``).

Privacy: never logs line text or audio, only the model, ok/fail, latency and the error's type or status.
Blocking I/O: call from a worker thread.
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import io
import json
import logging
import re
import time
import wave
from collections.abc import Iterable
from pathlib import Path

from app.ai.prompts import CANNED_BY_ID, line_id
from app.ai.provider import GEMINI_BASE, _describe, _post, env
from app.analysis_store import ID_RE, _atomic_write, read_cached

log = logging.getLogger(__name__)

# First answer wins; the lite model is the fallback when the main one is missing, busy or failing.
TTS_MODELS = ("gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts")
# ponytail: picked by the prebuilt voice's published character ("Upbeat"), since the listening test could
# not run (see the PR notes); swap with GEMINI_TTS_VOICE after one, no code change.
DEFAULT_VOICE = "Puck"
DIRECTION = "Say this like an ecstatic royal herald announcing the star of the ball, big energy, smiling: "
TTS_TIMEOUT_SEC = 20.0
DEFAULT_RATE = 24_000  # Gemini TTS: 16-bit mono PCM at 24 kHz
_RATE_RE = re.compile(r"rate=(\d+)")


class VoiceUnavailable(RuntimeError):
    """No TTS model returned audio."""


def voice_name() -> str:
    return env("GEMINI_TTS_VOICE", DEFAULT_VOICE)


# ---- known lines ---------------------------------------------------------------------------------


def _line_path(cache_dir: Path, lid: str) -> Path:
    return cache_dir / "voice-lines" / f"{lid}.json"


def remember(cache_dir: Path, texts: Iterable[str]) -> None:
    """Make these lines voiceable by id (fixed canned lines already are)."""
    for text in texts:
        lid = line_id(text)
        path = _line_path(cache_dir, lid)
        if lid not in CANNED_BY_ID and not path.exists():
            _atomic_write(path, json.dumps({"text": text}, ensure_ascii=False).encode("utf-8"))


def known_text(cache_dir: Path, lid: str) -> str | None:
    """The text of a line /api/announcer has given out, or None (also for anything that isn't an id)."""
    if not ID_RE.match(lid):
        return None
    if lid in CANNED_BY_ID:
        return CANNED_BY_ID[lid]
    try:
        doc = json.loads(read_cached(_line_path(cache_dir, lid)))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        log.warning("voice.line unreadable error=%s", type(exc).__name__)
        return None
    text = doc.get("text") if isinstance(doc, dict) else None
    # The id must still be the hash of the text: a file written by anything else is not a line we gave out.
    return text if isinstance(text, str) and line_id(text) == lid else None


# ---- audio ---------------------------------------------------------------------------------------


def wav_path(cache_dir: Path, lid: str, voice: str, model: str) -> Path:
    key = json.dumps([lid, voice, model, DIRECTION])
    return cache_dir / "voice" / f"{hashlib.sha256(key.encode('utf-8')).hexdigest()}.wav"


def cached_wav(cache_dir: Path, lid: str, voice: str) -> bytes | None:
    """The line's WAV from any TTS model, if it was ever voiced."""
    for model in TTS_MODELS:
        try:
            return read_cached(wav_path(cache_dir, lid, voice, model))
        except FileNotFoundError:
            continue
    return None


def pcm_to_wav(pcm: bytes, rate: int = DEFAULT_RATE) -> bytes:
    """16-bit little-endian mono PCM in a WAV container (a trailing odd byte is dropped)."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm[: len(pcm) - len(pcm) % 2])
    return out.getvalue()


def sample_rate(mime: object) -> int:
    """The rate in a mime type like ``audio/L16;codec=pcm;rate=24000`` (24 kHz when it doesn't say)."""
    match = _RATE_RE.search(mime) if isinstance(mime, str) else None
    return int(match.group(1)) if match else DEFAULT_RATE


def tts(key: str, text: str, voice: str, model: str, timeout: float = TTS_TIMEOUT_SEC) -> bytes:
    """One Gemini TTS call: the line spoken with the herald direction, as WAV bytes."""
    body = {
        "contents": [{"role": "user", "parts": [{"text": DIRECTION + text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    doc = _post(f"{GEMINI_BASE}/v1beta/models/{model}:generateContent", {"x-goog-api-key": key}, body, timeout)
    for part in doc["candidates"][0]["content"]["parts"]:
        inline = part.get("inlineData") if isinstance(part, dict) else None
        if isinstance(inline, dict) and isinstance(inline.get("data"), str):
            pcm = base64.b64decode(inline["data"])
            if pcm:
                return pcm_to_wav(pcm, sample_rate(inline.get("mimeType")))
    raise ValueError("no audio in the reply")


def synthesize(cache_dir: Path, lid: str, text: str, voice: str) -> bytes:
    """Voice a line with the first TTS model that answers, and cache it. VoiceUnavailable if none does."""
    key = env("GEMINI_API_KEY")
    if not key:
        raise VoiceUnavailable("GEMINI_API_KEY is not set")
    for model in TTS_MODELS:
        started = time.monotonic()
        try:
            wav = tts(key, text, voice, model)
        except (OSError, http.client.HTTPException, ValueError, LookupError, TypeError) as exc:  # net, HTTP, JSON, shape
            ms = (time.monotonic() - started) * 1000
            log.warning("voice.tts model=%s ok=false ms=%.0f error=%s", model, ms, _describe(exc))
            continue
        log.info("voice.tts model=%s ok=true ms=%.0f bytes=%d", model, (time.monotonic() - started) * 1000, len(wav))
        try:
            _atomic_write(wav_path(cache_dir, lid, voice, model), wav)
        except Exception as exc:  # disk or Blob: this answer still plays, the next request voices it again
            log.warning("voice.cache ok=false error=%s", type(exc).__name__)
        return wav
    raise VoiceUnavailable("no TTS model answered")
