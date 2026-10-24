"""routine.json models.

Hand-written to match shared/routine.schema.json and shared/routine.ts; change all
three together (tests/test_contract.py enforces the match). Field names are
camelCase on purpose so the JSON is identical on both sides of the stack.
"""

from __future__ import annotations

import bisect
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.skeleton import JointName

# Times that must coincide (downbeat vs beat, move start vs its beat) may differ by this much,
# so values computed separately (or rounded to 4 decimals) still match.
BEAT_TIME_TOLERANCE = 1e-3

Difficulty = Literal["easy", "normal", "hard"]
Mode = Literal["standing", "seated"]
Vec2 = tuple[float, float]
Pose2D = dict[JointName, Vec2]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Section(_Strict):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    label: str = Field(min_length=1)
    energy: float = Field(ge=0, le=1)


class Song(_Strict):
    id: str | None = None
    title: str
    artist: str | None = None
    durationSec: float = Field(ge=0)
    bpm: float = Field(ge=0)
    beats: list[float]
    downbeats: list[float]
    sections: list[Section]

    @model_validator(mode="after")
    def _check_beats(self) -> Song:
        if any(b <= a for a, b in zip(self.beats, self.beats[1:])):
            raise ValueError("song.beats must be strictly ascending")
        if any(b <= a for a, b in zip(self.downbeats, self.downbeats[1:])):
            raise ValueError("song.downbeats must be strictly ascending")
        for d in self.downbeats:
            i = bisect.bisect_left(self.beats, d - BEAT_TIME_TOLERANCE)
            if i == len(self.beats) or abs(self.beats[i] - d) > BEAT_TIME_TOLERANCE:
                raise ValueError(f"song.downbeats: {d} is not one of song.beats")
        return self


class Keyframe(_Strict):
    t: float = Field(ge=0, le=1)
    pose: Pose2D


class Move(_Strict):
    id: str = Field(min_length=1)
    name: str
    startBeat: int = Field(ge=0)
    lengthBeats: int = Field(ge=1)
    startTime: float = Field(ge=0)
    endTime: float = Field(ge=0)
    intensity: int = Field(ge=1, le=5)
    scoredJoints: list[JointName]
    keyframes: list[Keyframe] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_order(self) -> Move:
        if self.endTime <= self.startTime:
            raise ValueError(f"move {self.id}: endTime must be > startTime")
        ts = [k.t for k in self.keyframes]
        if ts != sorted(ts):
            raise ValueError(f"move {self.id}: keyframes must be ascending by t")
        if len(set(self.scoredJoints)) != len(self.scoredJoints):
            raise ValueError(f"move {self.id}: scoredJoints must be unique")
        return self


class Routine(_Strict):
    version: Literal[1] = 1
    song: Song
    difficulty: Difficulty
    mode: Mode
    seed: int
    moves: list[Move]
    meta: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _check_moves(self) -> Routine:
        beats = self.song.beats
        for move in self.moves:
            if move.startBeat >= len(beats):
                raise ValueError(f"move {move.id}: startBeat {move.startBeat} is past song.beats ({len(beats)} beats)")
            if abs(move.startTime - beats[move.startBeat]) > BEAT_TIME_TOLERANCE:
                raise ValueError(f"move {move.id}: startTime must equal song.beats[startBeat]")
        for prev, nxt in zip(self.moves, self.moves[1:]):
            if nxt.startTime < prev.endTime - 1e-6:
                raise ValueError(f"moves {prev.id} and {nxt.id} overlap or are out of order")
        return self

    def to_json_dict(self) -> dict[str, Any]:
        """Serialize for the wire / disk. Omits unset optionals so the output validates against the schema."""
        return self.model_dump(mode="json", exclude_none=True)
