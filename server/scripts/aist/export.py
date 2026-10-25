"""Clip-file contract (assets/moves/aist_clips.json, version 1): build clip dicts, validate, write.

    {"version": 1, "attribution": str, "clips": [clip, ...]}
    clip = {id, name, genre, styles, lengthBeats (4|8), intensity (1..5), difficulty, upperBodyOnly,
            bodyParts, scoredJoints, mirror: true, sourceSeq, sourceStartSec, bpm,
            keyframes: [{t, pose: {17 joints: [x, y]}, root: [x, y]}]}

Keyframes ascend in t over [0, 1], are at most half a beat apart and always include every on-beat
t = k / lengthBeats exactly. Numbers are rounded to 3 decimals. Ids are lowercase and never end in
_l / _r / _m (the loader adds the mirrored variant as "<id>_m").
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from collections.abc import Sequence as Seq
from pathlib import Path
from typing import Any

from app.skeleton import JOINTS
from scripts.aist.safe_load import NAME_RE
from scripts.aist.segment import Candidate
from scripts.aist.tags import display_name

VERSION = 1
ATTRIBUTION = (
    "Real-dancer moves derived from AIST++ (annotations (c) Google LLC, CC BY 4.0, "
    "https://google.github.io/aistplusplus_dataset/) and the AIST Dance Video Database (https://aistdancedb.ongaaccel.jp/)."
)
ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
BODY_PARTS = ("arms", "legs", "torso", "head")
DIFFICULTIES = ("easy", "normal", "hard")
DIGITS = 3


def _r(x: float) -> float:
    return round(float(x), DIGITS) + 0.0


def clip_dict(c: Candidate, clip_id: str, name: str) -> dict[str, Any]:
    keyframes = []
    for i, t in enumerate(c.times):
        keyframes.append(
            {
                "t": _r(t),
                "pose": {j: [_r(c.pose[i, k, 0]), _r(c.pose[i, k, 1])] for k, j in enumerate(JOINTS)},
                "root": [_r(c.root[i, 0]), _r(c.root[i, 1])],
            }
        )
    tags = c.tags
    return {
        "id": clip_id,
        "name": name,
        "genre": c.genre,
        "styles": list(tags["styles"]),
        "lengthBeats": int(c.length),
        "intensity": int(tags["intensity"]),
        "difficulty": tags["difficulty"],
        "upperBodyOnly": bool(tags["upperBodyOnly"]),
        "bodyParts": list(tags["bodyParts"]),
        "scoredJoints": list(tags["scoredJoints"]),
        "mirror": True,
        "sourceSeq": c.seq,
        "sourceStartSec": _r(c.t0),
        "bpm": round(float(c.bpm), 2),
        "keyframes": keyframes,
    }


def build_document(selected: Seq[Candidate]) -> dict[str, Any]:
    """Selected windows (grouped by genre, in selection order) -> clip document with ids and numbered names."""
    per_genre: Counter[str] = Counter()
    names: Counter[str] = Counter()
    clips = []
    for c in selected:
        per_genre[c.genre] += 1
        clip_id = f"aist_{c.genre.lower()}_{per_genre[c.genre]:03d}"
        base = display_name(c)
        names[base] += 1
        name = base if names[base] == 1 else f"{base} {names[base]}"
        clips.append(clip_dict(c, clip_id, name))
    return {"version": VERSION, "attribution": ATTRIBUTION, "clips": clips}


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def validate_clip(clip: Any, where: str) -> list[str]:
    errs: list[str] = []
    if not isinstance(clip, dict):
        return [f"{where}: not an object"]
    need = {"id", "name", "genre", "styles", "lengthBeats", "intensity", "difficulty", "upperBodyOnly", "bodyParts",
            "scoredJoints", "mirror", "sourceSeq", "sourceStartSec", "bpm", "keyframes"}  # fmt: skip
    missing = need - set(clip)
    if missing:
        return [f"{where}: missing {sorted(missing)}"]
    cid = clip["id"]
    if not isinstance(cid, str) or not ID_RE.match(cid) or re.search(r"_(l|r|m)$", cid):
        errs.append(f"{where}: bad id {cid!r}")
    if not isinstance(clip["name"], str) or not clip["name"].strip():
        errs.append(f"{where}: empty name")
    styles = clip["styles"]
    if not isinstance(styles, list) or "aist" not in styles or not all(isinstance(s, str) and s for s in styles):
        errs.append(f"{where}: styles must be strings and include 'aist'")
    length = clip["lengthBeats"]
    if length not in (4, 8) or isinstance(length, bool):
        errs.append(f"{where}: lengthBeats must be 4 or 8")
        return errs
    if clip["intensity"] not in (1, 2, 3, 4, 5) or isinstance(clip["intensity"], bool):
        errs.append(f"{where}: intensity must be 1..5")
    if clip["difficulty"] not in DIFFICULTIES:
        errs.append(f"{where}: bad difficulty")
    if not isinstance(clip["upperBodyOnly"], bool) or clip["mirror"] is not True:
        errs.append(f"{where}: upperBodyOnly must be a bool and mirror true")
    parts = clip["bodyParts"]
    if not isinstance(parts, list) or not parts or any(p not in BODY_PARTS for p in parts) or len(set(parts)) != len(parts):
        errs.append(f"{where}: bad bodyParts {parts!r}")
    sj = clip["scoredJoints"]
    if not isinstance(sj, list) or len(sj) < 2 or any(j not in JOINTS for j in sj) or len(set(sj)) != len(sj):
        errs.append(f"{where}: scoredJoints must be >= 2 unique joint names")
    if not isinstance(clip["sourceSeq"], str) or not NAME_RE.match(clip["sourceSeq"]):
        errs.append(f"{where}: bad sourceSeq")
    if not _num(clip["sourceStartSec"]) or clip["sourceStartSec"] < 0:
        errs.append(f"{where}: bad sourceStartSec")
    if not _num(clip["bpm"]) or not 60 <= clip["bpm"] <= 180:
        errs.append(f"{where}: bad bpm")
    kfs = clip["keyframes"]
    if not isinstance(kfs, list) or len(kfs) < 2:
        return errs + [f"{where}: keyframes must be a list"]
    if len(kfs) < 2 * length + 1:
        errs.append(f"{where}: needs at least {2 * length + 1} keyframes (every half beat)")
    ts = []
    for i, k in enumerate(kfs):
        kw = f"{where} keyframe {i}"
        if not isinstance(k, dict) or set(k) != {"t", "pose", "root"}:
            errs.append(f"{kw}: needs exactly t, pose, root")
            continue
        if not _num(k["t"]) or not 0 <= k["t"] <= 1:
            errs.append(f"{kw}: t out of [0, 1]")
            continue
        ts.append(k["t"])
        pose = k["pose"]
        if not isinstance(pose, dict) or set(pose) != set(JOINTS):
            errs.append(f"{kw}: pose must have all 17 joints")
        elif not all(isinstance(v, list) and len(v) == 2 and all(_num(x) and abs(x) < 20 for x in v) for v in pose.values()):
            errs.append(f"{kw}: pose values must be [x, y] finite numbers")
        root = k["root"]
        if not (isinstance(root, list) and len(root) == 2 and all(_num(x) and abs(x) < 5 for x in root)):
            errs.append(f"{kw}: root must be [x, y]")
    if ts:
        if any(b <= a for a, b in zip(ts, ts[1:])):
            errs.append(f"{where}: keyframe t must strictly ascend")
        if ts[0] != 0 or ts[-1] != 1:
            errs.append(f"{where}: keyframes must start at t=0 and end at t=1")
        for k in range(length + 1):
            if not any(t == round(k / length, DIGITS) for t in ts):
                errs.append(f"{where}: missing on-beat keyframe t={k / length:g}")
        gap = max(b - a for a, b in zip(ts, ts[1:])) if len(ts) > 1 else 1.0
        if gap > 1 / (2 * length) + 1.5e-3:
            errs.append(f"{where}: keyframes more than half a beat apart ({gap:.3f})")
    return errs


def validate_document(doc: Any) -> list[str]:
    if not isinstance(doc, dict):
        return ["document must be an object"]
    errs = []
    if doc.get("version") != VERSION:
        errs.append("version must be 1")
    if not isinstance(doc.get("attribution"), str) or "AIST" not in doc["attribution"]:
        errs.append("attribution must credit AIST++ / AIST")
    clips = doc.get("clips")
    if not isinstance(clips, list):
        return errs + ["clips must be a list"]
    ids = [c.get("id") for c in clips if isinstance(c, dict)]
    dupes = [i for i, n in Counter(ids).items() if n > 1]
    if dupes:
        errs.append(f"duplicate ids {dupes[:5]}")
    mirrored = {f"{i}_m" for i in ids if isinstance(i, str)}
    if mirrored & set(ids):
        errs.append("an id collides with a mirrored variant id")
    for i, c in enumerate(clips):
        errs.extend(validate_clip(c, f"clip {i} ({c.get('id', '?') if isinstance(c, dict) else '?'})"))
    return errs


def dumps(doc: dict[str, Any]) -> str:
    """Compact JSON, one clip per line (readable diffs, small file)."""
    head = json.dumps({"version": doc["version"], "attribution": doc["attribution"]}, ensure_ascii=False)[:-1]
    lines = [json.dumps(c, separators=(",", ":"), ensure_ascii=False) for c in doc["clips"]]
    return head + ', "clips": [\n' + ",\n".join(lines) + "\n]}\n"


def write_document(doc: dict[str, Any], path: Path) -> int:
    errs = validate_document(doc)
    if errs:
        raise ValueError("clip document is invalid:\n  " + "\n  ".join(errs[:20]))
    text = dumps(doc)
    assert json.loads(text) == doc
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)
    return len(text.encode())
