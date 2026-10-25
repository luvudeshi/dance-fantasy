"""POST /api/announcer: short fairy-tale ballroom announcer lines for a game event.

AI lines (app.ai: Muse, then Gemini) when a key is set and a model answers in time, else a varied pick from
the canned bank (app.ai.prompts.CANNED). Always answers within ~2.5 s. Identical requests within
CACHE_TTL_SEC get the same answer without a second model call.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from app.ai.prompts import ANNOUNCER_SYSTEM, AnnouncerEvent, announcer_details, announcer_user, canned_lines, parse_lines
from app.ai.provider import AIUnavailable, configured, generate_text

log = logging.getLogger(__name__)
router = APIRouter(tags=["ai"])

DEADLINE_SEC = 2.1  # the providers' share; the thread hop and canned fallback fit in the rest
HARD_CAP_SEC = 2.3  # wall clock, even if a socket read drips past its own timeout
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


class AnnouncerReply(BaseModel):
    lines: list[str]
    source: Literal["muse", "gemini", "canned"]


# ponytail: per-instance dict, oldest-first eviction; a shared cache only matters if many instances repeat calls.
_cache: dict[str, tuple[float, AnnouncerReply]] = {}


async def _announce(req: AnnouncerRequest) -> AnnouncerReply:
    details = announcer_details(req.context.model_dump())
    if configured():
        user = announcer_user(req.event, details)
        try:
            raw, source = await asyncio.wait_for(
                asyncio.to_thread(
                    generate_text, ANNOUNCER_SYSTEM, user, deadline_sec=DEADLINE_SEC, json_mode=True, temperature=0.9
                ),
                HARD_CAP_SEC,
            )
        except (AIUnavailable, TimeoutError) as exc:
            log.info("announcer.canned reason=%s", type(exc).__name__)
        else:
            if lines := parse_lines(raw):
                return AnnouncerReply(lines=lines, source=source)
            log.info("announcer.canned reason=unusable_reply")
    return AnnouncerReply(lines=canned_lines(req.event, details), source="canned")


@router.post("/announcer")
async def announcer(req: AnnouncerRequest) -> AnnouncerReply:
    """1-3 announcer lines (<= 90 chars each) for the event."""
    key = req.model_dump_json()
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and hit[0] > now:
        return hit[1]
    reply = await _announce(req)
    _cache.pop(key, None)  # an expired entry: re-insert at the end so eviction stays oldest-first
    if len(_cache) >= CACHE_MAX:
        _cache.pop(next(iter(_cache)))  # dicts keep insertion order: this is the oldest entry
    _cache[key] = (time.monotonic() + CACHE_TTL_SEC, reply)
    return reply
