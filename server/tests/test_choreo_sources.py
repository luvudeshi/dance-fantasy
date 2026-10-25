"""Choreographer move sources (classic / real-dancer clips / mix) with the fixture clip file, plus the
motion-graph transition cap and performance with ~600 candidate moves."""

from __future__ import annotations

import json
import math
import time
from dataclasses import replace

import numpy as np
import pytest
from aist_fixtures import FIXTURE_BYTES, REAL_CLIPS, big_clip_bytes, classic_files, clips_library, fixture_doc
from choreo_fixtures import DEFAULT_LAYOUT, check_layout, make_analysis, section_moves
from helpers import SHARED_DIR
from jsonschema import Draft202012Validator

from app.analysis import Analysis
from app.choreo import DEFAULT_CONFIG, GENERATOR, MOVE_SOURCES, NoEligibleMoves, generate_routine, routine_id
from app.choreo import generator
from app.moves.library import build_library
from app.moves.types import CompiledMove, MoveLibrary
from app.routine import Routine
from app.skeleton import JOINTS

ROUTINE_VALIDATOR = Draft202012Validator(json.loads((SHARED_DIR / "routine.schema.json").read_text()))
LIB = clips_library()
CLASSIC = MoveLibrary(moves=tuple(m for m in LIB.moves if m.source == "library"), version=LIB.version)
BY_ID = LIB.by_id()
DIFFICULTIES = ("easy", "normal", "hard")
MODES = ("standing", "seated")


@pytest.fixture(scope="module")
def analysis() -> Analysis:
    return make_analysis()


def aist_share(routine: Routine) -> float:
    return sum(BY_ID[m.id].source == "aist" for m in routine.moves) / len(routine.moves)


def edge(a: CompiledMove, b: CompiledMove, w_root: float = DEFAULT_CONFIG.w_root) -> float:
    """The generator's edge length: mean joint distance end(a) -> start(b) + w_root x root jump."""
    e, s = a.keyframes[-1], b.keyframes[0]
    joints = sum(math.dist(e.pose[j], s.pose[j]) for j in JOINTS) / len(JOINTS)
    return joints + w_root * math.dist(e.root, s.root)


def searched_pairs(routine: Routine) -> list[tuple[CompiledMove, CompiledMove]]:
    """Consecutive moves inside one section occurrence (edges the beam search costed; a replayed group's
    first move follows whatever precedes that occurrence, which the search of the group never saw)."""
    out = []
    for row in routine.meta["sectionPlan"]:
        if row["firstMove"] is not None:
            mvs = routine.moves[row["firstMove"] : row["lastMove"] + 1]
            out += [(BY_ID[a.id], BY_ID[b.id]) for a, b in zip(mvs, mvs[1:])]
    return out


@pytest.mark.parametrize("source", MOVE_SOURCES)
@pytest.mark.parametrize("difficulty", DIFFICULTIES)
@pytest.mark.parametrize("mode", MODES)
def test_layout_schema_and_determinism(analysis: Analysis, source: str, difficulty: str, mode: str) -> None:
    for seed in (0, 5):
        routine = generate_routine(analysis, LIB, difficulty, mode, seed, move_source=source)
        check_layout(routine)
        doc = routine.to_json_dict()
        assert not [e.message for e in ROUTINE_VALIDATOR.iter_errors(doc)]
        assert generate_routine(analysis, LIB, difficulty, mode, seed, move_source=source).to_json_dict() == doc
        meta = doc["meta"]
        assert meta["generator"] == GENERATOR == "procedural-v5"
        assert meta["moveSource"] == source
        assert meta["routineId"] == routine_id(analysis.id, analysis.analysisVersion, LIB.version, difficulty, mode, seed, source)
        assert meta["aistMoves"] == sum(BY_ID[m.id].source == "aist" for m in routine.moves)
        assert ("credit" in meta) == (meta["aistMoves"] > 0)
        for mv in doc["moves"]:
            lib_move = BY_ID[mv["id"]]
            assert mv["scoredJoints"] == list(lib_move.scoredJoints) and len(mv["keyframes"]) == len(lib_move.keyframes)
            assert all(len(k["pose"]) == 17 for k in mv["keyframes"])
        if mode == "seated":
            assert all(BY_ID[m.id].upperBodyOnly for m in routine.moves)
        if difficulty != "hard":
            assert all(BY_ID[m.id].difficulty != "hard" for m in routine.moves)


def test_routine_ids_differ_by_source(analysis: Analysis) -> None:
    ids = {generate_routine(analysis, LIB, "normal", "standing", 1, move_source=s).meta["routineId"] for s in MOVE_SOURCES}
    assert len(ids) == 3


def test_classic_ignores_the_clips(analysis: Analysis) -> None:
    """classic = the v3 search on the library moves: adding a clip file changes nothing but the version."""
    for difficulty in DIFFICULTIES:
        for mode in MODES:
            for seed in range(3):
                a = generate_routine(analysis, LIB, difficulty, mode, seed)
                b = generate_routine(analysis, CLASSIC, difficulty, mode, seed)
                assert [m.id for m in a.moves] == [m.id for m in b.moves]
                assert a.meta["aistMoves"] == 0 and a.meta["moveSource"] == "classic"


@pytest.mark.parametrize("mode", MODES)
def test_aist_routines_are_real_dancers_with_a_storybook_finale(analysis: Analysis, mode: str) -> None:
    finales = clips = total = 0
    for difficulty in DIFFICULTIES:
        for seed in range(4):
            routine = generate_routine(analysis, LIB, difficulty, mode, seed, move_source="aist")
            body = routine.moves[:-1]
            n = sum(BY_ID[m.id].source == "aist" for m in body)
            clips, total = clips + n, total + len(body)
            if mode == "standing":
                assert n >= 0.7 * len(body), (difficulty, seed)
            last = BY_ID[routine.moves[-1].id]
            finales += last.source == "library" and "finale" in last.styles
            for m in body:  # library moves only as the fallback: never a finisher mid-routine
                assert "finale" not in BY_ID[m.id].styles
    assert finales >= 9  # of 12: ends on the curtsy / royal wave whenever the last clip lands near it
    # Seated: the fixture has only 4 upper-body clips (intensity 2-3), so hard choruses fall back to library moves.
    assert clips >= 0.6 * total


def test_mix_uses_both_sources(analysis: Analysis) -> None:
    shares = [
        aist_share(generate_routine(analysis, LIB, d, "standing", s, move_source="mix")) for d in DIFFICULTIES for s in range(4)
    ]
    assert 0 < min(shares) and max(shares) < 1, shares
    assert 0.2 <= float(np.mean(shares)) <= 0.8, shares
    assert all("finale" in BY_ID[generate_routine(analysis, LIB, "normal", m, 0, move_source="mix").moves[-1].id].styles for m in MODES)


@pytest.mark.parametrize("source", ("aist", "mix"))
def test_choruses_still_match(analysis: Analysis, source: str) -> None:
    for seed in range(4):
        routine = generate_routine(analysis, LIB, "normal", "standing", seed, move_source=source)
        per_section = section_moves(routine)
        chorus = [i for i, (label, _, _, _) in enumerate(DEFAULT_LAYOUT) if label == "chorus"]
        assert per_section[chorus[0]] == per_section[chorus[1]]


@pytest.mark.parametrize("source", ("aist", "mix"))
def test_transition_cap_is_respected(analysis: Analysis, source: str) -> None:
    cap = DEFAULT_CONFIG.trans_cap
    n = 0
    for difficulty in DIFFICULTIES:
        for mode in MODES:
            for seed in range(3):
                routine = generate_routine(analysis, LIB, difficulty, mode, seed, move_source=source)
                for a, b in searched_pairs(routine):
                    if a.source == "aist" or b.source == "aist":
                        n += 1
                        assert edge(a, b) <= cap + 1e-6, (a.id, b.id, round(edge(a, b), 3))
    assert n > 50


def test_over_cap_edges_only_when_nothing_else_fits(analysis: Analysis) -> None:
    """Clips only (no library fallback) and an impossible cap: every edge is over it, yet routines are made,
    and the search still prefers the shorter edges (vs. no cap at all, where only w_free_trans counts)."""
    clips_only = build_library([], FIXTURE_BYTES)
    tight = replace(DEFAULT_CONFIG, trans_cap=0.0)

    def edges(cfg) -> list[float]:
        out = []
        for seed in range(4):
            routine = generate_routine(analysis, clips_only, "hard", "standing", seed, cfg, move_source="aist")
            check_layout(routine)
            out += [edge(a, b) for a, b in searched_pairs(routine)]
        return out

    assert edges(tight)  # fell back instead of raising NoEligibleMoves
    capped = edges(DEFAULT_CONFIG)
    assert max(capped) <= DEFAULT_CONFIG.trans_cap + 1e-6


def test_seated_aist_falls_back_to_library_moves(analysis: Analysis) -> None:
    """Only a few upper-body clips: seated "aist" routines still fill every bar, with library moves as needed."""
    doc = fixture_doc()
    one_clip = build_library(classic_files(), json.dumps({**doc, "clips": [c for c in doc["clips"] if c["id"] == "aist_po_009"]}).encode())
    routine = generate_routine(analysis, one_clip, "normal", "seated", 0, move_source="aist")
    check_layout(routine)
    by_id = one_clip.by_id()
    sources = {by_id[m.id].source for m in routine.moves}
    assert sources == {"aist", "library"} and all(by_id[m.id].upperBodyOnly for m in routine.moves)


def test_without_clips_aist_and_mix_are_classic(analysis: Analysis) -> None:
    for source in ("aist", "mix"):
        routine = generate_routine(analysis, CLASSIC, "normal", "standing", 2, move_source=source)
        check_layout(routine)
        assert routine.meta["aistMoves"] == 0 and "credit" not in routine.meta


def test_bad_move_source(analysis: Analysis) -> None:
    with pytest.raises(ValueError, match="move_source"):
        generate_routine(analysis, LIB, "normal", "standing", 0, move_source="robots")
    legs_only = MoveLibrary(moves=tuple(m for m in LIB.moves if not m.upperBodyOnly), version="legs")
    with pytest.raises(NoEligibleMoves):
        generate_routine(analysis, legs_only, "normal", "seated", 0, move_source="aist")


@pytest.mark.parametrize("source", MOVE_SOURCES)
def test_four_minute_song_with_600_moves_under_300ms(source: str) -> None:
    letters = "ABCDEFGHIJKLMNO"  # 15 distinct 8-bar groups (480 beats), every bar searched
    analysis = make_analysis([("verse", g, 8, 0.3 + 0.04 * i) for i, g in enumerate(letters)], pickup=0, trailing=0)
    lib = clips_library(big_clip_bytes(30))  # 270 clips + mirrors + the classic moves
    assert len(lib.moves) >= 600
    for difficulty in DIFFICULTIES:
        best = math.inf
        for _ in range(3):
            start = time.perf_counter()
            routine = generate_routine(analysis, lib, difficulty, "standing", 0, move_source=source)
            best = min(best, time.perf_counter() - start)
        check_layout(routine)
        assert best < 0.3, f"{source} {difficulty}: {best * 1000:.0f} ms"


@pytest.mark.skipif(not REAL_CLIPS.exists(), reason="assets/moves/aist_clips.json not built")
@pytest.mark.parametrize("source", ("aist", "mix"))
def test_real_clips_make_valid_routines(analysis: Analysis, source: str) -> None:
    lib = clips_library(REAL_CLIPS.read_bytes())
    by_id = lib.by_id()
    for difficulty in DIFFICULTIES:
        for mode in MODES:
            routine = generate_routine(analysis, lib, difficulty, mode, 0, move_source=source)
            check_layout(routine)
            assert not list(ROUTINE_VALIDATOR.iter_errors(routine.to_json_dict()))
            # Seated mixes: the real file's 17 upper-body clips are all easy and mostly calm (intensity 1),
            # so normal / hard seated mixes may leave them out for library moves; aist still uses them.
            if source == "aist" or mode == "standing" or difficulty == "easy":
                assert routine.meta["aistMoves"] > 0, (difficulty, mode)
            if mode == "seated":
                assert all(by_id[m.id].upperBodyOnly for m in routine.moves)



# A chorus (C) replayed after a fresh bridge and verse, the last time cut short; with the default layout's
# shorter verse replay (B) these are the section-boundary edges a single search never sees.
REPLAYS = [("intro", "A", 2, 0.2), ("verse", "B", 4, 0.5), ("chorus", "C", 4, 0.9), ("bridge", "D", 4, 0.6),
           ("chorus", "C", 4, 0.9), ("verse", "E", 4, 0.5), ("chorus", "C", 3, 0.9), ("outro", "F", 2, 0.1)]  # fmt: skip


@pytest.mark.skipif(not REAL_CLIPS.exists(), reason="assets/moves/aist_clips.json not built")
@pytest.mark.parametrize("source", ("aist", "mix"))
def test_every_clip_edge_is_under_the_cap_with_real_clips(source: str) -> None:
    """Not just the searched pairs: also into and out of replayed groups, cut occurrences and the tail."""
    lib = clips_library(REAL_CLIPS.read_bytes())
    by_id = lib.by_id()
    n = 0
    for layout in (DEFAULT_LAYOUT, REPLAYS):
        analysis = make_analysis(layout)
        for difficulty in DIFFICULTIES:
            for mode in MODES:
                for seed in range(3):
                    routine = generate_routine(analysis, lib, difficulty, mode, seed, move_source=source)
                    moves = [by_id[m.id] for m in routine.moves]
                    for a, b in zip(moves, moves[1:]):
                        if a.source == "aist" or b.source == "aist":
                            n += 1
                            assert edge(a, b) <= DEFAULT_CONFIG.trans_cap + 1e-6, (difficulty, mode, seed, a.id, b.id)
    assert n > 300


def test_boundary_costs_leave_classic_routines_unchanged(analysis: Analysis, monkeypatch: pytest.MonkeyPatch) -> None:
    """exit / entry costs only apply with clips in the pool: classic output is exactly the v3 search."""
    replays = make_analysis(REPLAYS)
    cases = [(a, d, m, s) for a in (analysis, replays) for d in DIFFICULTIES for m in MODES for s in range(2)]
    before = [generate_routine(a, LIB, d, m, s).to_json_dict() for a, d, m, s in cases]
    clips_before = [generate_routine(a, LIB, d, m, s, move_source="mix").to_json_dict() for a, d, m, s in cases]
    monkeypatch.setattr(generator._Planner, "exit_cost", lambda self, *a, **k: None)
    monkeypatch.setattr(generator._Planner, "entry_cost", lambda self, *a, **k: None)
    assert [generate_routine(a, LIB, d, m, s).to_json_dict() for a, d, m, s in cases] == before
    after = [generate_routine(a, LIB, d, m, s, move_source="mix").to_json_dict() for a, d, m, s in cases]
    assert after != clips_before  # ...while they do change routines with clips
