"""Real-dancer motion clips: assets/moves/aist_clips.json -> CompiledMoves (plus their geometric mirrors).

The clips are short 2D pose sequences derived from the AIST++ dance dataset by server/scripts/aist/build_clips.py
(file contract: README "AIST++ motion clips"). Unlike the angle-based library moves they are already poses, so
there is no FK here: the loader validates them and turns each clip into a CompiledMove with free anchors
(``FREE_ANCHOR``: real dancers don't start or end on our named anchors; the choreographer chains them by the
end -> start pose distance instead) and, when ``mirror`` is set, a mirrored twin ``<id>_m``.

Any problem raises MoveDefinitionError naming the file and clip id, like the move files.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

from app.moves.types import BodyPart, CompiledMove, MoveKeyframe, Pose, Vec2
from app.skeleton import JOINTS, MIRROR

CLIPS_FILE = "aist_clips.json"
FREE_ANCHOR = "free"  # start/end anchor of a clip: matches any pose; transitions are costed by distance
SOURCE_STYLE = "aist"  # style tag every clip carries
MIRROR_SUFFIX = "_m"
CLIP_LENGTHS = (1, 2, 4, 8)
ROUND = 4  # decimals kept in compiled poses (clips come with 3)
MAX_COORD = 10.0  # body units; anything farther from mid-hip is a broken frame
ON_BEAT_TOL = 1e-6
CLIP_FIELDS = {
    "id", "name", "genre", "styles", "lengthBeats", "intensity", "difficulty", "upperBodyOnly", "bodyParts",
    "scoredJoints", "mirror", "side", "sourceSeq", "sourceStartSec", "bpm", "keyframes", "notes",
}  # fmt: skip
REQUIRED = {"id", "name", "styles", "lengthBeats", "intensity", "difficulty", "upperBodyOnly", "scoredJoints", "keyframes"}
ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
GENRE_NAMES = {
    "BR": "Break", "PO": "Pop", "LO": "Lock", "MH": "Middle Hip-hop", "LH": "LA Hip-hop", "HO": "House",
    "WA": "Waack", "KR": "Krump", "JS": "Street Jazz", "JB": "Ballet Jazz",
}  # fmt: skip
CREDIT = "Real-dancer move: AIST++ (CC BY 4.0) · AIST Dance Video Database"


class ClipError(ValueError):
    """Raised by parse_clips; app.moves.library re-raises it as MoveDefinitionError."""


def _num(v: Any) -> bool:
    return not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)


def _vec(v: Any, where: str) -> Vec2:
    if not isinstance(v, list) or len(v) != 2 or not all(_num(c) for c in v):
        raise ClipError(f"{where}: expected [x, y] finite numbers, got {v!r}")
    x, y = float(v[0]), float(v[1])
    if abs(x) > MAX_COORD or abs(y) > MAX_COORD:
        raise ClipError(f"{where}: {v!r} is more than {MAX_COORD} body units from mid-hip")
    return (round(x, ROUND) + 0.0, round(y, ROUND) + 0.0)


def _keyframes(raw: Any, length: int, where: str) -> tuple[MoveKeyframe, ...]:
    if not isinstance(raw, list) or len(raw) < 2:
        raise ClipError(f"{where}: keyframes must be a list of at least 2 entries")
    out: list[MoveKeyframe] = []
    for i, kf in enumerate(raw):
        kw = f"{where} keyframe {i}"
        if not isinstance(kf, dict) or set(kf) - {"t", "pose", "root"} or "t" not in kf or "pose" not in kf:
            raise ClipError(f"{kw}: expected {{t, pose, root}}")
        t = kf["t"]
        if not _num(t) or not 0 <= t <= 1:
            raise ClipError(f"{kw}: t must be within [0, 1], got {t!r}")
        pose = kf["pose"]
        if not isinstance(pose, dict) or set(pose) != set(JOINTS):
            missing = sorted(set(JOINTS) - set(pose)) if isinstance(pose, dict) else "all"
            raise ClipError(f"{kw}: pose must have exactly the 17 joints (missing {missing})")
        beat = t * length
        if abs(beat - round(beat)) < 1e-3:  # snap on-beat times (3-decimal rounding) to the exact fraction
            t = round(beat) / length
        out.append(
            MoveKeyframe(
                t=float(t),
                pose={j: _vec(pose[j], f"{kw} {j}") for j in JOINTS},
                root=_vec(kf.get("root", [0.0, 0.0]), f"{kw} root"),
            )
        )
    ts = [k.t for k in out]
    if any(b <= a for a, b in zip(ts, ts[1:])):
        raise ClipError(f"{where}: keyframe times must be strictly ascending")
    if ts[0] != 0 or ts[-1] != 1:
        raise ClipError(f"{where}: first keyframe must be at t=0 and last at t=1")
    for k in range(length + 1):
        if not any(abs(t - k / length) < ON_BEAT_TOL for t in ts):
            raise ClipError(f"{where}: missing the on-beat keyframe for beat {k} (t={k / length:g})")
    return tuple(out)


def _validate(raw: Any, where: str) -> None:
    if not isinstance(raw, dict):
        raise ClipError(f"{where}: each clip must be an object")
    extra = set(raw) - CLIP_FIELDS
    if extra:
        raise ClipError(f"{where}: unknown fields {sorted(extra)}")
    missing = REQUIRED - set(raw)
    if missing:
        raise ClipError(f"{where}: missing fields {sorted(missing)}")
    cid = raw["id"]
    if not isinstance(cid, str) or not ID_RE.match(cid) or re.search(r"_([lr]|m)$", cid):
        raise ClipError(f"{where}: id must be lowercase snake_case without an _l/_r/_m suffix")
    if not isinstance(raw["name"], str) or not raw["name"].strip():
        raise ClipError(f"{where}: name must be a non-empty string")
    if raw["lengthBeats"] not in CLIP_LENGTHS or isinstance(raw["lengthBeats"], bool):
        raise ClipError(f"{where}: lengthBeats must be one of {CLIP_LENGTHS}")
    if raw["intensity"] not in (1, 2, 3, 4, 5) or isinstance(raw["intensity"], bool):
        raise ClipError(f"{where}: intensity must be an integer 1..5")
    if raw["difficulty"] not in ("easy", "normal", "hard"):
        raise ClipError(f"{where}: difficulty must be easy, normal or hard")
    styles = raw["styles"]
    if not isinstance(styles, list) or not styles or not all(isinstance(s, str) and s for s in styles):
        raise ClipError(f"{where}: styles must be a non-empty list of strings")
    if not isinstance(raw["upperBodyOnly"], bool) or not isinstance(raw.get("mirror", False), bool):
        raise ClipError(f"{where}: upperBodyOnly and mirror must be booleans")
    if raw.get("side", "both") not in ("L", "R", "both"):
        raise ClipError(f"{where}: side must be L, R or both")
    sj = raw["scoredJoints"]
    if not isinstance(sj, list) or not sj or any(j not in JOINTS for j in sj) or len(set(sj)) != len(sj):
        raise ClipError(f"{where}: scoredJoints must be a non-empty list of unique joint names")
    parts = raw.get("bodyParts", [])
    if not isinstance(parts, list) or any(p not in ("arms", "legs", "torso", "head") for p in parts):
        raise ClipError(f"{where}: bodyParts must list arms / legs / torso / head")
    for key, ok in (("genre", isinstance(raw.get("genre", ""), str)), ("sourceSeq", isinstance(raw.get("sourceSeq", ""), str))):
        if not ok:
            raise ClipError(f"{where}: {key} must be a string")
    for key in ("sourceStartSec", "bpm"):
        if key in raw and (not _num(raw[key]) or raw[key] < 0):
            raise ClipError(f"{where}: {key} must be a non-negative number")


def _credit(raw: dict[str, Any]) -> str:
    seq = raw.get("sourceSeq")
    if not seq:
        return CREDIT
    start = raw.get("sourceStartSec")
    at = f" @ {float(start):.2f}s" if _num(start) else ""
    return f"{CREDIT} ({seq}{at})"


def mirror_pose(pose: Pose) -> Pose:
    """Geometric L/R mirror: swap l_/r_ joints and negate x (exact, no rounding)."""
    return {j: (-pose[MIRROR[j]][0] + 0.0, pose[MIRROR[j]][1]) for j in JOINTS}


def mirror_clip(move: CompiledMove) -> CompiledMove:
    """The mirrored twin ``<id>_m`` of a compiled clip."""
    side = {"L": "R", "R": "L"}.get(move.side, "both")
    return CompiledMove(
        id=move.id + MIRROR_SUFFIX,
        baseId=move.baseId,
        name=f"{move.name} (mirrored)",
        lengthBeats=move.lengthBeats,
        intensity=move.intensity,
        difficulty=move.difficulty,
        bodyParts=move.bodyParts,
        upperBodyOnly=move.upperBodyOnly,
        styles=move.styles,
        scoredJoints=tuple(j for j in JOINTS if MIRROR[j] in move.scoredJoints),
        keyframes=tuple(
            MoveKeyframe(t=k.t, pose=mirror_pose(k.pose), root=(-k.root[0] + 0.0, k.root[1])) for k in move.keyframes
        ),
        startAnchor=move.startAnchor,
        endAnchor=move.endAnchor,
        side=side,  # type: ignore[arg-type]
        mirrorOf=move.id,
        source=move.source,
        credit=move.credit,
    )


def compile_clip(raw: Any, where: str = "clip") -> list[CompiledMove]:
    """One clip definition -> [clip] or [clip, mirrored twin]."""
    where = f"{where} {raw.get('id', '?')!r}" if isinstance(raw, dict) else where
    _validate(raw, where)
    length = int(raw["lengthBeats"])
    styles = tuple(dict.fromkeys([*raw["styles"], SOURCE_STYLE]))  # keep order, ensure the source tag
    parts: tuple[BodyPart, ...] = tuple(p for p in ("arms", "legs", "torso", "head") if p in raw.get("bodyParts", []))
    move = CompiledMove(
        id=raw["id"],
        baseId=raw["id"],
        name=raw["name"].strip(),
        lengthBeats=length,
        intensity=int(raw["intensity"]),
        difficulty=raw["difficulty"],
        bodyParts=parts or (("arms",) if raw["upperBodyOnly"] else ("arms", "legs")),
        upperBodyOnly=raw["upperBodyOnly"],
        styles=styles,
        scoredJoints=tuple(j for j in JOINTS if j in raw["scoredJoints"]),
        keyframes=_keyframes(raw["keyframes"], length, where),
        startAnchor=FREE_ANCHOR,
        endAnchor=FREE_ANCHOR,
        side=raw.get("side", "both"),
        source="aist",
        credit=_credit(raw),
    )
    return [move, mirror_clip(move)] if raw.get("mirror", False) else [move]


def parse_clips(name: str, content: bytes) -> tuple[list[CompiledMove], str | None]:
    """(compiled clips incl. mirrors, attribution) from the clip file's bytes."""
    try:
        doc = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ClipError(f"{name}: invalid JSON ({exc})") from None
    if not isinstance(doc, dict) or doc.get("version") != 1 or not isinstance(doc.get("clips"), list):
        raise ClipError(f"{name}: expected {{version: 1, attribution, clips: [...]}}")
    attribution = doc.get("attribution")
    if attribution is not None and not isinstance(attribution, str):
        raise ClipError(f"{name}: attribution must be a string")
    moves: list[CompiledMove] = []
    for raw in doc["clips"]:
        moves.extend(compile_clip(raw, where=name))
    return moves, attribution
