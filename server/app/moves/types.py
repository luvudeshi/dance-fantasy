"""Compiled-move types: the interface between the move library (app.moves) and the choreographer (app.choreo).

The library turns angle-based move definitions in assets/moves/ into CompiledMoves via forward
kinematics; the choreographer only ever sees CompiledMoves. Field names are camelCase because
GET /api/moves serves them as-is (see shared/moves.ts).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Difficulty = Literal["easy", "normal", "hard"]
BodyPart = Literal["arms", "legs", "torso", "head"]
Side = Literal["L", "R", "both"]
Vec2 = tuple[float, float]
Pose = dict[str, Vec2]  # all 17 joints (app.skeleton.JOINTS), body frame

NEUTRAL_ANCHOR = "neutral"


@dataclass(frozen=True)
class MoveKeyframe:
    t: float  # 0..1 within the move; first keyframe t == 0
    pose: Pose  # all 17 joints, body frame (shared/README.md)
    root: Vec2 = (0.0, 0.0)  # rendering only: mid-hip offset from neutral standing, body units, +y down


@dataclass(frozen=True)
class CompiledMove:
    id: str  # unique, e.g. "arm_wave_L"
    baseId: str  # shared by a mirror pair, e.g. "arm_wave"
    name: str  # display name, e.g. "Wave Left"
    lengthBeats: int  # 1, 2, 4 or 8
    intensity: int  # 1..5
    difficulty: Difficulty
    bodyParts: tuple[BodyPart, ...]
    upperBodyOnly: bool  # usable in seated mode
    styles: tuple[str, ...]  # e.g. "pop", "hiphop", "latin", "storybook" (Stage 7 biases by genre)
    scoredJoints: tuple[str, ...]  # joints whose limbs are scored (distal-joint rule, shared/README.md)
    keyframes: tuple[MoveKeyframe, ...]  # ascending t
    startAnchor: str = NEUTRAL_ANCHOR  # named pose family the move starts from
    endAnchor: str = NEUTRAL_ANCHOR  # ... and ends in
    side: Side = "both"  # which side leads; mirrored variants flip L <-> R
    mirrorOf: str | None = None  # id of the move this one was mirrored from
    source: Literal["library", "aist"] = "library"  # "aist": a real-dancer clip (app.moves.clips), free anchors
    credit: str | None = None  # attribution line shown with the move (real-dancer clips)

    @property
    def startPose(self) -> Pose:
        return self.keyframes[0].pose

    @property
    def endPose(self) -> Pose:
        return self.keyframes[-1].pose


@dataclass(frozen=True)
class MoveLibrary:
    moves: tuple[CompiledMove, ...]
    version: str  # short content hash of the move definition files; part of routine cache keys
    attribution: str | None = None  # data credit for the real-dancer clips, when the library has any
    clipsError: str | None = None  # why aist_clips.json was skipped (invalid), if it was

    def by_id(self) -> dict[str, CompiledMove]:
        return {m.id: m for m in self.moves}
