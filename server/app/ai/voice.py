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

import numpy as np

from app import blob
from app.ai.prompts import CANNED_BY_ID, line_id
from app.ai.provider import GEMINI_BASE, _describe, _post, env
from app.analysis_store import ID_RE, _atomic_write, read_cached

log = logging.getLogger(__name__)

# First answer wins; the others are fallbacks when one is missing, busy or out of quota. Each model has its own
# free-tier quota (about 10 requests a day) and the same voices; an exhausted one fails in ~0.1 s.
TTS_MODELS = (
    "gemini-3.8-flash-tts",
    "gemini-3.8-flash-lite-tts",
    "gemini-3.1-flash-tts-preview",
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-pro-preview-tts",
)
# Chosen by a listening test by proxy (same herald line, six candidates, a Gemini listener plus pitch and
# loudness stats): Fenrir rated energy 9 / warmth 9, said the words exactly, had the widest pitch movement
# (17 semitones) and the punchiest delivery. Puck ad-libbed an "Oh,"; Zephyr was flatter and slurred a word.
DEFAULT_VOICE = "Fenrir"
# The delivery direction. A plain "Say this like ...: <line>" prefix gets read aloud by these models; the
# director's-notes layout keeps everything above TRANSCRIPT as direction only (checked by transcribing takes).
DIRECTION = """# AUDIO PROFILE: The Royal Herald
## THE SCENE: A glittering fairy-tale ballroom at midnight. The herald announces the star of the ball to a cheering royal court.
### DIRECTOR'S NOTES
Style: Say this like an ecstatic royal herald announcing the star of the ball: big energy, warm, smiling the whole time.
Pace: Quick and punchy, no long pauses. Speak the transcript exactly, word for word, adding nothing.
#### TRANSCRIPT
"""
TTS_TIMEOUT_SEC = 20.0
DEFAULT_RATE = 24_000  # Gemini TTS: 16-bit mono at 24 kHz, as a WAV or as raw PCM (audio/L16;rate=24000)
_RATE_RE = re.compile(r"rate=(\d+)")
SILENCE = 0.02  # of full scale: quieter than this at either end is trimmed, so a line starts speaking at once
LEAD_PAD_SEC = 0.08  # kept before the first loud sample (soft onsets like "h")
TAIL_PAD_SEC = 0.15


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


VOICED_TTL_SEC = 300.0
# ponytail: per-instance memo, refreshed every VOICED_TTL_SEC; lines voiced meanwhile join on the next refresh.
_voiced: tuple[float, frozenset[str]] = (0.0, frozenset())


def voiced_ids(cache_dir: Path, voice: str) -> frozenset[str]:
    """Ids of the fixed canned lines that already have audio (on disk or in Blob): one Blob listing, memoized."""
    global _voiced
    now = time.monotonic()
    if now < _voiced[0]:
        return _voiced[1]
    names = {p.name for p in (cache_dir / "voice").glob("*.wav")}
    try:
        names |= {key.rsplit("/", 1)[-1] for key in blob.keys("voice/")}
    except Exception as exc:  # Blob down: what is on disk still counts
        log.warning("voice.voiced blob=false error=%s", type(exc).__name__)
    ids = frozenset(lid for lid in CANNED_BY_ID if any(wav_path(cache_dir, lid, voice, m).name in names for m in TTS_MODELS))
    _voiced = (now + VOICED_TTL_SEC, ids)
    return ids


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


def to_pcm(data: bytes, mime: object) -> tuple[bytes, int]:
    """(16-bit mono PCM, rate) from the model's audio: a WAV container or raw PCM. ValueError for other WAVs."""
    if data[:4] != b"RIFF":
        return data, sample_rate(mime)
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            if (w.getnchannels(), w.getsampwidth()) != (1, 2):
                raise ValueError(f"unexpected WAV: {w.getnchannels()} channels, {8 * w.getsampwidth()}-bit")
            return w.readframes(w.getnframes()), w.getframerate()
    except (wave.Error, EOFError) as exc:
        raise ValueError(f"unreadable WAV ({exc})") from exc


def trim_silence(pcm: bytes, rate: int) -> bytes:
    """PCM without the quiet lead-in and tail (keeping a short pad), so playback starts on the first word."""
    y = np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype="<i2")
    loud = np.flatnonzero(np.abs(y.astype(np.int32)) > SILENCE * 32767)
    if loud.size == 0:
        return y.tobytes()
    start = max(0, int(loud[0]) - int(LEAD_PAD_SEC * rate))
    end = min(len(y), int(loud[-1]) + 1 + int(TAIL_PAD_SEC * rate))
    return y[start:end].tobytes()


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
            pcm, rate = to_pcm(base64.b64decode(inline["data"]), inline.get("mimeType"))
            if pcm := trim_silence(pcm, rate):
                return pcm_to_wav(pcm, rate)
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
