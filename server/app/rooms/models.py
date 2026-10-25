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
RoomMode = Literal["versus", "crew"]
Grade = Literal["perfect", "good", "ok", "miss"]
MAX_NAME = 24
MAX_CHAT = 200
MAX_BEATS_PER_POST = 64
MAX_BEAT = 20_000


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


class DancingBody(_Request):
    dancing: bool  # false: watching only (e.g. the host's big screen)


class ScoreBody(_Request):
    score: int = Field(ge=0, le=100_000_000)
    combo: int = Field(ge=0, le=100_000)
    maxCombo: int = Field(ge=0, le=100_000)
    accuracy: float = Field(ge=0, le=100)  # percent, like the game's results screen
    progress: float = Field(ge=0, le=1)
    finished: bool


class ChatBody(_Request):
    text: ChatText


class ModeBody(_Request):
    mode: RoomMode


class BeatJudgement(_Request):
    beat: int = Field(ge=0, le=MAX_BEAT)  # the routine's beat/checkpoint index, the same for every dancer
    score: float = Field(ge=0, le=100, allow_inf_nan=False)
    grade: Grade


class BeatsBody(_Request):
    beats: list[BeatJudgement] = Field(max_length=MAX_BEATS_PER_POST)


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
    beatsWon: int  # versus: beats where this player had the best score (ties shared)
    dancing: bool  # false: watching; not in the round's finish, crew sync, team score or leader


class CrewStats(BaseModel):
    teamScore: int  # every dancer's score + syncBonus
    syncBonus: int
    syncedBeats: int
    syncStreak: int
    bestSyncStreak: int
    lastSyncBeat: int | None


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
    mode: RoomMode
    players: list[PlayerView]
    leaderId: str | None  # versus: most beats won, then score; null when nobody leads outright
    crew: CrewStats
    chat: list[ChatMessage]


class RoomPeek(BaseModel):
    """GET /api/rooms/{code} without a seat: enough for a join page to show the room exists."""

    code: str
    state: RoomState
    playerCount: int
    mode: RoomMode


class HeatBeat(BaseModel):
    beat: int
    avgScore: float
    samples: int  # rounds that judged this beat (each round counts once)


class Heatmap(BaseModel):
    analysisId: str
    beats: list[HeatBeat]


class Ok(BaseModel):
    ok: Literal[True] = True
