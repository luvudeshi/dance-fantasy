"""Request and response bodies for the multiplayer rooms API (shared/README.md, "Stage 6 endpoints").

Every request model forbids unknown fields. Names and chat text are trimmed, inner whitespace is
collapsed to single spaces, and control characters are rejected.
"""

from __future__ import annotations

import unicodedata
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from app.analysis_store import ID_RE
from app.routine import Difficulty, Mode
from app.routine_store import ROUTINE_ID_PATTERN

RoomState = Literal["lobby", "countdown", "playing", "finished"]
MAX_NAME = 24
MAX_CHAT = 200


def _clean(value: object) -> object:
    """Trim and collapse whitespace (incl. newlines); reject other control characters."""
    if not isinstance(value, str):
        return value  # the str schema reports the type error
    value = " ".join(value.split())
    if any(unicodedata.category(c) == "Cc" for c in value):
        raise ValueError("must not contain control characters")
    return value


Name = Annotated[str, BeforeValidator(_clean), Field(min_length=1, max_length=MAX_NAME)]
ChatText = Annotated[str, BeforeValidator(_clean), Field(min_length=1, max_length=MAX_CHAT)]


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NameBody(_Request):
    name: Name


class RoutineChoice(_Request):
    routineId: str = Field(pattern=ROUTINE_ID_PATTERN)
    analysisId: str = Field(pattern=ID_RE.pattern)
    title: Annotated[str, BeforeValidator(_clean), Field(min_length=1, max_length=200)]
    difficulty: Difficulty
    mode: Mode


class ReadyBody(_Request):
    ready: bool


class ScoreBody(_Request):
    score: int = Field(ge=0, le=100_000_000)
    combo: int = Field(ge=0, le=100_000)
    maxCombo: int = Field(ge=0, le=100_000)
    accuracy: float = Field(ge=0, le=100)  # percent, like the game's results screen
    progress: float = Field(ge=0, le=1)
    finished: bool


class ChatBody(_Request):
    text: ChatText


class Joined(BaseModel):
    playerId: str
    token: str


class Created(Joined):
    code: str


class PlayerView(BaseModel):
    id: str
    name: str
    isHost: bool
    ready: bool
    connected: bool
    score: int
    combo: int
    maxCombo: int
    accuracy: float
    progress: float
    finished: bool


class ChatMessage(BaseModel):
    id: int
    playerId: str
    name: str
    text: str
    at: int


class RoomView(BaseModel):
    code: str
    state: RoomState
    hostId: str
    serverNow: int
    startAt: int | None
    routine: RoutineChoice | None
    players: list[PlayerView]
    chat: list[ChatMessage]


class Ok(BaseModel):
    ok: Literal[True] = True
