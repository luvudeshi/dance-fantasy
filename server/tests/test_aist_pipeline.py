"""AIST++ clip pipeline (server/scripts/aist): safe loading, projection, tempo, segmentation, filters,
selection and the clip-file contract. Synthetic data only (the dataset itself is never needed)."""

from __future__ import annotations

import json
import math
import os
import pickle
from pathlib import Path

import numpy as np
import pytest
from helpers import REPO_ROOT

from app.moves.fk import LEG, forward_kinematics
from app.skeleton import JOINTS, MIRROR
from scripts.aist.export import build_document, validate_document, write_document
from scripts.aist.filters import FilterConfig, apply_filters, reasons
from scripts.aist.project import J, prepare_sequence, project_window
from scripts.aist.safe_load import UnsafePickleError, load_keypoints, parse_name, safe_loads
from scripts.aist.segment import Candidate, keyframe_times, sequence_windows
from scripts.aist.selection import SelectConfig, mirror_pose, nn_transition, select_genre
from scripts.aist.tags import tag_all
from scripts.aist.tempo import estimate_tempo

FPS = 60.0
CM = 48.0  # torso length of the synthetic dancer, in "cm"
FLOOR = 70.0
NEUTRAL, _ = forward_kinematics({})


# --- synthetic dancer -------------------------------------------------------------------------


def to_world(pose: dict[str, tuple[float, float]], yaw_deg: float, root: tuple[float, float] = (0.0, 0.0)) -> np.ndarray:
    """Body-frame 2D pose (x = dancer's right, y down; planar, facing forward) -> (17, 3) world cm, y up.

    yaw rotates the dancer about the vertical axis; forward = up x right as in scripts/aist/project.py."""
    yaw = math.radians(yaw_deg)
    right = np.array([math.cos(yaw), 0.0, math.sin(yaw)])
    up = np.array([0.0, 1.0, 0.0])
    hip = np.array([0.0, FLOOR + (LEG - root[1]) * CM, 0.0]) + root[0] * CM * right
    return np.array([hip + CM * (pose[j][0] * right - pose[j][1] * up) for j in JOINTS])


def smoothstep(u: np.ndarray) -> np.ndarray:
    return u * u * (3 - 2 * u)


def dancer(seconds: float, bpm: float, phase: float, yaw: float = 20.0) -> np.ndarray:
    """A dancer who swings the arms between two poses, arriving (speed 0) exactly on every beat, and bobs."""
    period = 60.0 / bpm
    t = np.arange(int(seconds * FPS)) / FPS
    b = (t - phase) / period
    k = np.floor(b)
    u = smoothstep(b - k)
    s = np.where(k % 2 == 0, u, 1 - u)  # 0 -> 1 on even beats, 1 -> 0 on odd beats
    frames = []
    for si in s:
        pose, _ = forward_kinematics(
            {"l_shoulder": 20 + 120 * si, "r_shoulder": 140 - 120 * si, "l_elbow": 40 * si, "r_elbow": 40 * (1 - si), "l_knee": 25 * si}
        )
        frames.append(to_world(pose, yaw, (0.0, 0.0)))
    return np.array(frames)


def circ_err(a: float, b: float, period: float) -> float:
    d = (a - b) % period
    return min(d, period - d)


# --- safe loading -----------------------------------------------------------------------------


class _Evil:
    def __reduce__(self):  # type: ignore[no-untyped-def]
        return (os.system, ("echo pwned > /dev/null",))


def test_unpickler_rejects_arbitrary_globals() -> None:
    data = pickle.dumps({"keypoints3d": _Evil()})
    with pytest.raises(UnsafePickleError, match="system"):
        safe_loads(data)
    with pytest.raises(UnsafePickleError):
        safe_loads(pickle.dumps(Path("/tmp")))  # any non-numpy class, even a harmless one


def test_unpickler_loads_numpy_keypoints(tmp_path: Path) -> None:
    arr = np.random.default_rng(0).normal(size=(5, 17, 3))
    path = tmp_path / "gJB_sBM_cAll_d07_mJB0_ch01.pkl"
    path.write_bytes(pickle.dumps({"keypoints3d": arr * 2, "keypoints3d_optim": arr}))
    out = load_keypoints(path)
    assert out.shape == (5, 17, 3) and np.array_equal(out, arr)  # prefers keypoints3d_optim
    bad = tmp_path / "bad.pkl"
    bad.write_bytes(pickle.dumps({"keypoints3d": np.zeros((5, 16, 3))}))
    with pytest.raises(ValueError, match="17, 3"):
        load_keypoints(bad)
    info = parse_name(path.stem)
    assert (info["genre"], info["sit"], info["music"], info["ch"]) == ("JB", "BM", "0", "01")


# --- projection -------------------------------------------------------------------------------


@pytest.mark.parametrize("yaw", [0.0, 37.0, 180.0, -100.0])
def test_projection_is_front_view_body_frame(yaw: float) -> None:
    raw = np.array([to_world(NEUTRAL, yaw)] * 30)
    seq = prepare_sequence("gHO_sBM_cAll_d19_mHO0_ch01", raw)
    proj = project_window(seq, np.arange(30, dtype=float))
    pose = proj.pose[0]
    assert pose[J["r_shoulder"], 0] > 0.3 > -0.3 > pose[J["l_shoulder"], 0]  # dancer's right is +x, whatever the yaw
    mid_hip = (pose[J["l_hip"]] + pose[J["r_hip"]]) / 2
    mid_sh = (pose[J["l_shoulder"]] + pose[J["r_shoulder"]]) / 2
    assert np.allclose(mid_hip, 0, atol=1e-9)
    assert np.linalg.norm(mid_sh - mid_hip) == pytest.approx(1.0)
    assert mid_sh[1] < 0  # +y is down
    for j in JOINTS:  # retargeted to the FK proportions: a front-facing neutral stance reproduces the FK pose
        tol = 0.06 if j in ("nose", "l_eye", "r_eye", "l_ear", "r_ear") else 1e-6
        assert np.allclose(pose[J[j]], NEUTRAL[j], atol=tol), j
    assert np.allclose(proj.root, 0, atol=1e-6)
    assert proj.facing_dev.max() < 1e-6


def test_projection_root_squat_and_travel() -> None:
    # a wide straddle (planar, so the retargeted legs keep their direction): the hips drop
    squat, root = forward_kinematics({"l_hip": 40, "r_hip": 40})
    frames = [to_world(NEUTRAL, 10.0), to_world(squat, 10.0, (0.0, root[1])), to_world(NEUTRAL, 10.0, (0.8, 0.0))]
    raw = np.array([frames[0]] * 20 + [frames[1]] * 20 + [frames[2]] * 20)
    seq = prepare_sequence("gHO_sBM_cAll_d19_mHO0_ch01", raw)
    proj = project_window(seq, np.array([0.0, 30.0, 50.0]))
    assert proj.root[0] == pytest.approx([0.0, 0.0], abs=1e-6)
    assert proj.root[1, 1] > 0.2  # hips lower than standing: +y
    lowest = proj.pose[1][[J["l_ankle"], J["r_ankle"]], 1].max()
    assert lowest + proj.root[1, 1] == pytest.approx(LEG, abs=1e-6)  # feet stay on the floor
    assert proj.root[2, 0] == pytest.approx(0.8, abs=1e-6)  # lateral travel toward the dancer's right


# --- tempo ------------------------------------------------------------------------------------


@pytest.mark.parametrize(("bpm", "phase"), [(96.0, 0.21), (124.0, 0.05), (81.0, 0.4)])
def test_tempo_and_phase_from_synthetic_motion(bpm: float, phase: float) -> None:
    raw = dancer(30.0, bpm, phase)
    res = estimate_tempo(raw / CM, FPS)
    assert res.bpm == pytest.approx(bpm, rel=0.005)
    assert circ_err(res.beat0, phase, 60.0 / bpm) < 0.06 * 60.0 / bpm
    beats = res.beat_times(30.0)
    assert np.allclose(np.diff(beats), 60.0 / res.bpm)


def test_tempo_digit_hint_only_breaks_ties() -> None:
    raw = dancer(24.0, 110.0, 0.1)
    assert estimate_tempo(raw / CM, FPS, digit_bpm=110.0).hint == "agrees"
    res = estimate_tempo(raw / CM, FPS, digit_bpm=80.0)  # a wrong hint can't override clear motion
    assert res.bpm == pytest.approx(110.0, rel=0.005) and res.hint == "disagrees"


# --- segmentation -----------------------------------------------------------------------------


def test_keyframe_times_cover_every_beat_and_half_beat() -> None:
    for length in (4, 8):
        ts = keyframe_times(length)
        assert len(ts) == 2 * length + 1 and ts[0] == 0 and ts[-1] == 1
        assert all(any(t == k / length for t in ts) for k in range(length + 1))
        ts2 = keyframe_times(length, [1, 3, 4, 4 * length])  # odd quarter slots only
        assert set(np.round(ts2, 9)) == set(np.round(ts, 9)) | {round(1 / (4 * length), 9), round(3 / (4 * length), 9)}


def test_sequence_windows_on_synthetic_dance() -> None:
    raw = dancer(20.0, 100.0, 0.3)
    seq = prepare_sequence("gLO_sFM_cAll_d13_mLO2_ch03", raw, info=parse_name("gLO_sFM_cAll_d13_mLO2_ch03"))
    tempo = estimate_tempo(raw / CM, FPS)
    cands = sequence_windows(seq, tempo)
    assert {c.length for c in cands} == {4, 8}
    assert all(c.start_beat % 2 == 0 for c in cands)
    for c in cands:
        assert c.times[0] == 0 and c.times[-1] == 1 and np.all(np.diff(c.times) > 0)
        assert np.diff(c.times).max() <= 1 / (2 * c.length) + 1e-12
        on = c.beat_index()
        assert np.allclose(c.times[on], np.arange(c.length + 1) / c.length, atol=0)
        assert c.pose.shape == (len(c.times), 17, 2) and c.root.shape == (len(c.times), 2)
        assert abs(c.root[-1, 0]) < 1e-9  # in place: no net lateral drift
        assert c.m["beat_speed"] < 0.6  # on-beat poses are the held ones
        assert not reasons(c, FilterConfig())  # a clean, front-facing, moving dancer passes every filter


# --- filters ----------------------------------------------------------------------------------


GOOD_METRICS = {
    "nan": 0.0, "min_head": 2.4, "min_hip": 1.3, "inverted": 0.0, "facing_dev": 20.0, "jitter": 0.01, "limb_dev": 0.03,
    "energy": 1.8, "energy2d": 1.6, "peak_speed": 9.0, "leg_speed": 1.5, "arm_speed": 3.0, "hip_speed": 1.0,
    "travel": 0.5, "airborne": 0.15, "root_y_min": -0.1, "root_y_max": 0.2, "torso2d_min": 0.95, "bent_frac": 0.0,
    "arm_collapse": 0.0, "arm_collapse_any": 0.05, "start_speed": 0.6, "beat_speed": 0.7, "tempo_ok": 1.0,
}  # fmt: skip


def make_candidate(seq: str, start: int, length: int, pose_seq: np.ndarray, **metrics: float) -> Candidate:
    times = keyframe_times(length)
    info = parse_name(seq)
    c = Candidate(seq=seq, info=info, length=length, start_beat=start, t0=start * 0.5, bpm=120.0, times=times,
                  pose=pose_seq, root=np.zeros((len(times), 2)))  # fmt: skip
    c.m = {**GOOD_METRICS, **metrics}
    return c


def neutral_seq(n: int) -> np.ndarray:
    return np.repeat(np.array([[NEUTRAL[j] for j in JOINTS]]), n, axis=0)


@pytest.mark.parametrize(
    ("metrics", "rule"),
    [
        ({"min_head": 0.3}, "floor"), ({"inverted": 0.2}, "floor"), ({"facing_dev": 75.0}, "facing"),
        ({"jitter": 0.08}, "jitter"), ({"limb_dev": 0.3}, "limb_length"), ({"energy": 0.2}, "static"),
        ({"energy": 5.0}, "chaotic"), ({"travel": 2.0}, "travel"), ({"airborne": 0.9}, "jump"),
        ({"torso2d_min": 0.4}, "bent"), ({"arm_collapse": 0.7}, "arms_collapsed"), ({"tempo_ok": 0.0}, "tempo"),
    ],
)  # fmt: skip
def test_filter_rules(metrics: dict[str, float], rule: str) -> None:
    good = make_candidate("gHO_sFM_cAll_d19_mHO2_ch03", 0, 4, neutral_seq(9))
    bad = make_candidate("gHO_sFM_cAll_d19_mHO2_ch03", 2, 4, neutral_seq(9), **metrics)
    kept, first, anyc = apply_filters([good, bad])
    assert kept == [good] and bad.reject == rule and first[rule] == 1 and anyc[rule] == 1


# --- tags, selection, export -------------------------------------------------------------------


def synthetic_pool(rng: np.random.Generator, n_seq: int = 6) -> list[Candidate]:
    """Windows of a few fake sequences; each pose sequence = neutral + a random smooth arm/leg motion."""
    cands = []
    for s in range(n_seq):
        seq = f"gJB_sFM_cAll_d07_mJB{s % 6}_ch{s + 1:02d}"
        for start in range(0, 16, 2):
            for length in (4, 8):
                k = 2 * length + 1
                angles = rng.uniform(-60, 160, size=(2, 4))
                frames = []
                for i in range(k):
                    w = i / (k - 1)
                    a = angles[0] * (1 - w) + angles[1] * w
                    pose, _ = forward_kinematics({"l_shoulder": a[0], "r_shoulder": a[1], "l_elbow": a[2] / 2, "r_knee": abs(a[3]) / 3})
                    frames.append([pose[j] for j in JOINTS])
                c = make_candidate(seq, start, length, np.array(frames), energy=float(rng.uniform(0.7, 3.5)),
                                   start_speed=float(rng.uniform(0.2, 1.5)), leg_speed=float(rng.uniform(0.3, 2.5)))  # fmt: skip
                cands.append(c)
    return cands


def test_selection_is_deterministic_diverse_and_non_overlapping() -> None:
    pool = synthetic_pool(np.random.default_rng(7))
    tag_all(pool)
    # an exact duplicate (another dancer, same choreography) and a mirror-image duplicate
    twin = make_candidate("gJB_sFM_cAll_d08_mJB0_ch01", 0, 8, pool[1].pose.copy())
    mirrored = make_candidate("gJB_sFM_cAll_d09_mJB0_ch01", 0, 8, mirror_pose(pool[1].pose))
    for extra in (twin, mirrored):
        extra.tags = dict(pool[1].tags)
    pool += [twin, mirrored]
    cfg = SelectConfig(per_genre=12)
    a = select_genre(pool, cfg)
    b = select_genre(list(reversed(pool)), cfg)
    key = [(c.seq, c.length, c.start_beat) for c in a]
    assert key == [(c.seq, c.length, c.start_beat) for c in b]
    assert len(a) == 12 and {c.length for c in a} == {4, 8}
    for i, x in enumerate(a):
        for y in a[i + 1 :]:
            assert not (x.seq == y.seq and x.t0 < y.end_t and y.t0 < x.end_t), "windows of one sequence overlap"
    picked = {id(c) for c in a}
    assert sum(1 for c in (pool[1], twin, mirrored) if id(c) in picked) <= 1
    assert np.all(np.isfinite(nn_transition(a)))


def test_export_contract(tmp_path: Path) -> None:
    pool = synthetic_pool(np.random.default_rng(3), n_seq=3)
    tag_all(pool)
    picks = select_genre(pool, SelectConfig(per_genre=6))
    doc = build_document(picks)
    assert validate_document(doc) == []
    clip = doc["clips"][0]
    assert clip["id"] == "aist_jb_001" and clip["styles"][-1] == "aist" and "storybook" in clip["styles"]
    assert clip["mirror"] is True and len(clip["scoredJoints"]) >= 2
    assert all(len(k["pose"]) == 17 for k in clip["keyframes"])
    path = tmp_path / "aist_clips.json"
    size = write_document(doc, path)
    assert size == path.stat().st_size and json.loads(path.read_text()) == doc
    names = [c["name"] for c in doc["clips"]]
    assert len(set(names)) == len(names)  # repeated names are numbered
    # contract violations are caught
    broken = json.loads(json.dumps(doc))
    broken["clips"][0]["keyframes"] = [k for k in broken["clips"][0]["keyframes"] if k["t"] != 0.5]
    broken["clips"][1]["id"] = broken["clips"][1]["id"] + "_m"
    errs = validate_document(broken)
    assert any("on-beat" in e or "half a beat" in e for e in errs) and any("bad id" in e for e in errs)
    with pytest.raises(ValueError):
        write_document(broken, tmp_path / "broken.json")


def test_mirror_pose_is_a_geometric_mirror() -> None:
    pose = np.array([[NEUTRAL[j][0] + 0.1 * i, NEUTRAL[j][1]] for i, j in enumerate(JOINTS)])
    m = mirror_pose(pose)
    for i, j in enumerate(JOINTS):
        k = JOINTS.index(MIRROR[j])
        assert m[k, 0] == pytest.approx(-pose[i, 0]) and m[k, 1] == pytest.approx(pose[i, 1])
    assert np.allclose(mirror_pose(m), pose)


def test_committed_clip_file_matches_contract() -> None:
    path = REPO_ROOT / "assets" / "moves" / "aist_clips.json"
    if not path.exists():
        pytest.skip("assets/moves/aist_clips.json not built yet")
    doc = json.loads(path.read_text())
    assert validate_document(doc) == []
    assert path.stat().st_size < 4 * 1024 * 1024
    assert len({c["genre"] for c in doc["clips"]}) == 10
