"""Song analysis (beat grid, downbeats, sections) on synthetic songs with known structure."""

from __future__ import annotations

import json

import numpy as np
import pytest

from app.audio.analysis import analyze_audio
from app.audio.grid import beat_grid, grid_period
from app.audio.structure import label_sections
from scripts.make_sample_song import render_song

SR = 22050
BRIDGE_LAYOUT = [("intro", 2), ("verse", 8), ("chorus", 8), ("bridge", 4), ("chorus", 8), ("outro", 4)]
CASES = {  # id: (bpm, seed, layout); None = the default intro/verse/chorus/verse/chorus/outro
    "120bpm": (120.0, 1, None),
    "96bpm": (96.0, 2, None),
    "128bpm-bridge": (128.0, 3, BRIDGE_LAYOUT),
}


@pytest.fixture(scope="module", params=list(CASES))
def analyzed(request: pytest.FixtureRequest) -> tuple[dict, dict]:
    bpm, seed, layout = CASES[request.param]
    y, sr, info = render_song(bpm, seed=seed, layout=layout, sr=SR)
    return info, analyze_audio(y, sr)


def check_invariants(r: dict) -> None:
    """What every analysis must satisfy, whatever the audio."""
    json.dumps(r, allow_nan=False)  # no NaN / inf anywhere
    beats, n = r["beats"], len(r["beats"])
    assert all(b > a for a, b in zip(beats, beats[1:])), "beats must be strictly ascending"
    assert all(0 <= b <= r["durationSec"] for b in beats)
    assert r["filledBeats"] == sorted(set(r["filledBeats"])) and all(0 <= i < n for i in r["filledBeats"])
    assert 0 <= r["downbeatPhase"] <= 3 and r["beatsPerBar"] == 4
    assert r["downbeats"] == beats[r["downbeatPhase"] :: 4]
    assert len(r["beatEnergy"]) == n and all(0 <= e <= 1 for e in r["beatEnergy"])
    env = r["onsetEnvelope"]
    assert 0.04 <= env["hopSec"] <= 0.06
    assert all(0 <= v <= 1 for v in env["values"])
    assert len(env["values"]) == pytest.approx(r["durationSec"] / env["hopSec"], abs=2)

    sections = r["sections"]
    assert sections and sections[0]["start"] == 0.0 and sections[-1]["end"] == r["durationSec"]
    assert sections[0]["startBeat"] == 0 and sections[-1]["endBeat"] == n
    downbeat_idx = set(range(r["downbeatPhase"], n, 4))
    for i, s in enumerate(sections):
        assert s["label"] in {"intro", "verse", "chorus", "bridge", "outro"}
        assert len(s["group"]) == 1 and s["group"].isupper() and 0 <= s["energy"] <= 1
        assert s["end"] > s["start"] or r["durationSec"] == 0
        if i:
            prev = sections[i - 1]
            assert s["start"] == prev["end"] and s["startBeat"] == prev["endBeat"]
            assert s["start"] == beats[s["startBeat"]] and s["startBeat"] in downbeat_idx
        assert all(s["start"] <= b < s["end"] for b in beats[s["startBeat"] : s["endBeat"]])
        assert s["bars"] == sum(1 for k in range(s["startBeat"], s["endBeat"]) if k in downbeat_idx)
    letters = [s["group"] for s in sections]
    first_seen = sorted(set(letters), key=letters.index)
    assert first_seen == [chr(ord("A") + k) for k in range(len(first_seen))], "groups lettered in order"


def test_invariants(analyzed: tuple[dict, dict]) -> None:
    check_invariants(analyzed[1])


def test_bpm_within_1_percent(analyzed: tuple[dict, dict]) -> None:
    info, r = analyzed
    assert r["bpm"] == pytest.approx(info["bpm"], rel=0.01)


def test_beats_cover_the_song_on_the_true_grid(analyzed: tuple[dict, dict]) -> None:
    info, r = analyzed
    period = 60.0 / info["bpm"]
    beats = np.array(r["beats"])
    assert beats[0] < period + 0.05
    assert beats[-1] > info["durationSec"] - period - 0.05
    grid_error = np.abs(beats - np.round(beats / period) * period)
    assert np.mean(grid_error < 0.06) >= 0.95


def test_downbeats_hit_true_bar_starts(analyzed: tuple[dict, dict]) -> None:
    info, r = analyzed
    bar = 4 * 60.0 / info["bpm"]
    true_bars = np.arange(0.0, info["durationSec"] - 1e-6, bar)
    downbeats = np.array(r["downbeats"])
    hits = [np.min(np.abs(downbeats - t)) <= 0.06 for t in true_bars]
    assert np.mean(hits) >= 0.9


def test_section_boundaries_match_truth(analyzed: tuple[dict, dict]) -> None:
    info, r = analyzed
    bar = 4 * 60.0 / info["bpm"]
    truth = np.array([s["startSec"] for s in info["sections"][1:]])
    predicted = np.array([s["start"] for s in r["sections"][1:]])
    for t in truth:
        assert np.min(np.abs(predicted - t)) <= bar + 0.06, f"no boundary near {t:.2f}s; got {predicted.round(2)}"
    extra = [p for p in predicted if np.min(np.abs(truth - p)) > bar + 0.06]
    assert len(extra) <= 1, f"extra boundaries {extra}"


def _matching_section(r: dict, true_section: dict) -> dict:
    """The predicted section overlapping a true section the most."""

    def overlap(s: dict) -> float:
        return min(s["end"], true_section["endSec"]) - max(s["start"], true_section["startSec"])

    return max(r["sections"], key=overlap)


def test_labels_and_groups(analyzed: tuple[dict, dict]) -> None:
    info, r = analyzed
    choruses = [_matching_section(r, s) for s in info["sections"] if s["label"] == "chorus"]
    verses = [_matching_section(r, s) for s in info["sections"] if s["label"] == "verse"]
    assert all(c["label"] == "chorus" for c in choruses)
    assert len({c["group"] for c in choruses}) == 1
    assert all(v["label"] == "verse" for v in verses)
    assert len({v["group"] for v in verses}) == 1 and verses[0]["group"] != choruses[0]["group"]
    assert r["sections"][0]["label"] == "intro"
    assert r["sections"][-1]["label"] == "outro"
    for s in info["sections"]:
        if s["label"] == "bridge":
            match = _matching_section(r, s)
            assert match["label"] == "bridge" and match["group"] not in {choruses[0]["group"], verses[0]["group"]}


def test_chorus_is_louder_than_verse_and_outro(analyzed: tuple[dict, dict]) -> None:
    _, r = analyzed
    energy = {}
    for s in r["sections"]:
        energy.setdefault(s["label"], []).append(s["energy"])
    assert min(energy["chorus"]) > max(energy["verse"]) > max(energy["outro"])


def test_deterministic() -> None:
    y, sr, _ = render_song(120.0, seed=4, layout=[("verse", 4), ("chorus", 4)], sr=SR)
    assert analyze_audio(y, sr) == analyze_audio(y.copy(), sr)


@pytest.mark.parametrize(
    ("label", "y"),
    [
        ("empty", np.zeros(0, dtype=np.float32)),
        ("silence", np.zeros(3 * SR, dtype=np.float32)),
        ("short", (0.5 * np.sin(2 * np.pi * 440 * np.arange(SR // 2) / SR)).astype(np.float32)),
        ("nan", np.full(2 * SR, np.nan, dtype=np.float32)),
    ],
)
def test_degenerate_input_gives_one_empty_section(label: str, y: np.ndarray) -> None:
    r = analyze_audio(y, SR)
    check_invariants(r)
    assert r["beats"] == [] and r["downbeats"] == [] and r["filledBeats"] == [] and r["bpm"] == 0.0
    assert r["durationSec"] == pytest.approx(len(y) / SR, abs=1e-4)
    assert r["sections"] == [
        {
            "start": 0.0,
            "end": r["durationSec"],
            "label": "verse",
            "energy": 0.0,
            "group": "A",
            "startBeat": 0,
            "endBeat": 0,
            "bars": 0,
        }
    ]


@pytest.mark.parametrize(
    ("label", "y"),
    [
        ("steady tone", (0.5 * np.sin(2 * np.pi * 220 * np.arange(4 * SR) / SR)).astype(np.float32)),
        ("noise", np.random.default_rng(0).uniform(-0.5, 0.5, 4 * SR).astype(np.float32)),
        ("two clicks", np.pad(np.ones(64, np.float32), (SR, 2 * SR))),
        ("loud", 1e6 * render_song(120.0, seed=5, layout=[("verse", 1)], sr=SR)[0]),
    ],
)
def test_odd_input_is_still_valid(label: str, y: np.ndarray) -> None:
    check_invariants(analyze_audio(y, SR))


def test_beat_grid_fills_gaps_and_extends_to_the_edges() -> None:
    detected = np.array([1.0, 1.5, 2.0, 3.5, 4.0, 4.5, 5.0])  # two beats missing around 2.5-3.0
    beats, filled = beat_grid(detected, duration=6.0, onset_env=np.ones(1000), sr=SR, hop=256)
    assert beats.tolist() == pytest.approx([0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5])
    assert np.flatnonzero(filled).tolist() == [0, 1, 5, 6, 11]


def test_beat_grid_octave_guard() -> None:
    slow = np.arange(0.0, 20.0, 1.0)  # 60 BPM -> doubled to 120
    beats, filled = beat_grid(slow, duration=20.0, onset_env=np.ones(5000), sr=SR, hop=256)
    assert 60.0 / grid_period(beats) == pytest.approx(120.0)
    assert filled[1::2].all() and not filled[0:-1:2].any()

    fast = np.arange(0.0, 20.0, 0.25)  # 240 BPM -> halved to 120, keeping the stronger phase
    env = np.zeros(int(20.0 * SR / 256) + 10)
    env[np.round(fast[1::2] * SR / 256).astype(int)] = 1.0  # odd beats are the accented ones
    beats, _ = beat_grid(fast, duration=20.0, onset_env=env, sr=SR, hop=256)
    assert 60.0 / grid_period(beats) == pytest.approx(120.0)
    assert 0.25 in beats.tolist() and 0.5 not in beats.tolist()


def test_labels_without_repeats_or_with_intro_music_as_outro() -> None:
    # Nothing repeats: the loudest section of >= 4 bars is the chorus.
    assert label_sections([0, 1, 2, 3], [0.2, 0.6, 0.9, 0.5], [4, 8, 8, 8]) == ["intro", "verse", "chorus", "outro"]
    # Intro music coming back at the end is still intro/outro, not a verse.
    assert label_sections([0, 1, 2, 1, 2, 0], [0.2, 0.6, 0.9, 0.6, 0.9, 0.2], [4, 8, 8, 8, 8, 4]) == [
        "intro",
        "verse",
        "chorus",
        "verse",
        "chorus",
        "outro",
    ]
    assert label_sections([0], [0.5], [2]) == ["verse"]


def test_back_to_back_sections_of_one_group_are_labeled_as_one_run() -> None:
    # Regression: an outro split in two (D, D) used to count as a repeated group -> "verse".
    groups, energies, bars = [0, 1, 2, 1, 2, 3, 3], [0.3, 0.7, 0.9, 0.7, 0.9, 0.3, 0.05], [4, 8, 8, 8, 8, 4, 4]
    assert label_sections(groups, energies, bars) == ["intro", "verse", "chorus", "verse", "chorus", "outro", "outro"]
    # Same at the start, and a chorus heard only as one double-length run is still the chorus.
    assert label_sections([0, 0, 1, 2, 2, 3], [0.2, 0.3, 0.6, 0.9, 0.9, 0.2], [4, 4, 8, 8, 8, 4]) == [
        "intro",
        "intro",
        "verse",
        "chorus",
        "chorus",
        "outro",
    ]


def test_eight_bar_fading_outro_is_labeled_outro() -> None:
    """Regression (new layout, not used to tune): a fading 8-bar outro must not become verses."""
    layout = [("intro", 4), ("verse", 8), ("chorus", 8), ("verse", 8), ("chorus", 8), ("outro", 8)]
    y, sr, info = render_song(100.0, seed=11, layout=layout, sr=SR)
    r = analyze_audio(y, sr)
    check_invariants(r)
    outro_start = info["sections"][-1]["startSec"]
    tail = [s for s in r["sections"] if s["start"] >= outro_start - 0.1]
    assert tail and all(s["label"] == "outro" for s in tail), [(s["label"], s["start"]) for s in r["sections"]]
    assert [s["label"] for s in r["sections"]].count("verse") == 2
