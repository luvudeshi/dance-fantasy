"""Skeleton definition for the server. Mirrors shared/skeleton.json (tests/test_contract.py keeps them identical)."""

from typing import Literal, get_args

JointName = Literal[
    "nose",
    "l_eye",
    "r_eye",
    "l_ear",
    "r_ear",
    "l_shoulder",
    "r_shoulder",
    "l_elbow",
    "r_elbow",
    "l_wrist",
    "r_wrist",
    "l_hip",
    "r_hip",
    "l_knee",
    "r_knee",
    "l_ankle",
    "r_ankle",
]

JOINTS: tuple[str, ...] = get_args(JointName)

MIRROR: dict[str, str] = {
    j: (("r_" + j[2:]) if j.startswith("l_") else ("l_" + j[2:]) if j.startswith("r_") else j) for j in JOINTS
}

LEG_JOINTS: tuple[str, ...] = ("l_hip", "r_hip", "l_knee", "r_knee", "l_ankle", "r_ankle")
