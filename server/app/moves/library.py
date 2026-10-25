"""Move library loader: assets/moves/*.json (angle keyframes) -> MoveLibrary of CompiledMoves.

Authoring format: assets/moves/README.md. ``load_library()`` is cached per (directory, file names + mtimes),
so editing a move file is picked up on the next call. Any problem raises MoveDefinitionError naming the
file and move id.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.moves.anchors import ANCHOR_TOLERANCE, ANCHORS, anchor_distance
from app.moves.fk import ANGLE_KEYS, LATERAL_KEYS, LEG_KEYS, RANGES, forward_kinematics
from app.moves.types import BodyPart, CompiledMove, MoveKeyframe, MoveLibrary, Pose
from app.skeleton import JOINTS, MIRROR

# Bump when the compiler/FK changes in a way that changes compiled poses (part of the library version).
COMPILER_VERSION = "fk-1"
LENGTHS = (1, 2, 4, 8)
DIFFICULTIES = ("easy", "normal", "hard")
SIDES = ("L", "R", "both")
ROUND = 4  # decimals in compiled poses
SHORTHANDS = {"shoulders": "shoulder", "elbows": "elbow", "hips": "hip", "knees": "knee", "lifts": "lift"}
MOVE_FIELDS = {
    "id", "name", "lengthBeats", "intensity", "difficulty", "styles", "side", "mirror", "scoredJoints",
    "startAnchor", "endAnchor", "upperBodyOnly", "keyframes", "notes",
}  # fmt: skip
KEYFRAME_FIELDS = {"t", "beat", "from", "angles"}
ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
SCORE_THRESHOLD = 0.1  # a limb is scored when its distal joint leaves neutral by more than this
ARM_ANGLES = {"l": ("l_shoulder", "l_elbow"), "r": ("r_shoulder", "r_elbow")}


class MoveDefinitionError(ValueError):
    """A move definition file is invalid."""


def default_moves_dir() -> Path:
    return get_settings().assets_dir / "moves"


# --- angles ---------------------------------------------------------------------------------


def _expand(angles: Mapping[str, Any], where: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for key, value in angles.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise MoveDefinitionError(f"{where}: angle {key!r} must be a finite number, got {value!r}")
        keys = [f"l_{SHORTHANDS[key]}", f"r_{SHORTHANDS[key]}"] if key in SHORTHANDS else [key]
        for k in keys:
            if k not in RANGES:
                raise MoveDefinitionError(f"{where}: unknown angle {key!r} (known: {', '.join(ANGLE_KEYS)}, {', '.join(SHORTHANDS)})")
            lo, hi = RANGES[k]
            if not lo <= value <= hi:
                raise MoveDefinitionError(f"{where}: {k}={value} is outside [{lo}, {hi}]")
            out[k] = float(value)
    return out


def mirror_angles(angles: Mapping[str, float]) -> dict[str, float]:
    """Swap l_/r_ angles and negate the signed lateral parameters: the result's FK is the geometric mirror."""
    out: dict[str, float] = {}
    for key, value in angles.items():
        if key.startswith("l_"):
            out["r_" + key[2:]] = value
        elif key.startswith("r_"):
            out["l_" + key[2:]] = value
        elif key in LATERAL_KEYS:
            out[key] = -value
        else:
            out[key] = value
    return out


def _round_pose(pose: Pose) -> Pose:
    return {j: (round(x, ROUND) + 0.0, round(y, ROUND) + 0.0) for j, (x, y) in pose.items()}


# --- compile ------------------------------------------------------------------------------------


def _resolve_keyframes(raw: dict[str, Any], where: str) -> list[tuple[float, dict[str, float]]]:
    """[(t, full angle dict)] with inheritance applied."""
    length = raw["lengthBeats"]
    frames = raw.get("keyframes")
    if not isinstance(frames, list) or len(frames) < 2:
        raise MoveDefinitionError(f"{where}: keyframes must be a list of at least 2 entries")
    current: dict[str, float] = {}
    out: list[tuple[float, dict[str, float]]] = []
    for i, kf in enumerate(frames):
        kw = f"{where} keyframe {i}"
        if not isinstance(kf, dict):
            raise MoveDefinitionError(f"{kw}: must be an object")
        extra = set(kf) - KEYFRAME_FIELDS
        if extra:
            raise MoveDefinitionError(f"{kw}: unknown fields {sorted(extra)}")
        if ("t" in kf) == ("beat" in kf):
            raise MoveDefinitionError(f"{kw}: give exactly one of 't' (0..1) or 'beat' (0..lengthBeats)")
        t = kf["t"] if "t" in kf else kf["beat"] / length
        if isinstance(t, bool) or not isinstance(t, (int, float)) or not 0 <= t <= 1:
            raise MoveDefinitionError(f"{kw}: t must be within [0, 1], got {t!r}")
        if "from" in kf:
            if kf["from"] not in ANCHORS:
                raise MoveDefinitionError(f"{kw}: unknown anchor {kf['from']!r} (known: {', '.join(ANCHORS)})")
            current = dict(ANCHORS[kf["from"]])
        angles = kf.get("angles", {})
        if not isinstance(angles, dict):
            raise MoveDefinitionError(f"{kw}: angles must be an object")
        current = {**current, **_expand(angles, kw)}
        out.append((float(t), {k: v for k, v in current.items() if v != 0.0}))
    ts = [t for t, _ in out]
    if any(b <= a for a, b in zip(ts, ts[1:])):
        raise MoveDefinitionError(f"{where}: keyframe times must be strictly ascending, got {ts}")
    if ts[0] != 0 or ts[-1] != 1:
        raise MoveDefinitionError(f"{where}: first keyframe must be at t=0 and last at t=1 (beat {length})")
    for k in range(length + 1):
        if not any(abs(t - k / length) < 1e-9 for t in ts):
            raise MoveDefinitionError(f"{where}: missing a keyframe on beat {k} (t={k / length:g}); every beat needs one")
    return out


def _scored_joints(poses: list[Pose], neutral: Pose) -> tuple[str, ...]:
    def moved(j: str) -> bool:
        nx, ny = neutral[j]
        return any(math.hypot(p[j][0] - nx, p[j][1] - ny) > SCORE_THRESHOLD for p in poses)

    scored: set[str] = set()
    for chain in (("l_elbow", "l_wrist"), ("r_elbow", "r_wrist"), ("l_knee", "l_ankle"), ("r_knee", "r_ankle")):
        if any(moved(j) for j in chain):
            scored.update(chain)
    # Torso (scored via the shoulders, shared/README.md): when the upper body leans or turns.
    if any(abs(p["l_shoulder"][0] + p["r_shoulder"][0]) / 2 > 0.05 or abs(p["r_shoulder"][0] - p["l_shoulder"][0]) < 0.8 for p in poses):
        scored.update(("l_shoulder", "r_shoulder"))
    return tuple(j for j in JOINTS if j in scored)


def _body_parts(frames: list[dict[str, float]]) -> tuple[BodyPart, ...]:
    used = {k for f in frames for k in f}
    parts: list[BodyPart] = []
    if used & {"l_shoulder", "r_shoulder", "l_elbow", "r_elbow"}:
        parts.append("arms")
    if used & (LEG_KEYS - {"travel", "turn"}):
        parts.append("legs")
    if used & {"torso_lean", "turn"}:
        parts.append("torso")
    if "head_tilt" in used:
        parts.append("head")
    return tuple(parts)


def _compile(
    raw: dict[str, Any], frames: list[tuple[float, dict[str, float]]], where: str, mirrored: bool
) -> CompiledMove:
    base_id: str = raw["id"]
    side: str = raw.get("side", "both")
    if mirrored:
        frames = [(t, mirror_angles(a)) for t, a in frames]
        side = {"L": "R", "R": "L"}[side]
    keyframes: list[MoveKeyframe] = []
    for t, angles in frames:
        pose, root = forward_kinematics(angles)
        keyframes.append(MoveKeyframe(t=t, pose=_round_pose(pose), root=(round(root[0], ROUND) + 0.0, round(root[1], ROUND) + 0.0)))
    angle_frames = [a for _, a in frames]
    leg_free = not any(k in LEG_KEYS for a in angle_frames for k in a)
    upper_only = raw.get("upperBodyOnly", leg_free)
    if "scoredJoints" in raw:
        scored = tuple(MIRROR[j] for j in raw["scoredJoints"]) if mirrored else tuple(raw["scoredJoints"])
        scored = tuple(j for j in JOINTS if j in scored)
    else:
        scored = _scored_joints([k.pose for k in keyframes], forward_kinematics({})[0])
    mirror = bool(raw.get("mirror", False))
    suffix = f"_{side}" if mirror else ""
    word = {"L": " Left", "R": " Right"}.get(side, "") if mirror else ""
    move = CompiledMove(
        id=base_id + suffix,
        baseId=base_id,
        name=raw["name"] + word,
        lengthBeats=raw["lengthBeats"],
        intensity=raw["intensity"],
        difficulty=raw["difficulty"],
        bodyParts=_body_parts(angle_frames),
        upperBodyOnly=bool(upper_only),
        styles=tuple(raw["styles"]),
        scoredJoints=scored,
        keyframes=tuple(keyframes),
        startAnchor=raw.get("startAnchor", "neutral"),
        endAnchor=raw.get("endAnchor", "neutral"),
        side=side,  # type: ignore[arg-type]
        mirrorOf=(base_id + "_" + raw.get("side", "both")) if mirrored else None,
    )
    for label, kf, anchor in (("first", keyframes[0], move.startAnchor), ("last", keyframes[-1], move.endAnchor)):
        dist = anchor_distance(kf.pose, kf.root, anchor)
        if dist > ANCHOR_TOLERANCE:
            raise MoveDefinitionError(
                f"{where}: {label} keyframe is {dist:.2f} body units from anchor {anchor!r} (tolerance {ANCHOR_TOLERANCE})"
            )
    return move


def _validate_move(raw: Any, where: str) -> None:
    if not isinstance(raw, dict):
        raise MoveDefinitionError(f"{where}: each move must be an object")
    extra = set(raw) - MOVE_FIELDS
    if extra:
        raise MoveDefinitionError(f"{where}: unknown fields {sorted(extra)}")
    missing = {"id", "name", "lengthBeats", "intensity", "difficulty", "styles", "keyframes"} - set(raw)
    if missing:
        raise MoveDefinitionError(f"{where}: missing fields {sorted(missing)}")
    if not isinstance(raw["id"], str) or not ID_RE.match(raw["id"]) or re.search(r"_[LR]$", raw["id"], re.I):
        raise MoveDefinitionError(f"{where}: id must be snake_case without an _L/_R suffix")
    if not isinstance(raw["name"], str) or not raw["name"].strip():
        raise MoveDefinitionError(f"{where}: name must be a non-empty string")
    if raw["lengthBeats"] not in LENGTHS or isinstance(raw["lengthBeats"], bool):
        raise MoveDefinitionError(f"{where}: lengthBeats must be one of {LENGTHS}")
    if raw["intensity"] not in (1, 2, 3, 4, 5) or isinstance(raw["intensity"], bool):
        raise MoveDefinitionError(f"{where}: intensity must be an integer 1..5")
    if raw["difficulty"] not in DIFFICULTIES:
        raise MoveDefinitionError(f"{where}: difficulty must be one of {DIFFICULTIES}")
    styles = raw["styles"]
    if not isinstance(styles, list) or not styles or not all(isinstance(s, str) and s for s in styles):
        raise MoveDefinitionError(f"{where}: styles must be a non-empty list of strings")
    side = raw.get("side", "both")
    if side not in SIDES:
        raise MoveDefinitionError(f"{where}: side must be one of {SIDES}")
    if raw.get("mirror", False) and side == "both":
        raise MoveDefinitionError(f"{where}: mirror needs side 'L' or 'R' (which side the definition leads with)")
    for key in ("startAnchor", "endAnchor"):
        if key in raw and raw[key] not in ANCHORS:
            raise MoveDefinitionError(f"{where}: {key} {raw[key]!r} is not an anchor ({', '.join(ANCHORS)})")
    if "scoredJoints" in raw:
        sj = raw["scoredJoints"]
        if not isinstance(sj, list) or not sj or any(j not in JOINTS for j in sj) or len(set(sj)) != len(sj):
            raise MoveDefinitionError(f"{where}: scoredJoints must be a non-empty list of unique joint names")
    if "upperBodyOnly" in raw and not isinstance(raw["upperBodyOnly"], bool):
        raise MoveDefinitionError(f"{where}: upperBodyOnly must be a boolean")


def compile_move(raw: dict[str, Any], where: str = "move") -> list[CompiledMove]:
    """One definition -> its compiled move(s): the original, plus the mirrored variant when ``mirror`` is set."""
    where = f"{where} {raw.get('id', '?')!r}" if isinstance(raw, dict) else where
    _validate_move(raw, where)
    frames = _resolve_keyframes(raw, where)
    moves = [_compile(raw, frames, where, mirrored=False)]
    if raw.get("mirror", False):
        moves.append(_compile(raw, frames, where, mirrored=True))
    return moves


def _parse_file(name: str, content: bytes) -> list[dict[str, Any]]:
    try:
        doc = json.loads(content)
    except json.JSONDecodeError as exc:
        raise MoveDefinitionError(f"{name}: invalid JSON ({exc})") from None
    if not isinstance(doc, dict) or not isinstance(doc.get("moves"), list):
        raise MoveDefinitionError(f"{name}: expected an object with a 'moves' list")
    extra = set(doc) - {"moves", "defaults", "notes"}
    if extra:
        raise MoveDefinitionError(f"{name}: unknown top-level fields {sorted(extra)}")
    defaults = doc.get("defaults", {})
    if not isinstance(defaults, dict):
        raise MoveDefinitionError(f"{name}: defaults must be an object")
    return [{**defaults, **m} if isinstance(m, dict) else m for m in doc["moves"]]


def build_library(files: list[tuple[str, bytes]]) -> MoveLibrary:
    """Compile (file name, content) pairs into a MoveLibrary."""
    digest = hashlib.sha256(COMPILER_VERSION.encode() + json.dumps(ANCHORS, sort_keys=True).encode())
    moves: list[CompiledMove] = []
    seen_ids: dict[str, str] = {}
    for name, content in sorted(files):
        digest.update(b"\0" + name.encode() + b"\0" + content)
        for raw in _parse_file(name, content):
            for move in compile_move(raw, where=name):
                if move.id in seen_ids:
                    raise MoveDefinitionError(f"{name}: duplicate move id {move.id!r} (also in {seen_ids[move.id]})")
                seen_ids[move.id] = name
                moves.append(move)
    return MoveLibrary(moves=tuple(moves), version=digest.hexdigest()[:12])


_cache: dict[tuple[str, tuple[tuple[str, int, int], ...]], MoveLibrary] = {}
_lock = threading.Lock()


def load_library(moves_dir: Path | None = None) -> MoveLibrary:
    """Load and compile every ``*.json`` move file in ``moves_dir`` (default: assets/moves). Cached per file mtimes."""
    directory = (moves_dir or default_moves_dir()).resolve()
    if not directory.is_dir():
        raise MoveDefinitionError(f"move directory not found: {directory}")
    paths = sorted(p for p in directory.glob("*.json") if p.is_file() and not p.name.startswith("."))
    key = (str(directory), tuple((p.name, p.stat().st_mtime_ns, p.stat().st_size) for p in paths))
    with _lock:
        hit = _cache.get(key)
        if hit is not None:
            return hit
        library = build_library([(p.name, p.read_bytes()) for p in paths])
        _cache.clear()  # keep only the latest state of each directory around (small)
        _cache[key] = library
        return library


def move_to_json(m: CompiledMove) -> dict[str, Any]:
    """CompiledMove -> LibraryMove (shared/moves.ts)."""
    return {
        "id": m.id,
        "baseId": m.baseId,
        "name": m.name,
        "lengthBeats": m.lengthBeats,
        "intensity": m.intensity,
        "difficulty": m.difficulty,
        "bodyParts": list(m.bodyParts),
        "upperBodyOnly": m.upperBodyOnly,
        "styles": list(m.styles),
        "scoredJoints": list(m.scoredJoints),
        "keyframes": [
            {"t": k.t, "pose": {j: [x, y] for j, (x, y) in k.pose.items()}, "root": [k.root[0], k.root[1]]}
            for k in m.keyframes
        ],
        "startAnchor": m.startAnchor,
        "endAnchor": m.endAnchor,
        "side": m.side,
        "mirrorOf": m.mirrorOf,
    }


def library_to_json(lib: MoveLibrary) -> dict[str, Any]:
    return {"version": lib.version, "moves": [move_to_json(m) for m in lib.moves]}
