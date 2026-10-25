"""Stage 6 multiplayer rooms (shared/README.md, "Stage 6 endpoints"). Clients poll about once a second.

Writes authenticate with the ``X-Player-Token`` header from create/join and answer with the same
body as ``GET /api/rooms/{code}`` (honouring ``?chatAfter=``), so a write doubles as a poll.
``GET`` without a token answers only ``RoomPeek`` (no players, no chat). An unknown room and a missing or
wrong token both answer 404, and every route counts its 404s toward a per-client throttle, so guessing
codes is impractical. Sync handlers on purpose: the
database calls block, so FastAPI runs them in its threadpool.
"""

from __future__ import annotations

import json
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, Request, status

from app.analysis_store import ID_RE
from app.api.limits import client_ip
from app.config import Settings, get_settings
from app.rooms import modes, store
from app.rooms.models import (
    BeatsBody,
    ChatBody,
    Created,
    DancingBody,
    Heatmap,
    Joined,
    ModeBody,
    NameBody,
    Ok,
    ReadyBody,
    RoomPeek,
    RoomView,
    RoutineChoice,
    ScoreBody,
)
from app.routine_store import RoutineStore

router = APIRouter(prefix="/rooms", tags=["rooms"])
heatmap_router = APIRouter(prefix="/songs", tags=["rooms"])

Token = Annotated[str | None, Header(alias="X-Player-Token", max_length=200)]
ChatAfter = Annotated[int | None, Query(alias="chatAfter", ge=0)]
AnalysisId = Annotated[str, Path(alias="analysisId", pattern=ID_RE.pattern)]


SettingsDep = Annotated[Settings, Depends(get_settings)]
T = TypeVar("T")

# 23^4 = 279,841 codes: at 20 misses a minute one client needs days to sweep them.
LOOKUP_MISSES = 20
LOOKUP_WINDOW_SEC = 60.0
MAX_TRACKED_CLIENTS = 4096
# ponytail: per-instance memory; a shared store (KV) if a guesser spreads over many instances.
_misses: dict[str, deque[float]] = {}
_misses_lock = threading.Lock()  # sync handlers run in the threadpool


def _now() -> int:
    return time.time_ns() // 1_000_000


def _too_many(q: deque[float], now: float) -> HTTPException:
    retry = int(q[0] + LOOKUP_WINDOW_SEC - now) + 1
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS, "Too many unknown room codes; wait a minute.", {"Retry-After": str(retry)}
    )


def _lookup(request: Request, find: Callable[[], T], gate: bool = True) -> T:
    """Run a room lookup, counting its 404s per client. ``gate``: 429 up front while this client has
    LOOKUP_MISSES misses in the window (token-less GETs and joins). Without it (calls with a seat token) a
    seated player keeps working even when their venue shares one IP with a guesser; only their own misses
    past the limit turn into 429."""
    client, now = client_ip(request), time.monotonic()
    with _misses_lock:
        if len(_misses) > MAX_TRACKED_CLIENTS:  # forget clients that have gone quiet
            for quiet in [c for c, q in _misses.items() if not q or q[-1] < now - LOOKUP_WINDOW_SEC]:
                del _misses[quiet]
        q = _misses.setdefault(client, deque())
        while q and q[0] < now - LOOKUP_WINDOW_SEC:
            q.popleft()
        if gate and len(q) >= LOOKUP_MISSES:
            raise _too_many(q, now)
    try:
        return find()
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            with _misses_lock:
                q = _misses.setdefault(client, deque())
                q.append(now)
                if not gate and len(q) > LOOKUP_MISSES:
                    raise _too_many(q, now) from None
        raise


def _check_routine(body: RoutineChoice, settings: Settings) -> None:
    """The routine must be one this server generated, for the song it names (the heatmap keys on that song)."""
    data = RoutineStore(settings.cache_dir).load_bytes(body.routineId)
    meta = json.loads(data).get("meta") if data else None
    if not isinstance(meta, dict) or meta.get("analysisId") != body.analysisId:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No routine with that id for that song.")


@router.post("")
def create_room(body: NameBody) -> Created:
    return store.create_room(body.name, _now())


@router.post("/{code}/join")
def join_room(code: str, body: NameBody, request: Request) -> Joined:
    return _lookup(request, lambda: store.join_room(code, body.name, _now()))


@router.get("/{code}")
def get_room(code: str, request: Request, token: Token = None, chat_after: ChatAfter = None) -> RoomView | RoomPeek:
    """The full room for a seated player (X-Player-Token); without a token only ``RoomPeek``."""
    if token is None:
        return _lookup(request, lambda: store.peek_room(code, _now()))
    return _lookup(request, lambda: store.get_room(code, token, chat_after, _now()), gate=False)


@router.post("/{code}/routine")
def set_routine(
    code: str,
    body: RoutineChoice,
    settings: SettingsDep,
    request: Request,
    token: Token = None,
    chat_after: ChatAfter = None,
) -> RoomView:
    def run() -> RoomView:
        _check_routine(body, settings)  # independent of the room: no hint about the code
        return store.set_routine(code, token, body, chat_after, _now())

    return _lookup(request, run, gate=False)


@router.post("/{code}/ready")
def set_ready(code: str, request: Request, body: ReadyBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return _lookup(request, lambda: store.set_ready(code, token, body.ready, chat_after, _now()), gate=False)


@router.post("/{code}/dancing")
def set_dancing(code: str, body: DancingBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    """Dance in the next rounds or only watch (``dancing: false``, e.g. the host's big screen)."""
    return store.set_dancing(code, token, body.dancing, chat_after, _now())


@router.post("/{code}/start")
def start(code: str, request: Request, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return _lookup(request, lambda: store.start(code, token, chat_after, _now()), gate=False)


@router.post("/{code}/score")
def post_score(code: str, request: Request, body: ScoreBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return _lookup(request, lambda: store.post_score(code, token, body, chat_after, _now()), gate=False)


@router.post("/{code}/chat")
def post_chat(code: str, request: Request, body: ChatBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return _lookup(request, lambda: store.post_chat(code, token, body.text, chat_after, _now()), gate=False)


@router.post("/{code}/leave")
def leave(code: str, request: Request, token: Token = None) -> Ok:
    _lookup(request, lambda: store.leave(code, token, _now()), gate=False)
    return Ok()


@router.post("/{code}/mode")
def set_mode(code: str, request: Request, body: ModeBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return _lookup(request, lambda: store.set_mode(code, token, body.mode, chat_after, _now()), gate=False)


@router.post("/{code}/beats")
def post_beats(code: str, request: Request, body: BeatsBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return _lookup(request, lambda: store.post_beats(code, token, body.beats, chat_after, _now()), gate=False)


@router.post("/{code}/rematch")
def rematch(code: str, request: Request, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return _lookup(request, lambda: store.rematch(code, token, chat_after, _now()), gate=False)


@heatmap_router.get("/{analysisId}/heatmap")
def get_heatmap(analysis_id: AnalysisId) -> Heatmap:
    """Average score per beat of this song across all rooms: its "hardest moments"."""
    return modes.heatmap(analysis_id)
