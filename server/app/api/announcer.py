"""POST /api/announcer: short fairy-tale ballroom announcer lines for a game event, and their voice.

AI lines (app.ai: Muse, then Gemini) when a key is set and a model answers in time, else a varied pick from
the canned bank (app.ai.prompts.CANNED). In-game moments answer at once from the recorded canned lines;
the intro and results answer within ~7.5 s (Muse takes 2-4.5 s). Identical requests within
CACHE_TTL_SEC get the same answer without a second model call. Every line comes with an id (sha256 of its
text) that GET /api/announcer/voice/{id} voices (app.ai.voice): only lines this endpoint gave out.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from pathlib import Path
from typing import Annotated, Literal

import anyio
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from app.ai.prompts import (
    ANNOUNCER_SYSTEM,
    IN_GAME_EVENTS,
    AnnouncerEvent,
    announcer_details,
    announcer_user,
    canned_lines,
    line_id,
    parse_lines,
)
from app.ai.provider import AIUnavailable, configured, env, generate_text
from app.accounts.store import spend
from app.ai.voice import VoiceUnavailable, cached_wav, known_text, remember, synthesize, voice_name, voiced_ids
from app.api.limits import client_ip
from app.config import Settings, get_settings

log = logging.getLogger(__name__)
router = APIRouter(tags=["ai"])
SettingsDep = Annotated[Settings, Depends(get_settings)]

# Only the intro, a perfect run and the results reach a model (in-game moments are canned), and the page asks for
# the intro ahead of time, so Muse gets ~6 s of this (MUSE_SHARE): it takes 2-4.5 s with its reasoning.
DEADLINE_SEC = 7.0  # the providers' share; the thread hop and canned fallback fit in the rest
HARD_CAP_SEC = 7.3  # wall clock, even if a socket read drips past its own timeout
MUSE_SHARE = 0.85  # the rest is Gemini's, the fallback
CACHE_TTL_SEC = 30.0
CACHE_MAX = 256


class AnnouncerContext(BaseModel):
    model_config = ConfigDict(extra="ignore")

    songTitle: str = Field(min_length=1, max_length=200)
    playerName: str | None = Field(default=None, max_length=40)
    score: int | None = Field(default=None, ge=0, le=10**9)
    accuracy: float | None = Field(default=None, ge=0, le=100)  # percent, like the results screen
    combo: int | None = Field(default=None, ge=0, le=100_000)
    maxCombo: int | None = Field(default=None, ge=0, le=100_000)
    grade: str | None = Field(default=None, max_length=40)
    stars: float | None = Field(default=None, ge=0, le=5)
    bestMove: str | None = Field(default=None, max_length=80)
    hardestMove: str | None = Field(default=None, max_length=80)
    difficulty: str | None = Field(default=None, max_length=20)


class AnnouncerRequest(BaseModel):
    event: AnnouncerEvent
    context: AnnouncerContext


class VoiceLine(BaseModel):
    id: str  # sha256 of text: GET /api/announcer/voice/{id}
    text: str


class AnnouncerReply(BaseModel):
    lines: list[str]
    items: list[VoiceLine]  # the same lines, with their ids
    source: Literal["muse", "gemini", "canned"]


def _reply(lines: list[str], source: Literal["muse", "gemini", "canned"]) -> AnnouncerReply:
    return AnnouncerReply(lines=lines, items=[VoiceLine(id=line_id(t), text=t) for t in lines], source=source)


# ponytail: per-instance dict, oldest-first eviction; a shared cache only matters if many instances repeat calls.
_cache: dict[str, tuple[float, AnnouncerReply]] = {}
# The last in-game lines said (per instance), so a cheer every 14 s doesn't repeat itself.
_recent: dict[AnnouncerEvent, deque[str]] = {}


async def _announce(req: AnnouncerRequest, cache_dir: Path) -> AnnouncerReply:
    details = announcer_details(req.context.model_dump())
    if req.event in IN_GAME_EVENTS:
        # A fresh line takes seconds to voice and the moment is gone by then: a recorded line plays at once.
        voiced = await asyncio.to_thread(voiced_ids, cache_dir, voice_name())
        recent = _recent.setdefault(req.event, deque(maxlen=2))
        lines = canned_lines(req.event, details, voiced, avoid=recent)
        recent.append(lines[0])
        return _reply(lines, "canned")
    if configured():
        user = announcer_user(req.event, details)
        try:
            raw, source = await asyncio.wait_for(
                asyncio.to_thread(
                    generate_text, ANNOUNCER_SYSTEM, user, deadline_sec=DEADLINE_SEC, json_mode=True, temperature=0.9, first_share=MUSE_SHARE
                ),
                HARD_CAP_SEC,
            )
        except (AIUnavailable, TimeoutError) as exc:
            log.info("announcer.canned reason=%s", type(exc).__name__)
        else:
            if lines := parse_lines(raw):
                return _reply(lines, source)
            log.info("announcer.canned reason=unusable_reply")
    return _reply(canned_lines(req.event, details), "canned")


@router.post("/announcer")
async def announcer(req: AnnouncerRequest, request: Request, settings: SettingsDep) -> AnnouncerReply:
    """1-3 announcer lines (<= 90 chars each) for the event, each with the id that voices it. 429 when too many."""
    _rate_limit(_line_hits, LINES_RATE_LIMIT, client_ip(request), "Too many announcer requests; slow down.")
    key = req.model_dump_json()
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and hit[0] > now and req.event not in IN_GAME_EVENTS:  # in-game picks are cheap: vary them
        return hit[1]
    reply = await _announce(req, settings.cache_dir)
    try:
        await asyncio.to_thread(remember, settings.cache_dir, reply.lines)
    except Exception as exc:  # disk or Blob: the lines still show; the page falls back to its own voice
        log.warning("announcer.remember ok=false error=%s", type(exc).__name__)
    _cache.pop(key, None)  # an expired entry: re-insert at the end so eviction stays oldest-first
    if len(_cache) >= CACHE_MAX:
        _cache.pop(next(iter(_cache)))  # dicts keep insertion order: this is the oldest entry
    _cache[key] = (time.monotonic() + CACHE_TTL_SEC, reply)
    return reply


# ---- voice ---------------------------------------------------------------------------------------

MAX_CONCURRENT_TTS = 2  # per instance; queued requests wait on the event loop, not in a worker thread
TTS_SLOTS = anyio.CapacityLimiter(MAX_CONCURRENT_TTS)
RATE_LIMIT = 40  # voice requests per client per window: a game asks for a few per minute
# A round asks for ~10 sets of lines (intro, prefetched milestones, results); a venue NAT shares one IP.
LINES_RATE_LIMIT = 120
RATE_WINDOW_SEC = 60.0
MAX_TRACKED_CLIENTS = 4096
VOICE_MAX_AGE_SEC = 24 * 3600
# Fresh TTS calls per rolling 24 h, all instances (counted in the database): lines carry the caller's name,
# song and score, so new ids are free to mint. Cached lines don't count; past it the page uses its own voice.
VOICE_DAILY_CAP = 1000
# ponytail: per-instance sliding window keyed by client IP; a shared limiter (Blob/KV) if abuse spans instances.
_hits: dict[str, deque[float]] = {}
_line_hits: dict[str, deque[float]] = {}


def _rate_limit(hits: dict[str, deque[float]], limit: int, client: str, message: str) -> None:
    """429 once ``client`` has made ``limit`` requests (tracked in ``hits``) in the last RATE_WINDOW_SEC."""
    now = time.monotonic()
    if len(hits) > MAX_TRACKED_CLIENTS:  # forget clients that have gone quiet
        for quiet in [c for c, q in hits.items() if not q or q[-1] < now - RATE_WINDOW_SEC]:
            del hits[quiet]
    q = hits.setdefault(client, deque())
    while q and q[0] < now - RATE_WINDOW_SEC:
        q.popleft()
    if len(q) >= limit:
        retry = int(q[0] + RATE_WINDOW_SEC - now) + 1
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, message, {"Retry-After": str(retry)})
    q.append(now)


@router.get(
    "/announcer/voice/{lid}",
    response_class=Response,
    responses={200: {"content": {"audio/wav": {}}, "description": "The line, voiced (WAV, 16-bit mono)."}},
)
async def announcer_voice(lid: str, request: Request, settings: SettingsDep) -> Response:
    """A line /api/announcer gave out, voiced by the herald. 404 unknown id, 429 too many, 503 no voice."""
    _rate_limit(_hits, RATE_LIMIT, client_ip(request), "Too many voice requests; slow down.")
    text = await asyncio.to_thread(known_text, settings.cache_dir, lid)
    if text is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown announcer line.")
    voice = voice_name()
    wav = await asyncio.to_thread(cached_wav, settings.cache_dir, lid, voice)
    if wav is None:
        if not env("GEMINI_API_KEY"):
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The announcer voice needs GEMINI_API_KEY on the server.")
        async with TTS_SLOTS:
            # Re-check: a request for the same line may have voiced it while this one waited for a slot.
            wav = await asyncio.to_thread(cached_wav, settings.cache_dir, lid, voice)
            if wav is None:
                now_ms = int(time.time() * 1000)
                if not await asyncio.to_thread(spend, "voice-day", (VOICE_DAILY_CAP, 86_400_000), now_ms):
                    raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The announcer voice is resting until tomorrow.")
                try:
                    wav = await asyncio.to_thread(synthesize, settings.cache_dir, lid, text, voice)
                except VoiceUnavailable as exc:
                    raise HTTPException(
                        status.HTTP_503_SERVICE_UNAVAILABLE, "The announcer voice is unavailable right now; try again."
                    ) from exc
    return Response(wav, media_type="audio/wav", headers={"Cache-Control": f"public, max-age={VOICE_MAX_AGE_SEC}"})
