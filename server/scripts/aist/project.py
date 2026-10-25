"""3D AIST++ keypoints -> our 2D body frame (shared/README.md), plus the rendering-only root offset.

Steps, per sequence (``prepare_sequence``):
  * world keypoints (cm, y up) are converted to torso units (sequence-median 3D mid-shoulder -> mid-hip);
  * **retargeting**: every bone keeps its 3D direction but gets the length of our FK skeleton
    (app.moves.fk: shoulders +-0.45, hips +-0.22, upper arm 0.58, forearm 0.54, thigh 0.95, shin 0.90, head
    offsets), so real-dancer clips have the same proportions as the classic library (the coach blends
    between them and the stick figure stands on a floor LEG below mid-hip);
  * the floor is a low percentile of the lowest ankle's height; how far the lowest ankle is above it is
    the airborne height.

Per window (``project_window``):
  * dancer's right = horizontal part of (r_hip - l_hip) + (r_shoulder - l_shoulder), unit vectors averaged
    over the window (fixed for the window, so a turn shows as a rotation); up = world +y; forward = up x right;
  * x = dot(p - mid_hip, right), y = -dot(p - mid_hip, up), then every frame is scaled so its 2D
    mid-shoulder -> mid-hip distance is 1 (exactly the webcam normalization);
  * root x = lateral mid-hip travel along ``right`` since the window start (torso units);
    root y = how far mid-hip is below standing height *in the rendered frame*: chosen so the lowest
    ankle touches the floor (LEG below mid-hip at root 0) unless the dancer is airborne.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.moves.fk import FOREARM, HEAD, HIP_HALF, LEG, SHIN, SHOULDER_HALF, THIGH, UPPER_ARM
from app.skeleton import JOINTS

J = {name: i for i, name in enumerate(JOINTS)}
UP = np.array([0.0, 1.0, 0.0])
FPS = 60.0
FLOOR_PERCENTILE = 2.0
# (child, parent, canonical length); parents come first. "mh"/"ms" = mid-hip / mid-shoulder.
CHAINS: tuple[tuple[str, str, float], ...] = (
    ("r_hip", "mh", HIP_HALF),
    ("l_hip", "mh", HIP_HALF),
    ("r_shoulder", "ms", SHOULDER_HALF),
    ("l_shoulder", "ms", SHOULDER_HALF),
    ("l_elbow", "l_shoulder", UPPER_ARM),
    ("r_elbow", "r_shoulder", UPPER_ARM),
    ("l_wrist", "l_elbow", FOREARM),
    ("r_wrist", "r_elbow", FOREARM),
    ("l_knee", "l_hip", THIGH),
    ("r_knee", "r_hip", THIGH),
    ("l_ankle", "l_knee", SHIN),
    ("r_ankle", "r_knee", SHIN),
) + tuple((name, "ms", float(np.linalg.norm(off))) for name, off in HEAD.items())
LIMBS3D = (("l_shoulder", "l_elbow"), ("r_shoulder", "r_elbow"), ("l_elbow", "l_wrist"), ("r_elbow", "r_wrist"),
           ("l_hip", "l_knee"), ("r_hip", "r_knee"), ("l_knee", "l_ankle"), ("r_knee", "r_ankle"))  # fmt: skip


def mid(a: np.ndarray, i: str, j: str) -> np.ndarray:
    return (a[..., J[i], :] + a[..., J[j], :]) / 2


def _unit(v: np.ndarray, eps: float = 1e-9) -> np.ndarray:
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, eps)


@dataclass
class Sequence:
    """One AIST++ sequence, prepared for windowing."""

    name: str
    raw: np.ndarray  # (N, 17, 3) world cm, y up
    fps: float = FPS
    info: dict[str, str] = field(default_factory=dict)
    torso_cm: float = 0.0  # median 3D mid-shoulder -> mid-hip
    canon: np.ndarray = field(default_factory=lambda: np.zeros((0, 17, 3)))  # retargeted, mid-hip at 0, torso units
    midhip: np.ndarray = field(default_factory=lambda: np.zeros((0, 3)))  # world mid-hip, torso units
    airborne: np.ndarray = field(default_factory=lambda: np.zeros(0))  # lowest ankle above the floor, torso units
    floor_y: float = 0.0  # world y of the floor (cm)
    limb_len: np.ndarray = field(default_factory=lambda: np.zeros((0, 8)))  # raw 3D limb lengths / median
    bpm: float = 0.0
    beat0: float = 0.0  # seconds of a beat in the grid
    tempo_score: float = 0.0

    @property
    def n(self) -> int:
        return int(self.raw.shape[0])

    @property
    def duration(self) -> float:
        return self.n / self.fps


def retarget(raw: np.ndarray, torso_cm: float) -> np.ndarray:
    """(N,17,3) world cm -> (N,17,3) canonical-proportion skeleton in torso units, mid-hip at the origin."""
    p = raw / torso_cm
    mh = mid(p, "l_hip", "r_hip")
    ms = mid(p, "l_shoulder", "r_shoulder")
    out = np.zeros_like(p)
    pos: dict[str, np.ndarray] = {"mh": np.zeros_like(mh), "ms": _unit(ms - mh)}
    src: dict[str, np.ndarray] = {"mh": mh, "ms": ms}
    for name in JOINTS:
        src[name] = p[:, J[name]]
    for child, parent, length in CHAINS:
        pos[child] = pos[parent] + _unit(src[child] - src[parent]) * length
    for name in JOINTS:
        out[:, J[name]] = pos[name]
    return out


def facing_right(a: np.ndarray) -> np.ndarray:
    """(N,3) horizontal unit vectors toward the dancer's right (hips + shoulders), world frame."""
    r = (a[:, J["r_hip"]] - a[:, J["l_hip"]]) + (a[:, J["r_shoulder"]] - a[:, J["l_shoulder"]])
    r = r * np.array([1.0, 0.0, 1.0])
    return _unit(r)


def mean_right(right: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Window-mean right vector and each frame's deviation from it in degrees."""
    m = right.mean(axis=0)
    m = m / max(float(np.linalg.norm(m)), 1e-9)
    dev = np.degrees(np.arccos(np.clip(right @ m, -1.0, 1.0)))
    return m, dev


def prepare_sequence(name: str, raw: np.ndarray, fps: float = FPS, info: dict[str, str] | None = None) -> Sequence:
    raw = np.asarray(raw, dtype=np.float64)
    torso = np.linalg.norm(mid(raw, "l_shoulder", "r_shoulder") - mid(raw, "l_hip", "r_hip"), axis=-1)
    torso_cm = float(np.nanmedian(torso))
    lows = np.minimum(raw[:, J["l_ankle"], 1], raw[:, J["r_ankle"], 1])
    floor_y = float(np.nanpercentile(lows, FLOOR_PERCENTILE))
    lens = np.stack([np.linalg.norm(raw[:, J[a]] - raw[:, J[b]], axis=-1) for a, b in LIMBS3D], axis=1)
    return Sequence(
        name=name,
        raw=raw,
        fps=fps,
        info=info or {},
        torso_cm=torso_cm,
        canon=retarget(raw, torso_cm),
        midhip=mid(raw, "l_hip", "r_hip") / torso_cm,
        airborne=np.maximum(0.0, (lows - floor_y) / torso_cm),
        floor_y=floor_y,
        limb_len=lens / np.nanmedian(lens, axis=0, keepdims=True),
    )


@dataclass
class Projected:
    pose: np.ndarray  # (T, 17, 2) body frame, per-frame 2D torso = 1
    root: np.ndarray  # (T, 2)
    torso2d: np.ndarray  # (T,) 2D torso length before normalization (canonical units; 1 = upright)
    right: np.ndarray  # (3,) window right vector
    facing_dev: np.ndarray  # (T,) degrees from the window mean


def project_frames(canon: np.ndarray, right: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Canonical 3D (mid-hip origin) -> (normalized 2D pose, 2D torso length)."""
    x = canon @ right
    y = -(canon @ UP)
    p2 = np.stack([x, y], axis=-1)
    ms = mid(p2, "l_shoulder", "r_shoulder")
    mh = mid(p2, "l_hip", "r_hip")
    torso2d = np.linalg.norm(ms - mh, axis=-1)
    p2 = (p2 - mh[:, None, :]) / np.maximum(torso2d, 1e-6)[:, None, None]
    return p2, torso2d


def project_window(seq: Sequence, frames: np.ndarray, right: np.ndarray | None = None) -> Projected:
    """Project the (possibly fractional) ``frames`` of ``seq``: linear interpolation of the 60 fps data.

    ``right`` defaults to the mean facing over the integer frames spanned by ``frames``.
    """
    frames = np.asarray(frames, dtype=np.float64)
    lo = int(np.floor(frames.min()))
    hi = int(np.ceil(frames.max()))
    if right is None:
        right, _ = mean_right(facing_right(seq.raw[lo : hi + 1]))
    canon = interp_frames(seq.canon, frames)
    midhip = interp_frames(seq.midhip, frames)
    airborne = interp_frames(seq.airborne, frames)
    raw = interp_frames(seq.raw, frames)
    dev = np.degrees(np.arccos(np.clip(facing_right(raw) @ right, -1.0, 1.0)))
    pose, torso2d = project_frames(canon, right)
    scale = 1.0 / np.maximum(torso2d, 1e-6)
    lowest = np.max(pose[:, [J["l_ankle"], J["r_ankle"]], 1], axis=1)
    root_y = LEG - lowest - airborne * scale
    root_x = (midhip - midhip[0]) @ right
    return Projected(pose=pose, root=np.stack([root_x, root_y], axis=-1), torso2d=torso2d, right=right, facing_dev=dev)


def interp_frames(a: np.ndarray, frames: np.ndarray) -> np.ndarray:
    """Linear interpolation of a per-frame array at fractional frame indices (clamped to the ends)."""
    n = a.shape[0]
    f = np.clip(frames, 0.0, n - 1.0)
    i0 = np.floor(f).astype(int)
    i1 = np.minimum(i0 + 1, n - 1)
    w = (f - i0).reshape((-1,) + (1,) * (a.ndim - 1))
    return a[i0] * (1.0 - w) + a[i1] * w
