"""Tags for kept windows: intensity, difficulty, scored joints, body parts, seated-ok, styles, display name.

* intensity 1..5: quintiles of motion energy (mean joint speed, torso units / s) over ALL kept windows, so
  krump is hotter than ballet jazz on the same scale.
* difficulty: rank-mix of speed, number of clearly moving limbs and leg activity, cut at the 35th / 80th
  percentile (easy / normal / hard ~ 35 / 45 / 20 %).
* scoredJoints (distal-joint rule, shared/README.md): the distal joint of every limb whose 2D direction
  sweeps a clear angle across the keyframes (robust 5-95 % spread); legs only when they really move; the
  shoulders when the torso leans; always at least two joints.
* name: genre + a word for the window's most *distinctive* motion (each motion feature is ranked against
  all kept windows, so the word says what stands out, not what every dance does).
"""

from __future__ import annotations

from collections.abc import Sequence as Seq

import numpy as np

from app.skeleton import JOINTS
from scripts.aist.project import J
from scripts.aist.segment import Candidate

GENRE_NAMES = {
    "BR": "Break", "PO": "Pop", "LO": "Lock", "MH": "Hip-Hop", "LH": "LA Hip-Hop",
    "HO": "House", "WA": "Waack", "KR": "Krump", "JS": "Street Jazz", "JB": "Ballet Jazz",
}  # fmt: skip
GENRE_STYLES = {
    "BR": ["break", "hiphop"], "PO": ["popping", "hiphop"], "LO": ["locking", "funk"], "MH": ["hiphop"],
    "LH": ["hiphop"], "HO": ["house"], "WA": ["waacking", "disco"], "KR": ["krump", "hiphop"],
    "JS": ["jazz", "pop"], "JB": ["ballet", "jazz", "storybook"],
}  # fmt: skip
# (limb, proximal, distal, min angular spread in degrees)
ARM_LIMBS = (("l_upper_arm", "l_shoulder", "l_elbow", 40.0), ("l_forearm", "l_elbow", "l_wrist", 50.0),
             ("r_upper_arm", "r_shoulder", "r_elbow", 40.0), ("r_forearm", "r_elbow", "r_wrist", 50.0))  # fmt: skip
LEG_LIMBS = (("l_thigh", "l_hip", "l_knee", 25.0), ("l_shin", "l_knee", "l_ankle", 30.0),
             ("r_thigh", "r_hip", "r_knee", 25.0), ("r_shin", "r_knee", "r_ankle", 30.0))  # fmt: skip
LEG_SPEED_MIN = 1.1  # torso units / s (knees + ankles relative to mid-hip): legs "really move" above this
TORSO_RANGE = 25.0  # degrees of torso (mid-hip -> mid-shoulder) sweep that scores the shoulders
SEATED_ROOT_Y = 0.2  # seated-ok needs the hips to stay this steady (and no scored leg joints)
SEATED_ROOT_X = 0.35
DIFFICULTY_CUTS = (0.35, 0.80)
# motion word -> genre-flavoured words
FLAVOR = {
    ("HO", "Step"): "Shuffle", ("HO", "Bounce"): "Jack", ("HO", "Kick"): "Heel Kick", ("KR", "Step"): "Stomp",
    ("KR", "Arm Wave"): "Arm Swing", ("KR", "Bounce"): "Chest Pop", ("WA", "Arm Wave"): "Whip", ("WA", "Arm Swing"): "Arm Whip",
    ("WA", "Reach"): "Pose", ("PO", "Arm Wave"): "Wave", ("PO", "Step"): "Hit Step", ("PO", "Bounce"): "Hit",
    ("LO", "Arm Wave"): "Lock", ("LO", "Arm Swing"): "Wrist Roll", ("LO", "Bounce"): "Pace", ("BR", "Step"): "Toprock",
    ("BR", "Bounce"): "Rock", ("JB", "Arm Swing"): "Sweep", ("JB", "Step"): "Glide", ("JB", "Arm Wave"): "Port de Bras",
    ("JB", "Kick"): "Extension", ("JS", "Step"): "Groove Step", ("JS", "Arm Wave"): "Jazz Hands", ("MH", "Bounce"): "Groove",
    ("LH", "Bounce"): "Groove", ("MH", "Step"): "Bounce Step", ("LH", "Step"): "Step Groove",
}  # fmt: skip
# minimum raw value for a word to be eligible (so a window with no kick is never a "Kick")
WORD_MIN = {"Reach": 0.15, "Point": 0.15, "Knee Lift": 0.12, "Kick": 0.12, "Drop": 0.05, "Bounce": 0.12}


def _mid(p: np.ndarray, a: str, b: str) -> np.ndarray:
    return (p[:, J[a]] + p[:, J[b]]) / 2


def angle_range(vec: np.ndarray, min_len: float = 0.15) -> float:
    """Robust sweep (degrees) of a 2D direction over time: 5-95 % spread of the unwrapped angle, ignoring
    frames where the vector is nearly zero (foreshortened); capped at 360."""
    length = np.linalg.norm(vec, axis=-1)
    ok = length > min_len * max(float(np.median(length)), 1e-6)
    if ok.sum() < 2:
        return 0.0
    ang = np.degrees(np.unwrap(np.arctan2(vec[ok, 1], vec[ok, 0])))
    lo, hi = np.percentile(ang, [5, 95])
    return float(min(hi - lo, 360.0))


def limb_ranges(pose: np.ndarray) -> dict[str, float]:
    out = {}
    for name, a, b, _ in ARM_LIMBS + LEG_LIMBS:
        out[name] = angle_range(pose[:, J[b]] - pose[:, J[a]])
    out["torso"] = angle_range(_mid(pose, "l_shoulder", "r_shoulder") - _mid(pose, "l_hip", "r_hip"))
    out["head"] = angle_range(pose[:, J["r_ear"]] - pose[:, J["l_ear"]])
    return out


def scored_joints(c: Candidate, ranges: dict[str, float]) -> list[str]:
    scored: set[str] = set()
    for name, _, distal, th in ARM_LIMBS:
        if ranges[name] >= th:
            scored.add(distal)
    if c.m.get("leg_speed", 0.0) >= LEG_SPEED_MIN:
        for name, _, distal, th in LEG_LIMBS:
            if ranges[name] >= th:
                scored.add(distal)
    if ranges["torso"] >= TORSO_RANGE:
        scored.update(("l_shoulder", "r_shoulder"))
    if len(scored) < 2:  # at least two joints: the most-moving arm limbs
        for _, _, distal, _ in sorted(ARM_LIMBS, key=lambda limb: -ranges[limb[0]]):
            scored.add(distal)
            if len(scored) >= 2:
                break
    return [j for j in JOINTS if j in scored]


def motion_features(c: Candidate, ranges: dict[str, float]) -> dict[str, float]:
    """Raw strength of each motion word (comparable across windows, not across words)."""
    p, root = c.pose, c.root
    nose_y = p[:, J["nose"], 1]
    wrists = p[:, [J["l_wrist"], J["r_wrist"]]]
    elbows = p[:, [J["l_elbow"], J["r_elbow"]]]
    shoulders = p[:, [J["l_shoulder"], J["r_shoulder"]]]
    above = wrists[:, :, 1] < nose_y[:, None]
    straight = np.linalg.norm(wrists - shoulders, axis=-1) > 0.95  # arm nearly straight (canonical arm 1.13)
    out_far = np.abs(wrists[:, :, 0]) > 1.1
    ankles = p[:, [J["l_ankle"], J["r_ankle"]]]
    lowest = ankles[:, :, 1].max(axis=1)
    return {
        "Reach": float(above.all(axis=1).mean() + 0.5 * above.any(axis=1).mean()),
        "Point": float((straight & out_far & (elbows[:, :, 1] < 0.0)).any(axis=1).mean()),
        "Arm Swing": max(ranges["l_upper_arm"], ranges["r_upper_arm"]),
        "Arm Wave": max(ranges["l_forearm"], ranges["r_forearm"]) - 0.5 * max(ranges["l_upper_arm"], ranges["r_upper_arm"]),
        "Knee Lift": float((ankles[:, :, 1].min(axis=1) < lowest - 0.6).mean()),
        "Kick": float(((np.abs(ankles[:, :, 0]) > 0.75) & (ankles[:, :, 1] < lowest[:, None] - 0.2)).any(axis=1).mean()),
        "Bounce": float(np.ptp(root[:, 1])),
        "Drop": float(max(0.0, root[:, 1].max() - 0.3)),
        "Sway": ranges["torso"],
        "Step": c.m.get("leg_speed", 0.0),
    }


def _ranks(x: np.ndarray) -> np.ndarray:
    """Percentile ranks in [0, 1], ties share their average rank."""
    order = np.argsort(x, kind="stable")
    r = np.empty(len(x))
    r[order] = np.arange(len(x))
    xs = x[order]
    i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[j + 1] == xs[i]:
            j += 1
        r[order[i : j + 1]] = (i + j) / 2
        i = j + 1
    return r / max(len(x) - 1, 1)


def tag_all(cands: Seq[Candidate]) -> None:
    """Fill ``c.tags`` for every kept window (needs the whole population for the quantile-based tags)."""
    if not cands:
        return
    energy = np.array([c.m["energy"] for c in cands])
    cuts = np.quantile(energy, [0.2, 0.4, 0.6, 0.8])
    n_moving, legs, feats = [], [], []
    for c in cands:
        ranges = limb_ranges(c.pose)
        sj = scored_joints(c, ranges)
        leg_moving = any(j in sj for j in ("l_knee", "r_knee", "l_ankle", "r_ankle"))
        root_still = float(np.ptp(c.root[:, 1])) < SEATED_ROOT_Y and float(np.ptp(c.root[:, 0])) < SEATED_ROOT_X
        upper_only = (not leg_moving) and root_still
        parts = []
        if any(j in sj for j in ("l_elbow", "r_elbow", "l_wrist", "r_wrist")):
            parts.append("arms")
        if leg_moving or not upper_only:
            parts.append("legs")
        if "l_shoulder" in sj or ranges["torso"] >= 15.0:
            parts.append("torso")
        if ranges["head"] >= 30.0:
            parts.append("head")
        c.tags = {
            "ranges": ranges,
            "scoredJoints": sj,
            "upperBodyOnly": bool(upper_only),
            "bodyParts": parts or ["arms"],
            "styles": GENRE_STYLES.get(c.genre, []) + ["aist"],
        }
        feats.append(motion_features(c, ranges))
        n_moving.append(sum(1 for name, _, _, th in ARM_LIMBS + LEG_LIMBS if ranges[name] >= th))
        legs.append(c.m["leg_speed"] + 0.5 * c.m["hip_speed"])
    words = sorted(feats[0])
    pct = {w: _ranks(np.array([f[w] for f in feats])) for w in words}
    for i, c in enumerate(cands):
        eligible = [w for w in words if feats[i][w] >= WORD_MIN.get(w, -np.inf)]
        word = max(eligible, key=lambda w: (pct[w][i], w))
        c.tags["descriptor"] = FLAVOR.get((c.genre, word), word)
    score = 0.45 * _ranks(energy) + 0.3 * _ranks(np.array(n_moving, dtype=float)) + 0.25 * _ranks(np.array(legs))
    dcut = np.quantile(score, DIFFICULTY_CUTS)
    for c, e, s in zip(cands, energy, score):
        c.tags["intensity"] = int(1 + np.searchsorted(cuts, e, side="right"))
        c.tags["difficulty"] = "easy" if s < dcut[0] else ("normal" if s < dcut[1] else "hard")
        c.tags["difficultyScore"] = float(s)


def display_name(c: Candidate) -> str:
    return f"{GENRE_NAMES.get(c.genre, c.genre)} {c.tags.get('descriptor', 'Groove')}"
