"""Stage 6 multiplayer rooms (shared/README.md, "Stage 6 endpoints"). Clients poll about once a second.

Writes authenticate with the ``X-Player-Token`` header from create/join and answer with the same
body as ``GET /api/rooms/{code}`` (honouring ``?chatAfter=``), so a write doubles as a poll.
Sync handlers on purpose: the database calls block, so FastAPI runs them in its threadpool.
"""

from __future__ import annotations

import time
from typing import Annotated

from fastapi import APIRouter, Header, Path, Query

from app.analysis_store import ID_RE
from app.rooms import modes, store
from app.rooms.models import (
    BeatsBody,
    ChatBody,
    Created,
    Heatmap,
    Joined,
    ModeBody,
    NameBody,
    Ok,
    ReadyBody,
    RoomView,
    RoutineChoice,
    ScoreBody,
)

router = APIRouter(prefix="/rooms", tags=["rooms"])
heatmap_router = APIRouter(prefix="/songs", tags=["rooms"])

Token = Annotated[str | None, Header(alias="X-Player-Token", max_length=200)]
ChatAfter = Annotated[int | None, Query(alias="chatAfter", ge=0)]
AnalysisId = Annotated[str, Path(alias="analysisId", pattern=ID_RE.pattern)]


def _now() -> int:
    return time.time_ns() // 1_000_000


@router.post("")
def create_room(body: NameBody) -> Created:
    return store.create_room(body.name, _now())


@router.post("/{code}/join")
def join_room(code: str, body: NameBody) -> Joined:
    return store.join_room(code, body.name, _now())


@router.get("/{code}")
def get_room(code: str, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return store.get_room(code, token, chat_after, _now())


@router.post("/{code}/routine")
def set_routine(code: str, body: RoutineChoice, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return store.set_routine(code, token, body, chat_after, _now())


@router.post("/{code}/ready")
def set_ready(code: str, body: ReadyBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return store.set_ready(code, token, body.ready, chat_after, _now())


@router.post("/{code}/start")
def start(code: str, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return store.start(code, token, chat_after, _now())


@router.post("/{code}/score")
def post_score(code: str, body: ScoreBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return store.post_score(code, token, body, chat_after, _now())


@router.post("/{code}/chat")
def post_chat(code: str, body: ChatBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return store.post_chat(code, token, body.text, chat_after, _now())


@router.post("/{code}/leave")
def leave(code: str, token: Token = None) -> Ok:
    store.leave(code, token, _now())
    return Ok()


@router.post("/{code}/mode")
def set_mode(code: str, body: ModeBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return store.set_mode(code, token, body.mode, chat_after, _now())


@router.post("/{code}/beats")
def post_beats(code: str, body: BeatsBody, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return store.post_beats(code, token, body.beats, chat_after, _now())


@router.post("/{code}/rematch")
def rematch(code: str, token: Token = None, chat_after: ChatAfter = None) -> RoomView:
    return store.rematch(code, token, chat_after, _now())


@heatmap_router.get("/{analysisId}/heatmap")
def get_heatmap(analysis_id: AnalysisId) -> Heatmap:
    """Average score per beat of this song across all rooms: its "hardest moments"."""
    return modes.heatmap(analysis_id)
