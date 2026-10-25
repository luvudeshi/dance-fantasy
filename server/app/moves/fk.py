"""Forward kinematics: a dict of dance angles -> (17-joint body-frame pose, root offset). Pure, no I/O.

Conventions (full reference: assets/moves/README.md). Body frame as in shared/README.md: origin mid-hip,
unit = torso length, +x = dancer's anatomical right, +y down. The figure is built as a planar front-facing
body (legs get a little depth from knee/lift pitch, the face from its nose), then turned, leaned and
shifted. At all-zero angles the result is exactly the neutral pose of shared/examples/routine.example.json.

Angles (degrees unless noted; every key optional, default 0):
  l/r_shoulder  upper-arm angle from hanging down, rotating outward: 90 = horizontal out, 180 = straight up,
                negative = across the front of the body. 0 = relaxed rest (arm hangs ~7 deg out).
  l/r_elbow     forearm bend relative to the upper arm. > 0 swings the forearm the way the shoulder angle
                raises the arm (arm out + 90 = "goalpost", forearm up); < 0 the other way (hands to hips/chest).
  l/r_hip       thigh angle from straight down in the frontal plane, > 0 outward, < 0 crossing the other leg.
  l/r_knee      knee bend, 0..150. Front-view squat model: thigh pitches forward 0.55*knee, shin comes back
                to the floor, knee tracks up to 20 deg outward; thigh/shin are foreshortened accordingly.
  l/r_lift      extra forward thigh pitch (knee raise / front kick). Knee-up: knee 90 + lift 40.
  torso_lean    + leans the upper body toward the dancer's right, rotating about mid-hip (torso stays length 1).
  head_tilt     + tilts the head toward the dancer's right, about the neck (mid-shoulder).
  hip_shift     body units, + moves the hips toward the dancer's right over planted feet.
  travel        body units, + moves the whole dancer toward their right (root only).
  jump          body units, airborne height of the lowest foot.
  turn          fraction of a spin (1 = 360 deg), + turns toward the dancer's right (right shoulder goes back).
"""

from __future__ import annotations

import math
from collections.abc import Mapping

from app.moves.types import Pose, Vec2
from app.skeleton import JOINTS

ANGLE_KEYS: tuple[str, ...] = (
    "l_shoulder",
    "r_shoulder",
    "l_elbow",
    "r_elbow",
    "l_hip",
    "r_hip",
    "l_knee",
    "r_knee",
    "l_lift",
    "r_lift",
    "torso_lean",
    "head_tilt",
    "hip_shift",
    "travel",
    "jump",
    "turn",
)
# Signed lateral parameters: negated when a move is mirrored (l_/r_ keys are swapped instead).
LATERAL_KEYS: frozenset[str] = frozenset({"torso_lean", "head_tilt", "hip_shift", "travel", "turn"})
LEG_KEYS: frozenset[str] = frozenset(
    {"l_hip", "r_hip", "l_knee", "r_knee", "l_lift", "r_lift", "hip_shift", "travel", "jump", "turn"}
)
# Inclusive authoring ranges; the loader rejects values outside them.
RANGES: dict[str, tuple[float, float]] = {
    "l_shoulder": (-180.0, 360.0),
    "r_shoulder": (-180.0, 360.0),
    "l_elbow": (-170.0, 170.0),
    "r_elbow": (-170.0, 170.0),
    "l_hip": (-30.0, 60.0),
    "r_hip": (-30.0, 60.0),
    "l_knee": (0.0, 150.0),
    "r_knee": (0.0, 150.0),
    "l_lift": (-30.0, 110.0),
    "r_lift": (-30.0, 110.0),
    "torso_lean": (-45.0, 45.0),
    "head_tilt": (-40.0, 40.0),
    "hip_shift": (-0.4, 0.4),
    "travel": (-1.5, 1.5),
    "jump": (0.0, 0.8),
    "turn": (-2.0, 2.0),
}

# Proportions, chosen so zero angles reproduce the neutral pose exactly.
SHOULDER_HALF = 0.45
HIP_HALF = 0.22
UPPER_ARM = math.hypot(0.07, 0.58)  # shoulder (0.45,-1) -> elbow (0.52,-0.42)
FOREARM = math.hypot(0.03, 0.54)  # elbow -> wrist (0.55, 0.12)
SHOULDER_REST = math.degrees(math.atan2(0.07, 0.58))  # ~6.88 deg: relaxed arms hang slightly out
ELBOW_REST = math.degrees(math.atan2(0.03, 0.54)) - SHOULDER_REST  # ~-3.70 deg
THIGH = 0.95
SHIN = 0.90
LEG = THIGH + SHIN  # neutral ankle y; the floor is at this height below mid-hip
THIGH_PITCH_PER_KNEE = 0.55
KNEE_YAW_MAX = 20.0  # knees track outward up to this many degrees in a deep bend
NECK: Vec2 = (0.0, -1.0)
# Head points relative to the neck (x, y) plus forward depth z (used only while turning).
HEAD: dict[str, tuple[float, float, float]] = {
    "nose": (0.0, -0.45, 0.15),
    "l_eye": (-0.07, -0.52, 0.10),
    "r_eye": (0.07, -0.52, 0.10),
    "l_ear": (-0.15, -0.48, -0.02),
    "r_ear": (0.15, -0.48, -0.02),
}
UPPER_BODY = ("nose", "l_eye", "r_eye", "l_ear", "r_ear", "l_shoulder", "r_shoulder", "l_elbow", "r_elbow", "l_wrist", "r_wrist")

Point3 = tuple[float, float, float]


def _rest_fade(theta: float) -> float:
    """1 at rest, fading to 0 at |theta| >= 90, so 90 is exactly horizontal and 180 exactly up."""
    return max(0.0, 1.0 - abs(theta) / 90.0)


def _norm180(deg: float) -> float:
    d = math.fmod(deg, 360.0)
    if d > 180.0:
        d -= 360.0
    elif d <= -180.0:
        d += 360.0
    return d


def _arm(sign: float, shoulder: float, elbow: float) -> tuple[Point3, Point3, Point3]:
    """Shoulder, elbow, wrist for one arm (sign +1 = right, -1 = left), upright frame."""
    theta = _norm180(shoulder)
    fade = _rest_fade(theta)
    phi_u = math.radians(theta + SHOULDER_REST * fade)
    phi_f = phi_u + math.radians(elbow + ELBOW_REST * fade)
    sx, sy = SHOULDER_HALF, -1.0
    ex, ey = sx + UPPER_ARM * math.sin(phi_u), sy + UPPER_ARM * math.cos(phi_u)
    wx, wy = ex + FOREARM * math.sin(phi_f), ey + FOREARM * math.cos(phi_f)
    return (sign * sx, sy, 0.0), (sign * ex, ey, 0.0), (sign * wx, wy, 0.0)


def _abduct(v: Point3, abduct: float) -> Point3:
    """Rotate a local leg vector (x outward, y down, z forward) outward in the frontal plane."""
    x, y, z = v
    ca, sa = math.cos(abduct), math.sin(abduct)
    return x * ca + y * sa, -x * sa + y * ca, z


def _leg(sign: float, hip: float, knee: float, lift: float) -> tuple[Point3, Point3, Point3]:
    """Hip, knee, ankle for one leg (sign +1 = right, -1 = left).

    Squat model: the thigh pitches forward 0.55*knee (+ lift) and yaws outward (knees track out), the shin
    pitches back to the floor and brings the ankle back under the hip line. A lifted knee points forward.
    """
    pitch = math.radians(THIGH_PITCH_PER_KNEE * knee + lift)
    yaw = math.radians(KNEE_YAW_MAX * min(1.0, knee / 90.0) * max(0.0, 1.0 - max(lift, 0.0) / 30.0))
    shin_pitch = pitch - math.radians(knee)
    thigh = (THIGH * math.sin(pitch) * math.sin(yaw), THIGH * math.cos(pitch), THIGH * math.sin(pitch) * math.cos(yaw))
    c = SHIN * math.sqrt(max(0.0, 1.0 - (thigh[0] / SHIN) ** 2))
    shin = (-thigh[0], c * math.cos(shin_pitch), c * math.sin(shin_pitch))
    abduct = math.radians(hip)
    tx, ty, tz = _abduct(thigh, abduct)
    sx, sy, sz = _abduct(shin, abduct)
    kx, ky, kz = HIP_HALF + tx, ty, tz
    ax, ay, az = kx + sx, ky + sy, kz + sz
    return (sign * HIP_HALF, 0.0, 0.0), (sign * kx, ky, kz), (sign * ax, ay, az)


def _rot(x: float, y: float, deg: float, cx: float = 0.0, cy: float = 0.0) -> Vec2:
    """Rotate (x, y) about (cx, cy) so that 'up' (-y) swings toward +x for deg > 0."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    dx, dy = x - cx, y - cy
    return cx + dx * c - dy * s, cy + dx * s + dy * c


def _shift_leg(hip: Vec2, knee: Vec2, ankle: Vec2, shift: float) -> tuple[Vec2, Vec2]:
    """Rotate a leg about its hip so the ankle moves by -shift in x (hips move over planted feet)."""
    vx, vy = ankle[0] - hip[0], ankle[1] - hip[1]
    length = math.hypot(vx, vy)
    if length < 1e-9 or shift == 0.0:
        return knee, ankle
    target = max(-length, min(length, vx - shift))
    delta = math.asin(target / length) - math.atan2(vx, vy)
    c, s = math.cos(delta), math.sin(delta)

    def rot(p: Vec2) -> Vec2:
        dx, dy = p[0] - hip[0], p[1] - hip[1]
        return hip[0] + dx * c + dy * s, hip[1] - dx * s + dy * c

    return rot(knee), rot(ankle)


def forward_kinematics(angles: Mapping[str, float]) -> tuple[Pose, Vec2]:
    """Angles (see module doc) -> (pose with all 17 joints in the body frame, root offset)."""
    unknown = set(angles) - set(ANGLE_KEYS)
    if unknown:
        raise ValueError(f"unknown angle keys: {sorted(unknown)}")
    a = {k: float(angles.get(k, 0.0)) for k in ANGLE_KEYS}

    pts: dict[str, Point3] = {}
    for name, (hx, hy, hz) in HEAD.items():
        x, y = _rot(NECK[0] + hx, NECK[1] + hy, a["head_tilt"], *NECK)
        pts[name] = (x, y, hz)
    for side, sign in (("l", -1.0), ("r", 1.0)):
        sh, el, wr = _arm(sign, a[f"{side}_shoulder"], a[f"{side}_elbow"])
        pts[f"{side}_shoulder"], pts[f"{side}_elbow"], pts[f"{side}_wrist"] = sh, el, wr
        hp, kn, an = _leg(sign, a[f"{side}_hip"], a[f"{side}_knee"], a[f"{side}_lift"])
        pts[f"{side}_hip"], pts[f"{side}_knee"], pts[f"{side}_ankle"] = hp, kn, an

    # Turn about the vertical axis through mid-hip (orthographic): + brings the front (+z) toward +x.
    psi = 2.0 * math.pi * a["turn"]
    cp, sp = math.cos(psi), math.sin(psi)
    pose: dict[str, Vec2] = {j: (x * cp + z * sp, y) for j, (x, y, z) in pts.items()}

    # Lean the upper body about mid-hip.
    for j in UPPER_BODY:
        pose[j] = _rot(*pose[j], a["torso_lean"])

    # Hip shift: legs pivot at the hips so the feet stay planted.
    shift = a["hip_shift"]
    for side in ("l", "r"):
        pose[f"{side}_knee"], pose[f"{side}_ankle"] = _shift_leg(
            pose[f"{side}_hip"], pose[f"{side}_knee"], pose[f"{side}_ankle"], shift
        )

    lowest = max(pose["l_ankle"][1], pose["r_ankle"][1])
    root = (shift + a["travel"], LEG - lowest - a["jump"])
    return {j: pose[j] for j in JOINTS}, root
