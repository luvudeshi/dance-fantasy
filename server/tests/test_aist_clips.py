"""Real-dancer clips (app.moves.clips): loading aist_clips.json into the move library, mirrors, versions, API."""

from __future__ import annotations

import copy
import json
import math
import re
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from aist_fixtures import FIXTURE_BYTES, MOVES_DIR, REAL_CLIPS, classic_files, clips_library, fixture_doc
from fastapi.testclient import TestClient

from app.config import get_settings
from app.moves.clips import CLIPS_FILE, FREE_ANCHOR, compile_clip, mirror_pose
from app.moves.library import MoveDefinitionError, build_library, load_library
from app.moves.types import CompiledMove, MoveLibrary
from app.skeleton import JOINTS, MIRROR

LIB = clips_library()
CLASSIC = build_library(classic_files())


def clips_of(lib: MoveLibrary) -> list[CompiledMove]:
    return [m for m in lib.moves if m.source == "aist"]


def on_beat_ts(m: CompiledMove) -> list[float]:
    return [k.t for k in m.keyframes if abs(k.t * m.lengthBeats - round(k.t * m.lengthBeats)) < 1e-9]


def check_clip_invariants(lib: MoveLibrary, body_frame_tol: float) -> None:
    """What every compiled clip guarantees (the fixture and the real file alike)."""
    clips = clips_of(lib)
    assert clips
    ids = [m.id for m in lib.moves]
    assert len(ids) == len(set(ids))
    by_id = lib.by_id()
    for m in clips:
        assert m.startAnchor == m.endAnchor == FREE_ANCHOR, m.id
        assert "aist" in m.styles and m.credit and "AIST++" in m.credit, m.id
        assert m.lengthBeats in (1, 2, 4, 8) and 1 <= m.intensity <= 5, m.id
        assert m.scoredJoints and list(m.scoredJoints) == [j for j in JOINTS if j in m.scoredJoints], m.id
        ts = [k.t for k in m.keyframes]
        assert ts[0] == 0 and ts[-1] == 1 and all(b > a for a, b in zip(ts, ts[1:])), m.id
        assert on_beat_ts(m) == [k / m.lengthBeats for k in range(m.lengthBeats + 1)], m.id  # exact on-beat targets
        assert max(b - a for a, b in zip(ts, ts[1:])) <= 0.5 / m.lengthBeats + 1.5e-3, m.id  # every half beat (t has 3 decimals)
        for kf in m.keyframes:
            assert list(kf.pose) == list(JOINTS), m.id
            assert all(math.isfinite(c) for p in kf.pose.values() for c in p) and all(math.isfinite(c) for c in kf.root)
            # Body frame (shared/README.md): mid-hip at the origin, mid-shoulder one unit away.
            mh = ((kf.pose["l_hip"][0] + kf.pose["r_hip"][0]) / 2, (kf.pose["l_hip"][1] + kf.pose["r_hip"][1]) / 2)
            ms = ((kf.pose["l_shoulder"][0] + kf.pose["r_shoulder"][0]) / 2, (kf.pose["l_shoulder"][1] + kf.pose["r_shoulder"][1]) / 2)
            assert math.hypot(*mh) < body_frame_tol, (m.id, kf.t)
            assert abs(math.hypot(ms[0] - mh[0], ms[1] - mh[1]) - 1) < body_frame_tol, (m.id, kf.t)
            assert ms[1] < mh[1], (m.id, kf.t)  # upright: +y is down
        if m.mirrorOf is not None:
            orig = by_id[m.mirrorOf]
            assert m.id == orig.id + "_m" and m.baseId == orig.baseId == orig.id and orig.mirrorOf is None
            assert set(m.scoredJoints) == {MIRROR[j] for j in orig.scoredJoints}
            for a, b in zip(orig.keyframes, m.keyframes, strict=True):
                assert a.t == b.t and b.pose == mirror_pose(a.pose) and b.root == (-a.root[0] + 0.0, a.root[1])


# --- loader ------------------------------------------------------------------------------------------


def test_fixture_clips_compile_with_mirrors() -> None:
    doc = fixture_doc()
    clips = clips_of(LIB)
    assert len(clips) == 2 * len(doc["clips"])
    assert [m.id for m in LIB.moves[: len(CLASSIC.moves)]] == [m.id for m in CLASSIC.moves]  # classic first, unchanged
    assert {m.id for m in clips} == {c["id"] for c in doc["clips"]} | {c["id"] + "_m" for c in doc["clips"]}
    first = LIB.by_id()["aist_jb_001"]
    assert first.name == "Ballet Jazz Sweep" and first.styles == ("ballet", "jazz", "storybook", "aist")
    assert first.credit and "gJB_sBM_cAll_d07_mJB0_ch01 @ 3.21s" in first.credit
    assert LIB.by_id()["aist_jb_001_m"].name == "Ballet Jazz Sweep (mirrored)"
    assert LIB.attribution == doc["attribution"]
    assert all(m.source == "library" and m.credit is None for m in CLASSIC.moves)
    check_clip_invariants(LIB, body_frame_tol=0.01)


def test_mirror_is_the_exact_geometric_mirror() -> None:
    raw = fixture_doc()["clips"][1]
    orig, twin = compile_clip(copy.deepcopy(raw))
    for a, b in zip(orig.keyframes, twin.keyframes, strict=True):
        for j in JOINTS:
            assert b.pose[j] == (-a.pose[MIRROR[j]][0] + 0.0, a.pose[MIRROR[j]][1])
    assert mirror_pose(mirror_pose(orig.keyframes[2].pose)) == orig.keyframes[2].pose
    one_sided = compile_clip({**copy.deepcopy(raw), "side": "R", "scoredJoints": ["r_elbow", "r_wrist"]})
    assert [m.side for m in one_sided] == ["R", "L"] and one_sided[1].scoredJoints == ("l_elbow", "l_wrist")
    assert compile_clip({**copy.deepcopy(raw), "mirror": False})[0].id == raw["id"]


def test_on_beat_times_are_snapped_exactly() -> None:
    raw = copy.deepcopy(fixture_doc()["clips"][0])  # 8 beats: 0.125, 0.375 ... (exact) + half beats
    raw["keyframes"][6]["t"] = 0.3749  # beat 3 written slightly off: still the beat-3 checkpoint
    (m,) = compile_clip({**raw, "mirror": False})
    assert on_beat_ts(m) == [k / 8 for k in range(9)]


def _bad(patch) -> dict:
    raw = copy.deepcopy(fixture_doc()["clips"][1])  # 4 beats, keyframes every half beat
    patch(raw)
    return raw


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        (lambda r: r["keyframes"][3]["pose"].pop("l_ankle"), "exactly the 17 joints"),
        (lambda r: r["keyframes"][3]["pose"].__setitem__("nose", [float("nan"), 0.0]), "finite"),
        (lambda r: r["keyframes"][3]["pose"].__setitem__("nose", [0.0, 99.0]), "body units"),
        (lambda r: r["keyframes"].pop(2), "missing the on-beat keyframe for beat 1"),
        (lambda r: r["keyframes"].__setitem__(3, {**r["keyframes"][3], "t": 0.1}), "strictly ascending"),
        (lambda r: r["keyframes"].pop(), "last at t=1"),
        (lambda r: r.__setitem__("id", "aist_po_002_m"), "suffix"),
        (lambda r: r.__setitem__("id", "Aist_Po"), "lowercase"),
        (lambda r: r.__setitem__("lengthBeats", 3), "lengthBeats"),
        (lambda r: r.__setitem__("intensity", 6), "intensity"),
        (lambda r: r.__setitem__("scoredJoints", ["l_wrist", "tail"]), "scoredJoints"),
        (lambda r: r.__setitem__("tempo", 120), "unknown fields"),
        (lambda r: r.pop("upperBodyOnly"), "missing fields"),
    ],
)
def test_bad_clips_name_the_clip(patch, message: str) -> None:
    raw = _bad(patch)
    doc = {**fixture_doc(), "clips": [raw]}
    with pytest.raises(MoveDefinitionError, match=re.escape(message)) as info:
        build_library(classic_files(), json.dumps(doc).encode())
    assert CLIPS_FILE in str(info.value)


def test_bad_clip_file_shapes() -> None:
    for content in (b"{nope", b"[]", json.dumps({"version": 2, "clips": []}).encode()):
        with pytest.raises(MoveDefinitionError, match=CLIPS_FILE):
            build_library(classic_files(), content)
    clash = {**fixture_doc(), "clips": [{**fixture_doc()["clips"][0], "id": "clap_clap", "mirror": False}]}
    with pytest.raises(MoveDefinitionError, match="duplicate move id 'clap_clap'"):
        build_library(classic_files(), json.dumps(clash).encode())


@pytest.fixture
def moves_dir(tmp_path: Path) -> Path:
    """A copy of the shipped classic move files (without any real clip file)."""
    target = tmp_path / "moves"
    target.mkdir()
    for name, content in classic_files():
        (target / name).write_bytes(content)
    return target


def test_absent_clip_file_is_classic_only(moves_dir: Path) -> None:
    lib = load_library(moves_dir)
    assert not clips_of(lib) and lib.attribution is None and lib.clipsError is None
    assert lib.version == CLASSIC.version


def test_clip_file_is_loaded_and_part_of_the_version(moves_dir: Path) -> None:
    (moves_dir / CLIPS_FILE).write_bytes(FIXTURE_BYTES)
    lib = load_library(moves_dir)
    assert lib.version == LIB.version != CLASSIC.version
    assert [m.id for m in lib.moves] == [m.id for m in LIB.moves]
    assert load_library(moves_dir) is lib  # cached
    doc = fixture_doc()
    doc["clips"][0]["intensity"] = 3
    (moves_dir / CLIPS_FILE).write_text(json.dumps(doc))
    changed = load_library(moves_dir)
    assert changed.version not in (lib.version, CLASSIC.version)
    assert changed.by_id()["aist_jb_001"].intensity == 3
    (moves_dir / CLIPS_FILE).unlink()
    assert load_library(moves_dir).version == CLASSIC.version


def test_invalid_clip_file_never_takes_the_classic_moves_down(moves_dir: Path) -> None:
    doc = fixture_doc()
    doc["clips"][2]["keyframes"][1]["pose"].pop("nose")
    (moves_dir / CLIPS_FILE).write_text(json.dumps(doc))
    lib = load_library(moves_dir)
    assert [m.id for m in lib.moves] == [m.id for m in CLASSIC.moves] and lib.version == CLASSIC.version
    assert lib.clipsError and "aist_lo_003" in lib.clipsError and "nose" in lib.clipsError


@pytest.mark.skipif(not REAL_CLIPS.exists(), reason="assets/moves/aist_clips.json not built")
def test_real_clip_file_is_valid() -> None:
    """The committed clip file (server/scripts/aist/build_clips.py) loads strictly and keeps the invariants."""
    lib = build_library(classic_files(), REAL_CLIPS.read_bytes())  # strict: any problem raises
    check_clip_invariants(lib, body_frame_tol=0.02)
    clips = [m for m in clips_of(lib) if m.mirrorOf is None]
    assert len(clips) >= 50
    assert any(m.upperBodyOnly for m in clips) and {m.difficulty for m in clips} >= {"easy", "normal", "hard"}
    assert lib.attribution and "CC BY 4.0" in lib.attribution and "AIST" in lib.attribution


# --- HTTP API ------------------------------------------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    assets = tmp_path / "assets"
    shutil.copytree(MOVES_DIR, assets / "moves", ignore=shutil.ignore_patterns(CLIPS_FILE))
    (assets / "moves" / CLIPS_FILE).write_bytes(FIXTURE_BYTES)
    monkeypatch.setenv("ASSETS_DIR", str(assets))
    get_settings.cache_clear()
    from app.main import app

    yield TestClient(app)
    get_settings.cache_clear()


def test_api_moves_carries_source_and_credit(client: TestClient) -> None:
    body = client.get("/api/moves").json()
    assert body["version"] == LIB.version and body["attribution"] == LIB.attribution
    by_id = {m["id"]: m for m in body["moves"]}
    assert by_id["aist_po_002"]["source"] == "aist" and "AIST++" in by_id["aist_po_002"]["credit"]
    assert by_id["aist_po_002"]["hasMirror"] is True and "aist_po_002_m" not in by_id  # twins: ?mirrors=1
    every = {m["id"]: m for m in client.get("/api/moves", params={"mirrors": 1}).json()["moves"]}
    assert every["aist_po_002_m"]["mirrorOf"] == "aist_po_002" and every["aist_po_002_m"]["startAnchor"] == "free"
    assert by_id["clap_clap"]["source"] == "library" and by_id["clap_clap"]["credit"] is None


def test_api_move_sources(client: TestClient) -> None:
    body = client.get("/api/moves/sources").json()
    n_clips = len(fixture_doc()["clips"])
    assert body == {
        "version": LIB.version,
        "attribution": LIB.attribution,
        "clipsError": None,
        "library": {"moves": len(CLASSIC.moves), "baseMoves": len({m.baseId for m in CLASSIC.moves})},
        "aist": {"moves": 2 * n_clips, "baseMoves": n_clips},
    }
