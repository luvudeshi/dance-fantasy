"""Move library: forward kinematics, mirroring, anchors, the shipped definitions, GET /api/moves."""

from __future__ import annotations

import copy
import json
import math
import random
import re
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from helpers import REPO_ROOT, SHARED_DIR
from jsonschema import Draft202012Validator

from app.config import get_settings
from app.moves.anchors import ANCHOR_TOLERANCE, ANCHORS, anchor_distance, anchor_pose
from app.moves.fk import FOREARM, RANGES, SHIN, THIGH, TURN_MIN_WIDTH, UPPER_ARM, forward_kinematics, turn_projection
from app.moves.library import (
    MoveDefinitionError,
    build_library,
    compile_move,
    load_library,
    mirror_angles,
)
from app.moves.types import CompiledMove, MoveLibrary, Pose, Vec2
from app.skeleton import JOINTS, LEG_JOINTS, MIRROR

MOVES_DIR = REPO_ROOT / "assets" / "moves"
EXAMPLE = json.loads((SHARED_DIR / "examples" / "routine.example.json").read_text())
NEUTRAL = {j: tuple(v) for j, v in EXAMPLE["moves"][0]["keyframes"][0]["pose"].items()}
SCHEMA = json.loads((SHARED_DIR / "routine.schema.json").read_text())
POSE_VALIDATOR = Draft202012Validator({"$defs": SCHEMA["$defs"], "$ref": "#/$defs/pose"})
ROUND_TOL = 2e-4  # compiled poses are rounded to 4 decimals
ARMS = (("l_shoulder", "l_elbow", "l_wrist"), ("r_shoulder", "r_elbow", "r_wrist"))
LEGS = (("l_hip", "l_knee", "l_ankle"), ("r_hip", "r_knee", "r_ankle"))


@pytest.fixture(scope="module")
def lib() -> MoveLibrary:
    return load_library(MOVES_DIR)


@pytest.fixture(scope="module")
def base_moves(lib: MoveLibrary) -> list[CompiledMove]:
    return [m for m in lib.moves if m.mirrorOf is None]


def dist(a: Vec2, b: Vec2) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def mid(pose: Pose, a: str, b: str) -> Vec2:
    return ((pose[a][0] + pose[b][0]) / 2, (pose[a][1] + pose[b][1]) / 2)


def geometric_mirror(pose: Pose) -> Pose:
    return {j: (-pose[MIRROR[j]][0], pose[MIRROR[j]][1]) for j in JOINTS}


def random_angles(rng: random.Random) -> dict[str, float]:
    angles = {k: rng.uniform(lo, hi) for k, (lo, hi) in RANGES.items() if rng.random() < 0.7}
    angles["jump"] = abs(angles.get("jump", 0.0))
    return angles


# --- forward kinematics ------------------------------------------------------------------------


def test_neutral_fk_reproduces_the_example_pose() -> None:
    pose, root = forward_kinematics({})
    assert list(pose) == list(JOINTS)
    for j in JOINTS:
        assert dist(pose[j], NEUTRAL[j]) < 1e-9, j
    assert root == (0.0, 0.0)


def test_fk_properties_hold_for_random_angles() -> None:
    rng = random.Random(7)
    for _ in range(500):
        angles = random_angles(rng)
        pose, root = forward_kinematics(angles)
        assert all(math.isfinite(c) for p in pose.values() for c in p) and all(math.isfinite(c) for c in root)
        assert dist(mid(pose, "l_hip", "r_hip"), (0, 0)) < 1e-9  # body-frame origin
        assert abs(math.hypot(*mid(pose, "l_shoulder", "r_shoulder")) - 1) < 1e-9  # body-frame scale
        for s, e, w in ARMS:  # arms never stretch, whatever the angles (turn only foreshortens widths)
            if not angles.get("turn"):
                assert abs(dist(pose[s], pose[e]) - UPPER_ARM) < 1e-9
                assert abs(dist(pose[e], pose[w]) - FOREARM) < 1e-9
        for side, (h, k, a) in zip("lr", LEGS):
            assert dist(pose[h], pose[k]) <= THIGH + 1e-9 and dist(pose[k], pose[a]) <= SHIN + 1e-9
            if not angles.get(f"{side}_knee") and not angles.get(f"{side}_lift") and not angles.get("turn"):
                assert abs(dist(pose[h], pose[k]) - THIGH) < 1e-9 and abs(dist(pose[k], pose[a]) - SHIN) < 1e-9
        lowest = max(pose["l_ankle"][1], pose["r_ankle"][1])
        assert abs(lowest + root[1] - (1.85 - angles.get("jump", 0.0))) < 1e-9  # feet on the floor unless jumping
        assert abs(root[0] - angles.get("hip_shift", 0.0) - angles.get("travel", 0.0)) < 1e-9


def test_hip_shift_keeps_feet_planted() -> None:
    for shift in (-0.2, 0.15):
        pose, root = forward_kinematics({"hip_shift": shift, "r_knee": 25})
        neutral_pose, neutral_root = forward_kinematics({"r_knee": 25})
        for ankle in ("l_ankle", "r_ankle"):
            assert abs(pose[ankle][0] + root[0] - (neutral_pose[ankle][0] + neutral_root[0])) < 1e-9


def test_mirrored_angles_give_the_geometric_mirror() -> None:
    rng = random.Random(11)
    for _ in range(500):
        angles = random_angles(rng)
        pose, root = forward_kinematics(angles)
        mpose, mroot = forward_kinematics(mirror_angles(angles))
        expected = geometric_mirror(pose)
        for j in JOINTS:
            assert dist(mpose[j], expected[j]) < 1e-12, (j, angles)
        assert abs(mroot[0] + root[0]) < 1e-12 and abs(mroot[1] - root[1]) < 1e-12


@pytest.mark.parametrize("turn", [0.2, 0.25, 0.3, 0.7, 0.75, 0.8, -0.25, 1.25])
def test_side_on_spins_keep_a_readable_width(turn: float) -> None:
    """A pure side view collapses the figure into a column (legs merged, the raised arm through the head):
    widths stay >= TURN_MIN_WIDTH of the front view, and sides swap past side-on."""
    pose, _ = forward_kinematics({"turn": turn, "r_shoulder": 168, "r_elbow": 45, "l_shoulder": 60, "l_elbow": -40})
    shoulders = pose["r_shoulder"][0] - pose["l_shoulder"][0]
    hips = pose["r_hip"][0] - pose["l_hip"][0]
    assert abs(shoulders) == pytest.approx(0.9 * TURN_MIN_WIDTH)
    assert abs(hips) == pytest.approx(0.44 * TURN_MIN_WIDTH)
    assert abs(pose["r_ankle"][0] - pose["l_ankle"][0]) >= 0.44 * TURN_MIN_WIDTH - 1e-9  # legs don't merge
    front = math.cos(2 * math.pi * turn) > 0
    assert (shoulders > 0) == front and (hips > 0) == front


def test_turn_projection_is_a_clamped_rotation() -> None:
    for i in range(-400, 401):
        turn = i / 200
        c, s = turn_projection(turn)
        assert abs(c) >= TURN_MIN_WIDTH - 1e-12 and c * c + s * s == pytest.approx(1.0)  # bones never stretch
        assert turn_projection(-turn) == (c, -s)  # mirrored moves stay exact mirrors
        if abs(math.cos(2 * math.pi * turn)) >= TURN_MIN_WIDTH:
            assert (c, s) == pytest.approx((math.cos(2 * math.pi * turn), math.sin(2 * math.pi * turn)))


def test_fk_rejects_unknown_angles() -> None:
    with pytest.raises(ValueError, match="unknown angle"):
        forward_kinematics({"l_wrist": 10})


# --- anchors -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("name", list(ANCHORS))
def test_anchors_are_symmetric(name: str) -> None:
    pose, root = anchor_pose(name)
    mirrored = geometric_mirror(pose)
    assert all(dist(pose[j], mirrored[j]) < 1e-9 for j in JOINTS)
    assert root[0] == pytest.approx(0.0, abs=1e-12)


def test_every_move_starts_and_ends_on_its_anchors(lib: MoveLibrary) -> None:
    for m in lib.moves:
        assert m.startAnchor in ANCHORS and m.endAnchor in ANCHORS, m.id
        first, last = m.keyframes[0], m.keyframes[-1]
        assert anchor_distance(first.pose, first.root, m.startAnchor) <= ANCHOR_TOLERANCE, m.id
        assert anchor_distance(last.pose, last.root, m.endAnchor) <= ANCHOR_TOLERANCE, m.id
        assert math.hypot(*first.root) <= ANCHOR_TOLERANCE and math.hypot(*last.root) <= ANCHOR_TOLERANCE, m.id


# --- the shipped library -----------------------------------------------------------------------------


def test_library_loads_with_a_short_version(lib: MoveLibrary) -> None:
    assert re.fullmatch(r"[0-9a-f]{12}", lib.version)
    ids = [m.id for m in lib.moves]
    assert len(ids) == len(set(ids))


def test_keyframes_sit_on_every_beat(lib: MoveLibrary) -> None:
    for m in lib.moves:
        ts = [k.t for k in m.keyframes]
        assert m.lengthBeats in (1, 2, 4, 8), m.id
        assert ts[0] == 0 and ts[-1] == 1, m.id
        assert all(b > a for a, b in zip(ts, ts[1:])), m.id
        for k in range(m.lengthBeats + 1):
            assert any(abs(t - k / m.lengthBeats) < 1e-9 for t in ts), (m.id, k)


def test_compiled_poses_are_complete_and_well_formed(lib: MoveLibrary) -> None:
    for m in lib.moves:
        for kf in m.keyframes:
            assert list(kf.pose) == list(JOINTS), m.id
            assert all(math.isfinite(c) for p in kf.pose.values() for c in p), m.id
            assert all(math.isfinite(c) for c in kf.root), m.id
            assert dist(mid(kf.pose, "l_hip", "r_hip"), (0, 0)) < ROUND_TOL, m.id
            assert abs(math.hypot(*mid(kf.pose, "l_shoulder", "r_shoulder")) - 1) < ROUND_TOL, (m.id, kf.t)
            turning = dist(kf.pose["r_shoulder"], kf.pose["l_shoulder"]) < 0.9 - ROUND_TOL  # widths shrink in a spin
            for s, e, w in ARMS:
                if not turning:
                    assert abs(dist(kf.pose[s], kf.pose[e]) - UPPER_ARM) < ROUND_TOL, (m.id, kf.t)
                    assert abs(dist(kf.pose[e], kf.pose[w]) - FOREARM) < ROUND_TOL, (m.id, kf.t)
            for h, k, a in LEGS:
                assert dist(kf.pose[h], kf.pose[k]) <= THIGH + ROUND_TOL, (m.id, kf.t)
                assert dist(kf.pose[k], kf.pose[a]) <= SHIN + ROUND_TOL, (m.id, kf.t)
            # Feet: on the floor unless jumping, never below it; knees never above the hips' line by much.
            floor = max(kf.pose["l_ankle"][1], kf.pose["r_ankle"][1]) + kf.root[1]
            assert floor <= 1.85 + ROUND_TOL, (m.id, kf.t)


def test_no_keyframe_collapses_side_on(lib: MoveLibrary) -> None:
    """Twirl / princess spin included: shoulders and hips never get narrower than TURN_MIN_WIDTH."""
    narrow = lambda m: any(dist(k.pose["l_shoulder"], k.pose["r_shoulder"]) < 0.8 for k in m.keyframes)  # noqa: E731
    spins = {m.baseId for m in lib.moves if narrow(m)}
    assert spins == {"twirl", "princess_spin"}
    for m in lib.moves:
        for kf in m.keyframes:
            assert dist(kf.pose["l_shoulder"], kf.pose["r_shoulder"]) >= 0.9 * TURN_MIN_WIDTH - ROUND_TOL, (m.id, kf.t)
            assert dist(kf.pose["l_hip"], kf.pose["r_hip"]) >= 0.44 * TURN_MIN_WIDTH - ROUND_TOL, (m.id, kf.t)


def on_beat_poses(m: CompiledMove) -> list[Pose]:
    return [k.pose for k in m.keyframes if abs(k.t * m.lengthBeats - round(k.t * m.lengthBeats)) < 1e-9]


def pose_gap(a: Pose, b: Pose) -> float:
    return max(dist(a[j], b[j]) for j in JOINTS)


def test_signature_poses_land_on_beats(base_moves: list[CompiledMove]) -> None:
    """Scoring checkpoints are the on-beat keyframes, so a move's biggest shape must be on a beat (boxer_jab's
    punch used to land between beats: only its guard was ever scored). 1-beat moves repeat in pairs, so they
    start and end on the same anchor and their beat pose is that anchor (a clap)."""
    for m in base_moves:
        if m.lengthBeats == 1:
            assert m.startAnchor == m.endAnchor, m.id
            continue
        start = m.keyframes[0].pose
        reach_on = max(pose_gap(p, start) for p in on_beat_poses(m))
        reach_all = max(pose_gap(k.pose, start) for k in m.keyframes)
        assert reach_on >= 0.5 * reach_all, (m.id, round(reach_on, 2), round(reach_all, 2))


def test_consecutive_on_beat_poses_differ(base_moves: list[CompiledMove]) -> None:
    """Every beat asks for something new: floss, dragon_wings, vogue_frame, raise_the_roof... used to repeat
    one pose on beats 1-3 (the half-beat moves were never scored). Freezes hold on purpose."""
    for m in base_moves:
        if "freeze" in m.styles or m.lengthBeats == 1:
            continue
        poses = on_beat_poses(m)
        for beat, (a, b) in enumerate(zip(poses, poses[1:])):
            assert pose_gap(a, b) > 0.1, (m.id, f"beats {beat}-{beat + 1}")


def test_mirror_pairs_are_exact_geometric_mirrors(lib: MoveLibrary) -> None:
    by_id = lib.by_id()
    twins = [m for m in lib.moves if m.mirrorOf is not None]
    assert twins
    for twin in twins:
        orig = by_id[twin.mirrorOf]  # type: ignore[index]
        assert orig.mirrorOf is None and orig.baseId == twin.baseId
        assert {orig.side, twin.side} == {"L", "R"}
        assert orig.id == f"{orig.baseId}_{orig.side}" and twin.id == f"{twin.baseId}_{twin.side}"
        side_word = {"L": "Left", "R": "Right"}
        assert orig.name.endswith(side_word[orig.side]) and twin.name.endswith(side_word[twin.side])
        assert (twin.lengthBeats, twin.intensity, twin.difficulty, twin.upperBodyOnly, twin.styles) == (
            orig.lengthBeats, orig.intensity, orig.difficulty, orig.upperBodyOnly, orig.styles,
        )  # fmt: skip
        assert set(twin.scoredJoints) == {MIRROR[j] for j in orig.scoredJoints}
        assert (twin.startAnchor, twin.endAnchor) == (orig.startAnchor, orig.endAnchor)
        assert len(twin.keyframes) == len(orig.keyframes)
        for a, b in zip(orig.keyframes, twin.keyframes):
            assert a.t == b.t
            assert b.pose == geometric_mirror(a.pose) or all(
                dist(b.pose[j], geometric_mirror(a.pose)[j]) < 1e-9 for j in JOINTS
            ), (twin.id, a.t)
            assert abs(b.root[0] + a.root[0]) < 1e-9 and abs(b.root[1] - a.root[1]) < 1e-9


def test_upper_body_only_moves_keep_legs_neutral(lib: MoveLibrary) -> None:
    neutral, _ = forward_kinematics({})
    for m in lib.moves:
        if not m.upperBodyOnly:
            continue
        assert "legs" not in m.bodyParts, m.id
        assert not set(m.scoredJoints) & {"l_knee", "r_knee", "l_ankle", "r_ankle"}, m.id
        for kf in m.keyframes:
            assert kf.root == (0.0, 0.0), m.id
            assert all(dist(kf.pose[j], neutral[j]) < 1e-9 for j in LEG_JOINTS), m.id


def test_move_metadata_is_sane(lib: MoveLibrary) -> None:
    for m in lib.moves:
        assert m.name.strip() and m.styles and all(s for s in m.styles), m.id
        assert 1 <= m.intensity <= 5 and m.difficulty in ("easy", "normal", "hard"), m.id
        assert m.scoredJoints and set(m.scoredJoints) <= set(JOINTS), m.id
        assert list(m.scoredJoints) == [j for j in JOINTS if j in m.scoredJoints], m.id
        assert m.bodyParts and set(m.bodyParts) <= {"arms", "legs", "torso", "head"}, m.id
        assert m.side in ("L", "R", "both"), m.id


def test_distribution_targets(base_moves: list[CompiledMove]) -> None:
    assert len(base_moves) >= 40
    for level in range(1, 6):
        assert sum(m.intensity == level for m in base_moves) >= 4, f"intensity {level}"
    seated = [m for m in base_moves if m.upperBodyOnly]
    assert len(seated) >= 15
    assert {m.intensity for m in seated} == {1, 2, 3, 4, 5}
    assert {m.difficulty for m in base_moves} == {"easy", "normal", "hard"}
    assert {m.lengthBeats for m in base_moves} == {1, 2, 4, 8}
    styles = {s for m in base_moves for s in m.styles}
    assert {"pop", "hiphop", "latin", "storybook"} <= styles
    for required in ("curtsy", "royal_wave", "twirl", "sword_flourish", "midnight_clock", "glass_slipper_kick", "princess_spin"):
        assert any(m.baseId == required for m in base_moves), required


# --- definition errors / loader ------------------------------------------------------------------


GOOD = {
    "id": "test_move", "name": "Test", "lengthBeats": 2, "intensity": 2, "difficulty": "easy", "styles": ["pop"],
    "side": "R", "mirror": True,
    "keyframes": [{"beat": 0}, {"beat": 1, "angles": {"r_shoulder": 90}}, {"beat": 2, "from": "neutral"}],
}  # fmt: skip


def test_compile_good_definition() -> None:
    moves = compile_move(copy.deepcopy(GOOD))
    assert [m.id for m in moves] == ["test_move_R", "test_move_L"]
    assert moves[1].mirrorOf == "test_move_R" and moves[0].mirrorOf is None
    assert [m.name for m in moves] == ["Test Right", "Test Left"]
    assert moves[0].upperBodyOnly and moves[0].scoredJoints == ("r_elbow", "r_wrist")
    assert moves[1].scoredJoints == ("l_elbow", "l_wrist")


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"keyframes": [{"beat": 0}, {"beat": 2}]}, "missing a keyframe on beat 1"),
        ({"keyframes": [{"beat": 0}, {"beat": 1}, {"beat": 1.5}]}, "last at t=1"),
        ({"keyframes": [{"beat": 0}, {"beat": 1, "angles": {"r_wrist": 3}}, {"beat": 2}]}, "unknown angle"),
        ({"keyframes": [{"beat": 0}, {"beat": 1, "angles": {"r_knee": -5}}, {"beat": 2}]}, "outside"),
        ({"keyframes": [{"beat": 0}, {"beat": 1, "t": 0.5}, {"beat": 2}]}, "exactly one"),
        ({"side": "both"}, "mirror needs side"),
        ({"lengthBeats": 3}, "lengthBeats"),
        ({"startAnchor": "nope"}, "not an anchor"),
        ({"endAnchor": "arms_up"}, "from anchor 'arms_up'"),
        ({"colour": "red"}, "unknown fields"),
        ({"id": "wave_L"}, "_L/_R"),
    ],
)
def test_bad_definitions_name_the_move(patch: dict, message: str) -> None:
    raw = {**copy.deepcopy(GOOD), **patch}
    with pytest.raises(MoveDefinitionError, match=re.escape(message)) as info:
        compile_move(raw, where="bad.json")
    assert "bad.json" in str(info.value) and repr(raw["id"]) in str(info.value)


def test_duplicate_ids_across_files_are_rejected() -> None:
    doc = json.dumps({"moves": [GOOD]}).encode()
    with pytest.raises(MoveDefinitionError, match="duplicate move id 'test_move_R'"):
        build_library([("a.json", doc), ("b.json", doc)])


@pytest.fixture
def moves_copy(tmp_path: Path) -> Path:
    target = tmp_path / "moves"
    shutil.copytree(MOVES_DIR, target)
    return target


def test_load_library_caches_until_a_file_changes(moves_copy: Path) -> None:
    first = load_library(moves_copy)
    assert load_library(moves_copy) is first
    path = moves_copy / "arms.json"
    doc = json.loads(path.read_text())
    doc["moves"][0]["intensity"] = 2
    path.write_text(json.dumps(doc))
    second = load_library(moves_copy)
    assert second is not first and second.version != first.version
    (moves_copy / "extra.json").write_text("{not json")
    with pytest.raises(MoveDefinitionError, match="extra.json: invalid JSON"):
        load_library(moves_copy)


# --- HTTP API --------------------------------------------------------------------------------------------


def ts_interface_fields(name: str) -> list[str]:
    source = (SHARED_DIR / "moves.ts").read_text()
    body = re.search(rf"export interface {name} \{{(.*?)\n\}}", source, re.S)
    assert body, name
    return re.findall(r"^\s+(\w+)\??:", body.group(1), re.M)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("ASSETS_DIR", str(REPO_ROOT / "assets"))
    get_settings.cache_clear()
    from app.main import app

    yield TestClient(app)  # no lifespan: skips the beat-tracker warmup thread
    get_settings.cache_clear()


def test_api_moves_matches_the_contract(client: TestClient, lib: MoveLibrary) -> None:
    res = client.get("/api/moves")
    assert res.status_code == 200
    body = res.json()
    assert list(body) == ts_interface_fields("MoveLibraryResponse")
    assert body["version"] == lib.version
    assert [m["id"] for m in body["moves"]] == [m.id for m in lib.moves]
    move_fields = set(ts_interface_fields("LibraryMove"))
    keyframe_fields = set(ts_interface_fields("MoveKeyframe"))
    for move in body["moves"]:
        assert set(move) == move_fields, move["id"]
        assert move["mirrorOf"] is None or isinstance(move["mirrorOf"], str)
        assert isinstance(move["upperBodyOnly"], bool) and isinstance(move["lengthBeats"], int)
        for kf in move["keyframes"]:
            assert set(kf) == keyframe_fields
            assert list(kf["pose"]) == list(JOINTS)
            assert not list(POSE_VALIDATOR.iter_errors(kf["pose"])), move["id"]
            assert len(kf["root"]) == 2 and all(isinstance(c, (int, float)) for c in kf["root"])
    assert any(m["mirrorOf"] is None for m in body["moves"]) and any(m["mirrorOf"] for m in body["moves"])
