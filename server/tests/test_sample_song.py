"""The synthetic test-song generator: deterministic, clean, and its sidecar is ground truth."""

from __future__ import annotations

import json

import numpy as np
import pytest
import soundfile as sf

from scripts.make_sample_song import main, render_song

SR = 22050
LAYOUT = [("intro", 1), ("verse", 2), ("chorus", 2), ("outro", 1)]


@pytest.fixture(scope="module")
def song() -> tuple[np.ndarray, int, dict]:
    return render_song(120.0, seed=1, layout=LAYOUT, sr=SR)


def _rms_db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-12))


def test_deterministic(song: tuple[np.ndarray, int, dict]) -> None:
    y, _, info = song
    y2, _, info2 = render_song(120.0, seed=1, layout=LAYOUT, sr=SR)
    np.testing.assert_array_equal(y, y2)
    assert info == info2
    y3, _, _ = render_song(120.0, seed=2, layout=LAYOUT, sr=SR)
    assert not np.array_equal(y, y3)


def test_levels_are_clean(song: tuple[np.ndarray, int, dict]) -> None:
    y, _, _ = song
    assert y.dtype == np.float32 and y.ndim == 1
    assert 20 * np.log10(np.max(np.abs(y))) == pytest.approx(-1.0, abs=0.01)
    assert abs(float(np.mean(y))) < 1e-4  # no DC offset


def test_sections_are_ground_truth(song: tuple[np.ndarray, int, dict]) -> None:
    y, sr, info = song
    assert info["bpm"] == 120.0 and info["firstBeatSec"] == 0.0 and info["beatsPerBar"] == 4
    bar = 4 * 60.0 / 120.0
    start_bar = 0
    for section, (label, bars) in zip(info["sections"], LAYOUT, strict=True):
        assert section == {
            "label": label,
            "startBar": start_bar,
            "bars": bars,
            "startSec": pytest.approx(start_bar * bar),
            "endSec": pytest.approx((start_bar + bars) * bar),
        }
        start_bar += bars
    assert info["durationSec"] == pytest.approx(start_bar * bar)
    assert len(y) == round(info["durationSec"] * sr)


def test_first_kick_at_zero(song: tuple[np.ndarray, int, dict]) -> None:
    y, sr, _ = song
    assert np.max(np.abs(y[: int(0.01 * sr)])) > 0.3  # loud from the very first samples


def test_chorus_is_louder_than_verse(song: tuple[np.ndarray, int, dict]) -> None:
    y, sr, info = song
    rms = {s["label"]: _rms_db(y[int(s["startSec"] * sr) : int(s["endSec"] * sr)]) for s in info["sections"]}
    assert rms["chorus"] > rms["verse"] + 2.0
    assert rms["verse"] > rms["intro"] > rms["outro"]


def test_unknown_section_label_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown section"):
        render_song(120.0, layout=[("solo", 4)])


def test_cli_writes_wav_and_sidecar(tmp_path) -> None:
    out = tmp_path / "cli_song.wav"
    main(["--bpm", "100", "--seed", "3", "--out", str(out), "--sr", str(SR), "--title", "CLI Song"])
    info = sf.info(out)
    assert (info.samplerate, info.channels, info.subtype) == (SR, 1, "PCM_16")
    sidecar = json.loads(out.with_suffix(".json").read_text())
    assert sidecar["title"] == "CLI Song"
    assert sidecar["artist"] == "Midnight Ball test synth"
    assert sidecar["license"] == "CC0 (generated)"
    assert sidecar["source"] == "server/scripts/make_sample_song.py"
    assert sidecar["bpm"] == 100.0 and sidecar["firstBeatSec"] == 0.0
    assert [s["label"] for s in sidecar["sections"]] == ["intro", "verse", "chorus", "verse", "chorus", "outro"]
    assert info.duration == pytest.approx(sidecar["durationSec"], abs=1e-3)
