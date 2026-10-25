"""Named anchor poses: the poses moves start from and end in, so the choreographer can chain moves smoothly.

Every anchor is left/right symmetric, so a mirrored move keeps its anchors. A move's first (last) keyframe
must be within ANCHOR_TOLERANCE of its startAnchor (endAnchor): max joint distance in the body frame, and
the same bound on the root offset.
"""

from __future__ import annotations

import math
from functools import cache

from app.moves.fk import forward_kinematics
from app.moves.types import Pose, Vec2

ANCHORS: dict[str, dict[str, float]] = {
    # Standing tall, arms relaxed (the shared/examples neutral pose).
    "neutral": {},
    # Soft knees, hands slightly out: the default "dancing" stance.
    "ready": {"l_shoulder": 18, "r_shoulder": 18, "l_elbow": 10, "r_elbow": 10, "l_knee": 18, "r_knee": 18},
    # Both arms up in a V.
    "arms_up": {"l_shoulder": 155, "r_shoulder": 155},
    # Fists on hips, elbows out.
    "hands_hips": {"l_shoulder": 40, "r_shoulder": 40, "l_elbow": -118, "r_elbow": -118},
    # Wide stance, soft knees, arms a little out.
    "wide": {"l_hip": 12, "r_hip": 12, "l_knee": 15, "r_knee": 15, "l_shoulder": 25, "r_shoulder": 25},
    # Boxer's guard: fists up in front of the chest.
    "guard": {"l_shoulder": -27, "r_shoulder": -27, "l_elbow": -150, "r_elbow": -150},
    # Hands together in front of the chest (claps start and end here).
    "clasp": {"l_shoulder": -6, "r_shoulder": -6, "l_elbow": -125, "r_elbow": -125},
}
ANCHOR_TOLERANCE = 0.3  # body units


@cache
def anchor_pose(name: str) -> tuple[Pose, Vec2]:
    if name not in ANCHORS:
        raise KeyError(f"unknown anchor {name!r} (known: {', '.join(ANCHORS)})")
    return forward_kinematics(ANCHORS[name])


def anchor_distance(pose: Pose, root: Vec2, name: str) -> float:
    """Max distance between ``pose`` (and ``root``) and the anchor's, in body units."""
    ref, ref_root = anchor_pose(name)
    worst = math.hypot(root[0] - ref_root[0], root[1] - ref_root[1])
    for joint, (x, y) in ref.items():
        px, py = pose[joint]
        worst = max(worst, math.hypot(px - x, py - y))
    return worst
