"""Choreography generator (app.choreo) against a fixture move library and hand-built analyses."""

from __future__ import annotations

import json
import math
import time
from collections import defaultdict
from dataclasses import replace

import pytest
from choreo_fixtures import (
    CLAP,
    DEFAULT_LAYOUT,
    N,
    big_library,
    check_layout,
    fixture_library,
    make_analysis,
    move,
    pose,
    section_moves,
)
from helpers import SHARED_DIR
from jsonschema import Draft202012Validator

from app.analysis import Analysis
from app.choreo import GENERATOR, ChoreoConfig, NoEligibleMoves, generate_routine, routine_id
from app.choreo.generator import DEFAULT_CONFIG
from app.moves.types import MoveLibrary
from app.routine import Routine

ROUTINE_VALIDATOR = Draft202012Validator(json.loads((SHARED_DIR / "routine.schema.json").read_text()))
LIB = fixture_library()
BY_ID = LIB.by_id()
DIFFICULTIES = ("easy", "normal", "hard")
MODES = ("standing", "seated")


@pytest.fixture(scope="module")
def analysis() -> Analysis:
    return make_analysis()


def beat_weighted_intensity(routine: Routine, label: str) -> float:
    total = weight = 0.0
    for row, moves in zip(routine.meta["sectionPlan"], section_moves(routine)):
        if row["label"] == label:
            for _, move_id in moves:
                mv = BY_ID[move_id]
                total += mv.intensity * mv.lengthBeats
                weight += mv.lengthBeats
    return total / weight


def assert_paired_one_beat_moves(routine: Routine) -> int:
    """Outside hard, 1-beat moves only come as identical back-to-back pairs on beats 1-2 / 3-4 of a bar.
    Returns the number of pairs."""
    d0 = routine.song.beats.index(routine.song.downbeats[0]) if routine.song.downbeats else 0
    moves, pairs, i = routine.moves, 0, 0
    while i < len(moves):
        if moves[i].lengthBeats != 1:
            i += 1
            continue
        a = moves[i]
        assert i + 1 < len(moves), f"unpaired 1-beat {a.id} at the end"
        b = moves[i + 1]
        assert (b.id, b.lengthBeats, b.startBeat) == (a.id, 1, a.startBeat + 1), f"unpaired {a.id} at {a.startBeat}"
        assert (a.startBeat - d0) % 2 == 0, f"1-beat pair {a.id} starts on an odd beat"
        pairs += 1
        i += 2
    return pairs


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("difficulty", DIFFICULTIES)
@pytest.mark.parametrize("seed", [0, 7])
def test_layout_and_schema(analysis: Analysis, difficulty: str, mode: str, seed: int) -> None:
    routine = generate_routine(analysis, LIB, difficulty, mode, seed)
    check_layout(routine)
    doc = routine.to_json_dict()
    errors = [e.message for e in ROUTINE_VALIDATOR.iter_errors(doc)]
    assert not errors, errors[:3]
    assert Routine.model_validate(doc) == routine
    assert (doc["difficulty"], doc["mode"], doc["seed"]) == (difficulty, mode, seed)
    for mv in doc["moves"]:
        lib_move = BY_ID[mv["id"]]
        assert mv["lengthBeats"] == lib_move.lengthBeats and mv["intensity"] == lib_move.intensity
        assert mv["scoredJoints"] == list(lib_move.scoredJoints)
        assert len(mv["keyframes"]) == len(lib_move.keyframes)
        assert all(len(k["pose"]) == 17 and len(k["root"]) == 2 for k in mv["keyframes"])


def test_pickup_beats_get_no_moves(analysis: Analysis) -> None:
    routine = generate_routine(analysis, LIB, "hard", "standing", 0)
    first_downbeat = analysis.beats.index(analysis.downbeats[0])
    assert first_downbeat == 1
    assert routine.moves[0].startBeat == first_downbeat
    assert routine.moves[0].startTime == analysis.downbeats[0]


@pytest.mark.parametrize("difficulty", DIFFICULTIES)
@pytest.mark.parametrize("seed", range(6))
def test_repeated_groups_reuse_moves(analysis: Analysis, difficulty: str, seed: int) -> None:
    routine = generate_routine(analysis, LIB, difficulty, "standing", seed)
    per_section = section_moves(routine)
    by_group: dict[str, list[int]] = defaultdict(list)
    for i, row in enumerate(routine.meta["sectionPlan"]):
        by_group[row["group"]].append(i)
    chorus = by_group["C"]
    assert len(chorus) == 2 and per_section[chorus[0]] == per_section[chorus[1]]  # choruses match exactly
    long_verse, short_verse = per_section[by_group["B"][0]], per_section[by_group["B"][1]]
    kept = [(o, m) for o, m in long_verse if o + BY_ID[m].lengthBeats <= 4 * 6]
    assert short_verse[: len(kept)] == kept  # the 6-bar verse plays the 8-bar verse's prefix
    assert len(short_verse) - len(kept) <= 2  # ...plus at most a patch for a cut 8-beat move


def test_cut_8_beat_move_is_patched() -> None:
    """A 3-bar group replayed for 2 bars: when the plan is [4-beat, 8-beat] the 8-beat move is cut and patched."""
    layout = [("verse", "A", 3, 0.4), ("chorus", "B", 2, 0.9), ("verse", "A", 2, 0.4), ("outro", "C", 1, 0.1)]
    analysis = make_analysis(layout, pickup=0, trailing=0)
    config = ChoreoConfig(length_cost_easy=(math.inf, math.inf, 1.0, 0.0))  # 3 bars -> one 8 + one 4
    patched = 0
    for seed in range(20):
        routine = generate_routine(analysis, LIB, "easy", "standing", seed, config)
        check_layout(routine)
        first, second = section_moves(routine)[0], section_moves(routine)[2]
        kept = [(o, m) for o, m in first if o + BY_ID[m].lengthBeats <= 8]
        assert second[: len(kept)] == kept
        if len(kept) < len(first) and first[1][0] == 4:  # plan was [4, 8]: the 8-beat move got cut
            patched += 1
            assert sum(BY_ID[m].lengthBeats for _, m in second) == 8
    assert patched > 0


@pytest.mark.parametrize("difficulty", DIFFICULTIES)
def test_seated_uses_upper_body_moves_only(analysis: Analysis, difficulty: str) -> None:
    routine = generate_routine(analysis, LIB, difficulty, "seated", 3)
    assert routine.moves
    assert all(BY_ID[mv.id].upperBodyOnly for mv in routine.moves)


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("seed", range(4))
def test_difficulty_pools(analysis: Analysis, mode: str, seed: int) -> None:
    for difficulty in ("easy", "normal"):
        routine = generate_routine(analysis, LIB, difficulty, mode, seed)
        assert all(BY_ID[mv.id].difficulty != "hard" for mv in routine.moves)
        assert_paired_one_beat_moves(routine)  # 1-beat moves only as identical pairs outside hard
    easy = generate_routine(analysis, LIB, "easy", mode, seed)
    assert all(BY_ID[mv.id].difficulty == "easy" for mv in easy.moves)  # enough easy moves: no fallback
    hard = generate_routine(analysis, LIB, "hard", mode, seed)
    assert any(BY_ID[mv.id].difficulty == "hard" for mv in hard.moves)


def test_one_beat_moves_pair_up_outside_hard(analysis: Analysis) -> None:
    """easy/normal: a 1-beat move fills a 2-beat slot as an identical pair (clap x2); hard places singles."""
    loop = move("clap_loop", "Clap Loop", 1, 3, "easy", True, [(0, N), (0.5, pose(CLAP)), (1, N)])
    lib = MoveLibrary(moves=LIB.moves + tuple(loop), version="fixture-pairs")
    cheap = ChoreoConfig(length_cost_easy=(0.0, 0.6, 0.0, 0.0), length_cost_normal=(0.0, 0.25, 0.0, 0.05))
    pairs = {"easy": 0, "normal": 0}
    for difficulty in pairs:
        for mode in MODES:
            for seed in range(4):
                routine = generate_routine(analysis, lib, difficulty, mode, seed, cheap)
                check_layout(routine)
                pairs[difficulty] += assert_paired_one_beat_moves(routine)
    assert pairs["easy"] > 0 and pairs["normal"] > 0, pairs
    hard = [generate_routine(analysis, lib, "hard", "standing", seed) for seed in range(4)]
    assert any(mv.lengthBeats == 1 for r in hard for mv in r.moves)


def test_novelty_bonus_widens_variety(analysis: Analysis) -> None:
    def distinct(cfg: ChoreoConfig) -> int:
        return sum(
            len({BY_ID[mv.id].baseId for mv in generate_routine(analysis, LIB, d, "standing", s, cfg).moves})
            for d in DIFFICULTIES
            for s in range(4)
        )

    assert DEFAULT_CONFIG.w_novel > 0
    assert distinct(DEFAULT_CONFIG) > distinct(replace(DEFAULT_CONFIG, w_novel=0.0))


def test_easy_falls_back_to_normal_moves_when_pool_is_small(analysis: Analysis) -> None:
    lib = fixture_library(without=("arm_wave", "clap_up", "heart_hands", "sway", "clap_party"))  # 4 easy bases left
    routine = generate_routine(analysis, lib, "easy", "standing", 0)
    check_layout(routine)
    difficulties = {lib.by_id()[mv.id].difficulty for mv in routine.moves}
    assert "normal" in difficulties and "hard" not in difficulties


def test_same_seed_identical_different_seed_differs(analysis: Analysis) -> None:
    a = generate_routine(analysis, LIB, "normal", "standing", 0).to_json_dict()
    b = generate_routine(analysis, LIB, "normal", "standing", 0).to_json_dict()
    assert a == b
    ids = lambda seed: [m.id for m in generate_routine(analysis, LIB, "normal", "standing", seed).moves]  # noqa: E731
    assert ids(0) != ids(1)
    assert len({tuple(ids(s)) for s in range(5)}) >= 4
    assert ids(-3) == ids(-3)  # negative seeds are fine


@pytest.mark.parametrize("difficulty", DIFFICULTIES)
@pytest.mark.parametrize("seed", range(3))
def test_chorus_more_intense_than_verse(analysis: Analysis, difficulty: str, seed: int) -> None:
    routine = generate_routine(analysis, LIB, difficulty, "standing", seed)
    assert beat_weighted_intensity(routine, "chorus") > beat_weighted_intensity(routine, "verse")
    targets = {row["label"]: row["targetIntensity"] for row in routine.meta["sectionPlan"]}
    assert targets["chorus"] > targets["verse"] > targets["intro"] > targets["outro"]


@pytest.mark.parametrize("mode", MODES)
def test_ends_on_storybook_finisher(analysis: Analysis, mode: str) -> None:
    for seed in range(3):
        routine = generate_routine(analysis, LIB, "normal", mode, seed)
        last = BY_ID[routine.moves[-1].id]
        assert "finale" in last.styles and last.endAnchor == "neutral"
        check_layout(routine)  # the finisher holds through the 3 trailing beats


def test_trailing_beats_filled_with_short_moves(analysis: Analysis) -> None:
    lib = fixture_library(without=("curtsy", "royal_bow"))
    by_id = lib.by_id()
    n = len(analysis.beats)
    hard = generate_routine(analysis, lib, "hard", "standing", 0)  # 1-beat moves fill all 3 trailing beats
    check_layout(hard, check_trailing_full=True)
    normal = generate_routine(analysis, lib, "normal", "standing", 0)  # 2 of 3 beats; the last stays empty
    check_layout(normal)
    tail = [mv for mv in normal.moves if mv.startBeat >= n - 3]
    assert [mv.startBeat for mv in tail] == [n - 3] and by_id[tail[0].id].lengthBeats == 2
    assert normal.meta["sectionPlan"][-1]["lastMove"] == len(normal.moves) - 1
    last = hard.moves[-1]
    assert last.startBeat + last.lengthBeats == n and last.endTime > analysis.beats[-1]  # extrapolated


def test_meta(analysis: Analysis) -> None:
    routine = generate_routine(analysis, LIB, "hard", "seated", 42)
    meta = routine.meta
    assert meta["routineId"] == routine_id(analysis.id, analysis.analysisVersion, LIB.version, "hard", "seated", 42)
    assert len(meta["routineId"]) == 16 and int(meta["routineId"], 16) >= 0
    assert meta["generator"] == GENERATOR
    assert (meta["libraryVersion"], meta["analysisId"], meta["analysisVersion"]) == (
        LIB.version,
        analysis.id,
        analysis.analysisVersion,
    )
    plan = meta["sectionPlan"]
    assert [(r["label"], r["group"], r["bars"]) for r in plan] == [(lab, g, b) for lab, g, b, _ in DEFAULT_LAYOUT]
    covered = [i for r in plan for i in range(r["firstMove"], r["lastMove"] + 1)]
    assert covered == list(range(len(routine.moves)))
    assert routine.song.id == analysis.id and len(routine.song.sections) == len(analysis.sections)
    assert routine_id(analysis.id, 2, "v", "easy", "standing", 1) != routine_id(analysis.id, 2, "v", "easy", "standing", 2)


def test_no_eligible_moves(analysis: Analysis) -> None:
    legs_only = fixture_library(without=[m.baseId for m in LIB.moves if m.upperBodyOnly])
    with pytest.raises(NoEligibleMoves):
        generate_routine(analysis, legs_only, "normal", "seated", 0)
    with pytest.raises(ValueError):
        generate_routine(analysis, LIB, "extreme", "standing", 0)


def test_beatless_analysis_gives_empty_routine() -> None:
    doc = make_analysis().model_dump()
    doc.update(beats=[], downbeats=[], beatEnergy=[], bpm=0.0)
    doc["sections"] = [{**doc["sections"][0], "startBeat": 0, "endBeat": 0, "bars": 0}]
    routine = generate_routine(Analysis.model_validate(doc), LIB, "normal", "standing", 0)
    assert routine.moves == [] and routine.meta["sectionPlan"][0]["firstMove"] is None


@pytest.mark.parametrize("difficulty", DIFFICULTIES)
def test_four_minute_song_under_300ms(difficulty: str) -> None:
    letters = "ABCDEFGHIJKLMNO"  # worst case: 15 distinct 8-bar groups (480 beats at 120 BPM), ~100 moves
    analysis = make_analysis([("verse", g, 8, 0.3 + 0.04 * i) for i, g in enumerate(letters)], pickup=0, trailing=0)
    lib = big_library(4)
    best = math.inf
    for _ in range(3):
        start = time.perf_counter()
        routine = generate_routine(analysis, lib, difficulty, "standing", 0)
        best = min(best, time.perf_counter() - start)
    check_layout(routine)
    assert best < 0.3, f"{best * 1000:.0f} ms"


@pytest.fixture(scope="module")
def analyzed_song() -> Analysis:
    """Real analyzer output for a synthetic song (intro, verse, chorus, verse, chorus, outro)."""
    from app.audio.analysis import ANALYSIS_VERSION, analyze_audio
    from scripts.make_sample_song import render_song

    layout = [("intro", 2), ("verse", 4), ("chorus", 4), ("verse", 4), ("chorus", 4), ("outro", 2)]
    y, sr, _ = render_song(120.0, seed=1, layout=layout)
    fields = analyze_audio(y, sr)
    return Analysis.model_validate(
        {
            "id": "cd" * 32,
            "analysisVersion": ANALYSIS_VERSION,
            "title": "Synth",
            "source": {"kind": "upload", "file": "synth.wav"},
            "audioUrl": "/api/audio/" + "cd" * 32,
            **fields,
            "elapsedMs": 0.0,
            "cached": False,
        }
    )


@pytest.mark.parametrize("difficulty", DIFFICULTIES)
def test_real_analysis(analyzed_song: Analysis, difficulty: str) -> None:
    labels = [s.label for s in analyzed_song.sections]
    assert "verse" in labels and "chorus" in labels, labels
    routine = generate_routine(analyzed_song, LIB, difficulty, "standing", 0)
    check_layout(routine)
    assert not list(ROUTINE_VALIDATOR.iter_errors(routine.to_json_dict()))
    assert beat_weighted_intensity(routine, "chorus") > beat_weighted_intensity(routine, "verse")
    per_section = section_moves(routine)
    for group in {s.group for s in analyzed_song.sections}:
        occ = [per_section[i] for i, s in enumerate(analyzed_song.sections) if s.group == group and s.bars]
        assert all(o == occ[0] for o in occ if len(o) == len(occ[0]))


# --- regressions found in the Stage 2 integration review ------------------------------------------


@pytest.mark.parametrize("mode", MODES)
def test_real_library_ends_on_finale_and_keeps_storybook_moves(analysis: Analysis, mode: str) -> None:
    """Only "finale" moves (curtsy / royal wave) are finishers: v1 treated every storybook move as one, so the
    theme moves were penalized mid-routine and routines ended on e.g. Mirror, Mirror instead of a curtsy."""
    from app.choreo.generator import _prepared
    from app.moves.library import load_library

    lib = load_library()
    by_id = lib.by_id()
    prep = _prepared(lib)
    finishers = {m.baseId for m, f in zip(prep.moves, prep.finisher) if f}
    assert finishers and all("finale" in m.styles for m, f in zip(prep.moves, prep.finisher) if f)
    assert "magic_mirror" not in finishers and "midnight_clock" not in finishers
    storybook = 0
    for seed in range(3):
        routine = generate_routine(analysis, lib, "normal", mode, seed)
        assert "finale" in by_id[routine.moves[-1].id].styles
        storybook += sum("storybook" in by_id[mv.id].styles for mv in routine.moves[:-1])
    assert storybook > 0


def test_real_library_uses_the_formerly_unused_moves(analysis: Analysis) -> None:
    """v2 never picked jumping_jack, star_jump, shrug, ta_da (or clap_clap / hiphop_bounce): 4-beat
    reworks, 1-beat pairs and the novelty bonus bring them in where they fit."""
    from app.moves.library import load_library

    lib = load_library()
    by_id = lib.by_id()
    used: set[str] = set()
    for difficulty in DIFFICULTIES:
        for mode in MODES:
            for seed in range(3):
                routine = generate_routine(analysis, lib, difficulty, mode, seed)
                check_layout(routine)
                if difficulty != "hard":
                    assert_paired_one_beat_moves(routine)
                used |= {by_id[mv.id].baseId for mv in routine.moves}
    assert {"jumping_jack", "star_jump", "shrug", "ta_da"} <= used
    assert len(used) >= 0.85 * len({m.baseId for m in lib.moves})
