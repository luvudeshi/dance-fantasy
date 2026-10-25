"""Choreographer test fixtures (plain module): a small hand-made CompiledMove library and hand-built analyses.

Coded only against app.moves.types, so these tests don't depend on the real move library.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from app.analysis import Analysis
from app.audio.analysis import ANALYSIS_VERSION
from app.choreo.generator import NEUTRAL_POSE
from app.moves.types import CompiledMove, MoveKeyframe, MoveLibrary
from app.routine import Routine
from app.skeleton import MIRROR

UPPER = ("l_elbow", "r_elbow", "l_wrist", "r_wrist")
FULL = UPPER + ("l_knee", "r_knee", "l_ankle", "r_ankle")

# Poses: overrides of the neutral pose (dancer's right = +x).
ARMS_UP = {"l_elbow": (-0.5, -1.6), "r_elbow": (0.5, -1.6), "l_wrist": (-0.55, -2.2), "r_wrist": (0.55, -2.2)}
R_ARM_UP = {"r_elbow": (0.5, -1.6), "r_wrist": (0.55, -2.2)}
R_ARM_OUT = {"r_elbow": (1.0, -1.0), "r_wrist": (1.55, -1.0)}
R_POINT = {"r_elbow": (0.8, -1.5), "r_wrist": (1.1, -2.0)}
CLAP = {"l_elbow": (-0.4, -1.2), "r_elbow": (0.4, -1.2), "l_wrist": (-0.02, -1.6), "r_wrist": (0.02, -1.6)}
HEART = {"l_elbow": (-0.6, -1.5), "r_elbow": (0.6, -1.5), "l_wrist": (-0.05, -1.9), "r_wrist": (0.05, -1.9)}
SHIMMY = {"l_shoulder": (-0.5, -0.95), "r_shoulder": (0.4, -1.05)}
R_KICK = {"r_knee": (0.35, 0.6), "r_ankle": (0.5, 1.3)}
SQUAT = {"l_knee": (-0.45, 0.7), "r_knee": (0.45, 0.7), "l_ankle": (-0.3, 1.4), "r_ankle": (0.3, 1.4)}
STAR = {**ARMS_UP, "l_wrist": (-1.3, -2.0), "r_wrist": (1.3, -2.0), "l_ankle": (-0.6, 1.8), "r_ankle": (0.6, 1.8)}
BOW = {"nose": (0.0, -1.2), "l_eye": (-0.07, -1.25), "r_eye": (0.07, -1.25), "l_ear": (-0.15, -1.2), "r_ear": (0.15, -1.2)}
R_LUNGE = {"r_knee": (0.7, 0.8), "r_ankle": (0.9, 1.7)}
PUMP = {"l_elbow": (-0.6, -1.4), "r_elbow": (0.6, -1.4), "l_wrist": (-0.4, -2.0), "r_wrist": (0.4, -2.0)}


def pose(*overrides: dict[str, tuple[float, float]]) -> dict[str, tuple[float, float]]:
    out = dict(NEUTRAL_POSE)
    for o in overrides:
        out.update(o)
    return out


def mirror_pose(p: dict[str, tuple[float, float]]) -> dict[str, tuple[float, float]]:
    return {MIRROR[j]: (-x, y) for j, (x, y) in p.items()}


def move(
    base: str,
    name: str,
    length: int,
    intensity: int,
    difficulty: str,
    upper: bool,
    frames: Sequence[tuple[float, dict[str, tuple[float, float]]] | tuple[float, dict, tuple[float, float]]],
    *,
    side: str = "both",
    styles: tuple[str, ...] = ("pop",),
    end_anchor: str = "neutral",
) -> list[CompiledMove]:
    """One move (side 'both') or an R/L mirror pair (frames describe the R version)."""
    kfs = tuple(MoveKeyframe(t=f[0], pose=f[1], root=f[2] if len(f) > 2 else (0.0, 0.0)) for f in frames)
    common: dict[str, Any] = {
        "baseId": base,
        "lengthBeats": length,
        "intensity": intensity,
        "difficulty": difficulty,
        "bodyParts": ("arms",) if upper else ("arms", "legs"),
        "upperBodyOnly": upper,
        "styles": styles,
        "scoredJoints": UPPER if upper else FULL,
        "endAnchor": end_anchor,
    }
    if side == "both":
        return [CompiledMove(id=base, name=name, keyframes=kfs, side="both", **common)]
    right = CompiledMove(id=f"{base}_R", name=f"{name} Right", keyframes=kfs, side="R", **common)
    left_kfs = tuple(MoveKeyframe(t=k.t, pose=mirror_pose(k.pose), root=(-k.root[0], k.root[1])) for k in kfs)
    left = CompiledMove(id=f"{base}_L", name=f"{name} Left", keyframes=left_kfs, side="L", mirrorOf=f"{base}_R", **common)
    return [left, right]


N = pose()


def fixture_moves() -> list[CompiledMove]:
    m: list[CompiledMove] = []
    m += move("arm_wave", "Wave", 4, 2, "easy", True, [(0, N), (0.33, pose(R_ARM_UP)), (0.66, pose(R_ARM_OUT)), (1, N)], side="R")
    m += move("arm_raise", "Arms Up", 4, 1, "easy", True, [(0, N), (0.5, pose(ARMS_UP)), (1, N)])
    m += move("clap_up", "Clap Up", 2, 3, "easy", True, [(0, N), (0.5, pose(CLAP)), (1, N)])
    m += move(
        "step_touch", "Step Touch", 4, 2, "easy", False, [(0, N), (0.5, pose(R_KICK), (0.3, 0.0)), (1, N)], side="R"
    )
    m += move("heart_hands", "Heart Hands", 2, 2, "easy", True, [(0, N), (0.5, pose(HEART)), (1, N)])
    m += move("clap_party", "Party Claps", 4, 3, "easy", True, [(0, N), (0.25, pose(CLAP)), (0.5, pose(ARMS_UP)), (1, N)])
    m += move("sway", "Royal Sway", 8, 1, "easy", True, [(0, N), (0.5, pose(SHIMMY)), (1, N)])
    m += move("curtsy", "Curtsy", 4, 1, "easy", False, [(0, N), (0.5, pose(SQUAT, BOW), (0, 0.3)), (1, N)],
              styles=("storybook", "finale"))
    m += move("royal_bow", "Royal Bow", 4, 1, "easy", True, [(0, N), (0.5, pose(BOW)), (1, N)], styles=("storybook", "finale"))
    m += move("disco_point", "Disco Point", 4, 3, "normal", True, [(0, N), (0.5, pose(R_POINT)), (1, N)], side="R")
    m += move("princess_twirl", "Princess Twirl", 8, 3, "normal", False, [(0, N), (0.5, pose(SQUAT)), (1, pose(ARMS_UP))],
              styles=("storybook",), end_anchor="arms_up")
    m += move("kick", "Kick", 2, 4, "normal", False, [(0, N), (0.5, pose(R_KICK)), (1, N)], side="R")
    m += move("shimmy", "Shimmy", 4, 3, "normal", True, [(0, N), (0.5, pose(SHIMMY)), (1, N)])
    m += move("pump_arms", "Pump It", 4, 4, "normal", True, [(0, N), (0.5, pose(PUMP)), (1, N)])
    m += move("raise_roof", "Raise the Roof", 4, 5, "normal", True, [(0, pose(ARMS_UP)), (0.5, pose(PUMP)), (1, pose(ARMS_UP))],
              end_anchor="arms_up")
    m += move("clap_hit", "Clap Hit", 1, 3, "normal", True, [(0, N), (1, pose(CLAP))])
    m += move("jump_star", "Star Jump", 4, 5, "hard", False, [(0, N), (0.5, pose(STAR), (0, -0.4)), (1, N)])
    m += move("punch_hit", "Punch", 1, 4, "hard", True, [(0, N), (1, pose(R_ARM_OUT))], side="R")
    m += move("hip_roll", "Hip Roll", 8, 4, "hard", False, [(0, N), (0.5, pose(SQUAT), (0.2, 0.3)), (1, N)])
    m += move("side_lunge", "Side Lunge", 4, 4, "hard", False, [(0, N), (0.5, pose(R_LUNGE), (0.3, 0.2)), (1, N)], side="R")
    m += move("stomp", "Stomp", 1, 5, "hard", False, [(0, N), (1, pose(SQUAT))])
    return m


def fixture_library(version: str = "fixture-v1", without: Sequence[str] = ()) -> MoveLibrary:
    return MoveLibrary(moves=tuple(m for m in fixture_moves() if m.baseId not in without), version=version)


def big_library(copies: int = 4) -> MoveLibrary:
    """~copies x the fixture, with distinct ids/baseIds (performance tests)."""
    out = []
    for c in range(copies):
        for m in fixture_moves():
            sfx = f"__{c}"
            out.append(
                CompiledMove(
                    **{**m.__dict__, "id": m.id + sfx, "baseId": m.baseId + sfx, "mirrorOf": m.mirrorOf and m.mirrorOf + sfx}
                )
            )
    return MoveLibrary(moves=tuple(out), version=f"big-{copies}")


# (label, group, bars, energy)
DEFAULT_LAYOUT: list[tuple[str, str, int, float]] = [
    ("intro", "A", 4, 0.25),
    ("verse", "B", 8, 0.45),
    ("chorus", "C", 8, 0.95),
    ("verse", "B", 6, 0.45),  # shorter repeat: plays a prefix of B
    ("chorus", "C", 8, 0.95),
    ("bridge", "D", 3, 0.6),
    ("outro", "E", 3, 0.1),
]


def make_analysis(
    layout: Sequence[tuple[str, str, int, float]] = DEFAULT_LAYOUT,
    *,
    bpm: float = 120.0,
    pickup: int = 1,
    trailing: int = 3,
    first_beat: float = 0.25,
    analysis_id: str = "ab" * 32,
) -> Analysis:
    """A hand-built Analysis: ``pickup`` beats, the layout's full bars, then ``trailing`` beats (< 1 bar)."""
    period = 60.0 / bpm
    n = pickup + 4 * sum(b for _, _, b, _ in layout) + trailing
    beats = [round(first_beat + i * period, 4) for i in range(n)]
    sections, energy = [], []
    start_beat = 0
    for i, (label, group, bars, e) in enumerate(layout):
        end_beat = n if i == len(layout) - 1 else pickup + 4 * sum(b for _, _, b, _ in layout[: i + 1])
        sections.append(
            {
                "start": 0.0 if i == 0 else beats[start_beat],
                "end": round(beats[-1] + period, 4) if i == len(layout) - 1 else beats[end_beat],
                "label": label,
                "energy": e,
                "group": group,
                "startBeat": start_beat,
                "endBeat": end_beat,
                "bars": sum(1 for b in range(start_beat, end_beat) if b >= pickup and (b - pickup) % 4 == 0),
            }
        )
        energy += [e] * (end_beat - start_beat)
        start_beat = end_beat
    return Analysis.model_validate(
        {
            "id": analysis_id,
            "analysisVersion": ANALYSIS_VERSION,
            "title": "Fixture Song",
            "artist": "pytest",
            "source": {"kind": "library", "file": "fixture.wav"},
            "audioUrl": "/api/songs/fixture.wav",
            "durationSec": round(beats[-1] + period, 4),
            "sampleRate": 22050,
            "bpm": bpm,
            "beatsPerBar": 4,
            "beats": beats,
            "filledBeats": [],
            "downbeats": beats[pickup::4],
            "downbeatPhase": pickup % 4,
            "onsetEnvelope": {"hopSec": 0.05, "values": []},
            "beatEnergy": energy,
            "sections": sections,
            "elapsedMs": 0.0,
            "cached": False,
        }
    )


def check_layout(routine: Routine, check_trailing_full: bool = False) -> None:
    """Beat-grid invariants of a generated routine (see shared/README.md and the generator docstring)."""
    beats = routine.song.beats
    n = len(beats)
    downs = [beats.index(d) for d in routine.song.downbeats]
    if not downs:
        assert routine.moves == []
        return
    d0 = downs[0]
    full_end = d0 + 4 * ((n - d0) // 4)
    covered: list[int] = []
    for mv in routine.moves:
        s, ln = mv.startBeat, mv.lengthBeats
        assert s >= d0, f"{mv.id} starts in the pickup"
        assert mv.startTime == beats[s]
        if s + ln < n:
            assert mv.endTime == beats[s + ln]
        else:
            assert mv.endTime > beats[-1]
        pos = (s - d0) % 4
        if ln % 4 == 0:
            assert pos == 0 and s in downs, f"{mv.id} ({ln} beats) must start on a downbeat"
        else:
            assert 4 % ln == 0 and pos % ln == 0 and pos + ln <= 4, f"{mv.id} crosses a bar line or is misaligned"
        assert s + ln <= n, f"{mv.id} runs past the last beat"
        covered += range(s, s + ln)
    assert len(covered) == len(set(covered)), "moves overlap"
    assert sorted(covered) == covered, "moves out of order"
    assert set(range(d0, full_end)) <= set(covered), "a full bar is not covered"
    extra = set(covered) - set(range(d0, full_end))
    assert extra <= set(range(full_end, n)), "moves outside the song"
    if check_trailing_full:
        assert extra == set(range(full_end, n))


def section_moves(routine: Routine) -> list[list[tuple[int, str]]]:
    """Per section: [(beat offset from the section's first move, move id)]."""
    out = []
    for row in routine.meta["sectionPlan"]:
        if row["firstMove"] is None:
            out.append([])
            continue
        mvs = routine.moves[row["firstMove"] : row["lastMove"] + 1]
        out.append([(mv.startBeat - mvs[0].startBeat, mv.id) for mv in mvs])
    return out
