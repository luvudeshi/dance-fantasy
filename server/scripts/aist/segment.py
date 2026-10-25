"""Beat-aligned candidate windows with half-beat keyframes, plus the per-window metrics the filters use.

Windows are 8 or 4 beats long and start on every 2nd beat of the sequence's beat grid (8-counts are hard to
locate from motion alone); each window's grid is re-aligned to the motion hits inside it (``local_shift``,
at most a quarter beat) to absorb residual tempo drift. Keyframes sit at every half beat (t = k / 2L,
which always includes the on-beat targets t = k / L exactly), plus a quarter-beat keyframe wherever
half-beat interpolation would miss the motion by more than QUARTER_TOL. Positions are linearly
interpolated from lightly smoothed 60 fps data.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from scripts.aist.project import J, Sequence, facing_right, interp_frames, mean_right, project_window
from scripts.aist.tempo import TempoResult, gaussian_smooth, hit_signal, joint_speeds, local_shift
from app.moves.fk import FOREARM, UPPER_ARM

LENGTHS = (8, 4)
START_STEP = 2  # beats between candidate starts
QUARTER_TOL = 0.2  # body units: add a quarter-beat keyframe when half-beat interpolation misses by more
ARM_CHAINS = (("l_shoulder", "l_elbow", "l_wrist"), ("r_shoulder", "r_elbow", "r_wrist"))
COLLAPSE_RATIO = 0.45  # an arm whose 2D length is below this fraction of its 3D length points at the camera


@dataclass
class Candidate:
    seq: str
    info: dict[str, str]
    length: int  # beats
    start_beat: int  # index into the sequence's beat grid
    t0: float  # seconds
    bpm: float
    times: np.ndarray  # (K,) keyframe t in [0, 1]
    pose: np.ndarray  # (K, 17, 2) body frame
    root: np.ndarray  # (K, 2)
    m: dict[str, float] = field(default_factory=dict)  # metrics (see window_metrics)
    reject: str | None = None
    tags: dict[str, object] = field(default_factory=dict)

    @property
    def genre(self) -> str:
        return self.info.get("genre", "??")

    @property
    def group(self) -> str:
        """Choreography identity: the same (genre, situation, choreography) danced to other songs / by others."""
        return f"{self.genre}_{self.info.get('sit', '')}_{self.info.get('ch', '')}"

    @property
    def end_t(self) -> float:
        return self.t0 + self.length * 60.0 / self.bpm

    def beat_index(self) -> np.ndarray:
        """Indices of the on-beat keyframes (t = k / length)."""
        return np.array([int(np.argmin(np.abs(self.times - k / self.length))) for k in range(self.length + 1)])


def keyframe_times(length: int, extra_quarters: list[int] | tuple[int, ...] = ()) -> np.ndarray:
    """Half-beat grid t = k / (2L), plus the listed quarter-beat slots (odd k of the k / 4L grid)."""
    half = [2 * k for k in range(2 * length + 1)]
    ks = sorted(set(half) | {q for q in extra_quarters if q % 2 == 1 and 0 < q < 4 * length})
    return np.array([k / (4 * length) for k in ks])


def _quarters_needed(pose_q: np.ndarray, root_q: np.ndarray, tol: float) -> list[int]:
    """Odd quarter-beat slots whose pose is poorly predicted by its two half-beat neighbours."""
    out = []
    for q in range(1, len(pose_q) - 1, 2):
        mid_pose = (pose_q[q - 1] + pose_q[q + 1]) / 2
        mid_root = (root_q[q - 1] + root_q[q + 1]) / 2
        err = np.max(np.linalg.norm((pose_q[q] + root_q[q]) - (mid_pose + mid_root), axis=-1))
        if err > tol:
            out.append(q)
    return out


def _arm_collapse(pose: np.ndarray, torso2d: np.ndarray) -> np.ndarray:
    """(T, 2) True where an arm's projected length is short vs. its 3D length (points at / away from camera)."""
    out = []
    for sh, el, wr in ARM_CHAINS:
        l2 = (np.linalg.norm(pose[:, J[el]] - pose[:, J[sh]], axis=-1) + np.linalg.norm(pose[:, J[wr]] - pose[:, J[el]], axis=-1))
        out.append(l2 * torso2d / (UPPER_ARM + FOREARM) < COLLAPSE_RATIO)
    return np.stack(out, axis=1)


def window_metrics(seq: Sequence, f0: float, f1: float, speeds: np.ndarray, right: np.ndarray) -> dict[str, float]:
    """Quality metrics over the integer frames in [f0, f1] (dense, 60 fps)."""
    a, b = int(np.ceil(f0)), int(np.floor(f1))
    frames = np.arange(a, b + 1, dtype=np.float64)
    raw = seq.raw[a : b + 1]
    tc = seq.torso_cm
    m: dict[str, float] = {}
    m["nan"] = float(np.isnan(raw).any())
    if m["nan"]:
        return m
    proj = project_window(seq, frames, right)
    floor = seq.floor_y
    nose_h = (raw[:, J["nose"], 1] - floor) / tc
    hip_h = ((raw[:, J["l_hip"], 1] + raw[:, J["r_hip"], 1]) / 2 - floor) / tc
    m["min_head"] = float(nose_h.min())
    m["min_hip"] = float(hip_h.min())
    m["inverted"] = float(np.mean(nose_h < hip_h))
    m["facing_dev"] = float(proj.facing_dev.max())
    # jitter: high-frequency residual of the raw keypoints (torso units)
    w = raw / tc
    m["jitter"] = float(np.sqrt(np.mean(np.sum((w - gaussian_smooth(w, 1.5)) ** 2, axis=-1))))
    lens = seq.limb_len[a : b + 1]
    m["limb_dev"] = float(np.percentile(np.abs(lens - 1.0), 95))
    sp = speeds[a : b + 1]  # (T, 17) canonical world speeds, torso units / s
    m["energy"] = float(sp.mean())
    m["peak_speed"] = float(np.percentile(sp.max(axis=1), 95))
    rel = seq.canon[a : b + 1]
    legs = [J[j] for j in ("l_knee", "r_knee", "l_ankle", "r_ankle")]
    arms = [J[j] for j in ("l_elbow", "r_elbow", "l_wrist", "r_wrist")]
    vel_rel = np.linalg.norm(np.gradient(gaussian_smooth(rel, 2.0), axis=0) * seq.fps, axis=-1)
    m["leg_speed"] = float(vel_rel[:, legs].mean())
    m["arm_speed"] = float(vel_rel[:, arms].mean())
    hip_speed = np.linalg.norm(np.gradient(gaussian_smooth(seq.midhip[a : b + 1], 2.0), axis=0) * seq.fps, axis=-1)
    m["hip_speed"] = float(hip_speed.mean())
    m["travel"] = float(np.abs(proj.root[:, 0]).max())
    m["airborne"] = float(seq.airborne[a : b + 1].max())
    m["root_y_min"] = float(proj.root[:, 1].min())
    m["root_y_max"] = float(proj.root[:, 1].max())
    m["torso2d_min"] = float(proj.torso2d.min())
    m["bent_frac"] = float(np.mean(proj.torso2d < 0.75))
    col = _arm_collapse(proj.pose, proj.torso2d)
    m["arm_collapse"] = float(col.all(axis=1).mean())  # both arms collapsed
    m["arm_collapse_any"] = float(col.any(axis=1).mean())
    # how much of the 2D picture moves (keeps "static in 2D but moving in depth" windows out)
    m["energy2d"] = float(np.linalg.norm(np.diff(proj.pose + proj.root[:, None, :], axis=0), axis=-1).mean() * seq.fps)
    return m


def sequence_windows(
    seq: Sequence, tempo: TempoResult, lengths: tuple[int, ...] = LENGTHS, step: int = START_STEP
) -> list[Candidate]:
    """All candidate windows of a sequence (unfiltered), keyframes + metrics."""
    fps = seq.fps
    period = 60.0 / tempo.bpm
    beats = tempo.beat_times(seq.duration)
    world = seq.canon + seq.midhip[:, None, :]
    speeds = joint_speeds(world, fps)
    hit = hit_signal(speeds.sum(axis=1), fps)
    smooth = Sequence(**{**seq.__dict__})
    smooth.canon = gaussian_smooth(seq.canon, 1.0)
    out: list[Candidate] = []
    for length in lengths:
        for i in range(0, len(beats) - length, step):
            grid = beats[i : i + length + 1]
            shift = local_shift(hit, fps, grid, period)
            t0 = float(grid[0] + shift)
            t1 = t0 + length * period
            f0, f1 = t0 * fps, t1 * fps
            if f0 < 0 or f1 > seq.n - 1:
                continue
            right, _ = mean_right(facing_right(seq.raw[int(np.floor(f0)) : int(np.ceil(f1)) + 1]))
            tq = np.arange(4 * length + 1) / (4 * length)
            pq = project_window(smooth, f0 + tq * (f1 - f0), right)
            # in place, like every classic move: remove the net lateral drift (linear ramp), keep the sway
            pq.root[:, 0] -= tq * pq.root[-1, 0]
            extra = _quarters_needed(pq.pose, pq.root, QUARTER_TOL)
            times = keyframe_times(length, extra)
            idx = np.rint(times * 4 * length).astype(int)
            cand = Candidate(
                seq=seq.name,
                info=seq.info,
                length=length,
                start_beat=i,
                t0=t0,
                bpm=tempo.bpm,
                times=times,
                pose=pq.pose[idx],
                root=pq.root[idx],
            )
            cand.m = window_metrics(seq, f0, f1, speeds, right)
            total = speeds.sum(axis=1)
            frames_all = np.arange(seq.n)
            win_mean = max(float(total[int(np.ceil(f0)) : int(np.floor(f1)) + 1].mean()), 1e-9)
            beat_frames = f0 + np.arange(length + 1) / length * (f1 - f0)
            cand.m["start_speed"] = float(np.interp(f0, frames_all, total)) / win_mean
            cand.m["beat_speed"] = float(np.interp(beat_frames, frames_all, total).mean()) / win_mean
            cand.m["quarters"] = float(len(extra))
            cand.m["tempo_ok"] = 0.0 if tempo.hint == "disagrees" else 1.0
            out.append(cand)
    return out


__all__ = ["Candidate", "keyframe_times", "sequence_windows", "window_metrics", "interp_frames"]
