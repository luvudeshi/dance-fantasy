"""Beat tracking on synthetic songs with known tempo, plus decoding edge cases."""

from __future__ import annotations

import io

import numpy as np
import pytest
import soundfile as sf
from helpers import SHORT_LAYOUT, wav_bytes

from app.audio import AudioDecodeError, load_audio, track_beats
from app.audio.beats import bpm_from_beats
from scripts.make_sample_song import render_song

SR = 22050


@pytest.fixture(scope="module", params=[(120.0, 1), (96.0, 2)], ids=["120bpm", "96bpm"])
def tracked(request: pytest.FixtureRequest) -> tuple[float, dict, dict]:
    bpm, seed = request.param
    y, sr, info = render_song(bpm, seed=seed, layout=SHORT_LAYOUT, sr=SR)
    return bpm, info, track_beats(y, sr)


def _grid_error(beats: np.ndarray, bpm: float) -> np.ndarray:
    period = 60.0 / bpm
    return np.abs(beats - np.round(beats / period) * period)


def test_result_shape(tracked: tuple[float, dict, dict]) -> None:
    _, info, result = tracked
    assert set(result) == {"durationSec", "sampleRate", "tempo", "bpmFromBeats", "beats"}
    assert result["sampleRate"] == SR
    assert result["durationSec"] == pytest.approx(info["durationSec"], abs=1e-3)
    assert result["beats"] == sorted(result["beats"])


def test_bpm_from_beats_within_2_percent(tracked: tuple[float, dict, dict]) -> None:
    bpm, _, result = tracked
    assert result["bpmFromBeats"] == pytest.approx(bpm, rel=0.02)


def test_tempo_estimate_within_2_percent(tracked: tuple[float, dict, dict]) -> None:
    bpm, _, result = tracked
    assert result["tempo"] == pytest.approx(bpm, rel=0.02), "half/double tempo?"


def test_beats_land_on_the_true_grid(tracked: tuple[float, dict, dict]) -> None:
    bpm, _, result = tracked
    assert np.median(_grid_error(np.array(result["beats"]), bpm)) < 0.040


def test_beats_cover_every_section(tracked: tuple[float, dict, dict]) -> None:
    """Guards against librosa 0.11's trim dropping the whole last section."""
    bpm, info, result = tracked
    beats = np.array(result["beats"])
    for section in info["sections"]:
        expected = section["bars"] * 4
        inside = np.sum((beats >= section["startSec"] - 0.05) & (beats < section["endSec"] - 0.05))
        assert inside >= 0.75 * expected, f"{section['label']}: {inside}/{expected} beats"


def test_bpm_from_beats_helper() -> None:
    assert bpm_from_beats([]) == 0.0
    assert bpm_from_beats([1.0]) == 0.0
    assert bpm_from_beats([0.0, 0.5, 1.0, 1.5, 2.6]) == pytest.approx(120.0)


@pytest.mark.parametrize(
    ("label", "y"),
    [
        ("silence", np.zeros(3 * SR, dtype=np.float32)),
        ("half_second", np.random.default_rng(0).uniform(-0.5, 0.5, SR // 2).astype(np.float32)),
        ("empty", np.zeros(0, dtype=np.float32)),
    ],
)
def test_silent_or_short_audio_has_no_beats(label: str, y: np.ndarray) -> None:
    result = track_beats(y, SR)
    assert result["beats"] == []
    assert result["tempo"] == 0.0
    assert result["bpmFromBeats"] == 0.0
    assert result["durationSec"] == pytest.approx(len(y) / SR)


def test_load_audio_wav_bytes_downmixes_and_resamples() -> None:
    y, sr, _ = render_song(120.0, seed=1, layout=[("verse", 1)], sr=44100)
    stereo = np.stack([y, 0.5 * y], axis=1)
    out, out_sr = load_audio(wav_bytes(stereo, sr), sr=SR, filename_hint="song.wav")
    assert out_sr == SR
    assert out.dtype == np.float32 and out.ndim == 1
    assert len(out) == pytest.approx(len(y) / 2, abs=2)
    assert np.max(np.abs(out)) == pytest.approx(0.75 * np.max(np.abs(y)), rel=0.05)


def test_load_audio_path(tmp_path) -> None:
    y, sr, _ = render_song(96.0, seed=2, layout=[("verse", 1)], sr=SR)
    path = tmp_path / "song.wav"
    path.write_bytes(wav_bytes(y, sr))
    out, out_sr = load_audio(path)
    assert out_sr == SR
    np.testing.assert_allclose(out, y, atol=1e-3)


@pytest.mark.parametrize(
    ("fmt", "subtype", "ext"), [("FLAC", "PCM_16", "flac"), ("OGG", "VORBIS", "ogg"), ("MP3", "MPEG_LAYER_III", "mp3")]
)
def test_load_audio_compressed_bytes(fmt: str, subtype: str, ext: str) -> None:
    y, sr, _ = render_song(120.0, seed=1, layout=[("verse", 1)], sr=44100)
    buf = io.BytesIO()
    try:
        sf.write(buf, y, sr, format=fmt, subtype=subtype)
    except (sf.LibsndfileError, ValueError, TypeError) as exc:
        pytest.skip(f"this libsndfile cannot encode {ext}: {exc}")
    out, out_sr = load_audio(buf.getvalue(), filename_hint=f"song.{ext}")
    assert out_sr == SR
    assert len(out) == pytest.approx(len(y) / 2, abs=0.05 * SR)
    assert 0.5 < np.max(np.abs(out)) < 1.2


@pytest.mark.parametrize("hint", ["junk.wav", "junk.mp3", "junk.m4a", None])
def test_load_audio_garbage_raises(hint: str | None) -> None:
    garbage = np.random.default_rng(1).integers(0, 256, 4096, dtype=np.uint8).tobytes()
    with pytest.raises(AudioDecodeError, match="Supported formats"):
        load_audio(b"definitely not audio " + garbage, filename_hint=hint)


def test_load_audio_empty_bytes_raises() -> None:
    with pytest.raises(AudioDecodeError):
        load_audio(b"")


def test_load_audio_missing_path_raises(tmp_path) -> None:
    with pytest.raises(FileNotFoundError):
        load_audio(tmp_path / "nope.wav")
