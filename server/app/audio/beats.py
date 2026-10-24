"""Beat tracking (librosa), with memory bounded independently of the song's length.

librosa's one-call ``beat_track(y=...)`` holds a full STFT and a full autocorrelation
tempogram in memory (about 700 MB for a 4-minute song at our hop length). We compute the
same onset envelope and mean tempogram in chunks (bit-identical results, tests check this)
and hand them to librosa's tempo estimator and beat tracker.

Everything here is synchronous and CPU-heavy: call it from a worker thread, never directly
on the event loop.
"""

from __future__ import annotations

import logging
import time
from typing import TypedDict

import librosa
import numpy as np

from app.audio.decode import DEFAULT_SR, AudioDecodeError, AudioTooLong, load_audio

log = logging.getLogger(__name__)

__all__ = [  # load_audio & co. live in decode.py; re-exported because Stage 0's spec put them here
    "AudioDecodeError",
    "AudioTooLong",
    "BeatTrack",
    "bpm_from_beats",
    "estimate_tempo",
    "load_audio",
    "onset_envelope",
    "track_beats",
    "warmup",
]

# 256 rather than librosa's default 512: at 512 (23 ms frames) the beat period is quantized so
# coarsely that e.g. a 120 BPM song comes out as 117.45 BPM (2.1 % off); 256 keeps it < 1 %.
HOP_LENGTH = 256
# 1024 rather than librosa's default 2048: the longer window delays onsets, so beats came out
# ~28 ms late on our test songs; 1024 gives ~16 ms with the same tempi (512 halves 150 BPM).
N_FFT = 1024
AC_SIZE_SEC = 8.0  # tempogram window, librosa's default
STFT_CHUNK_FRAMES = 8192
TEMPOGRAM_CHUNK_FRAMES = 2048
MIN_DURATION_SEC = 1.0
SILENCE_PEAK = 1e-4  # about -80 dBFS


class BeatTrack(TypedDict):
    durationSec: float
    sampleRate: int
    tempo: float
    bpmFromBeats: float
    beats: list[float]


def track_beats(y: np.ndarray, sr: int) -> BeatTrack:
    """Global tempo and beat times for mono audio. Silent or < 1 s audio yields no beats."""
    y = _finite_unit_peak(y)
    duration = len(y) / sr if sr > 0 else 0.0
    result: BeatTrack = {
        "durationSec": round(duration, 4),
        "sampleRate": int(sr),
        "tempo": 0.0,
        "bpmFromBeats": 0.0,
        "beats": [],
    }
    if duration < MIN_DURATION_SEC or float(np.max(np.abs(y))) < SILENCE_PEAK:
        return result

    env = onset_envelope(y, sr)
    if not env.any():  # e.g. a constant tone: nothing to track
        return result
    tempo = estimate_tempo(env, sr)
    _, beat_frames = librosa.beat.beat_track(
        onset_envelope=env, sr=sr, hop_length=HOP_LENGTH, bpm=tempo, trim=False
    )
    beat_frames = _trim_weak_edge_beats(beat_frames, env)
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH)
    result["tempo"] = round(tempo, 2)
    result["bpmFromBeats"] = round(bpm_from_beats(beats), 2)
    result["beats"] = [round(float(t), 4) for t in beats]
    return result


def onset_envelope(y: np.ndarray, sr: int, chunk_frames: int = STFT_CHUNK_FRAMES) -> np.ndarray:
    """``librosa.onset.onset_strength(y=y, n_fft=N_FFT, aggregate=np.median)``, one STFT chunk at a time.

    Only the mel spectrogram (128 x frames) is ever held in full, not the 513 x frames STFT.
    """
    n_frames = 1 + len(y) // HOP_LENGTH  # librosa's centered framing
    padded = np.pad(y, N_FFT // 2)  # center=True, pad_mode="constant"
    mel_basis = librosa.filters.mel(sr=sr, n_fft=N_FFT, fmax=0.5 * sr)
    mel = np.empty((mel_basis.shape[0], n_frames), dtype=np.float32)
    for a in range(0, n_frames, chunk_frames):
        b = min(a + chunk_frames, n_frames)
        segment = padded[a * HOP_LENGTH : (b - 1) * HOP_LENGTH + N_FFT]
        power = np.abs(librosa.stft(segment, n_fft=N_FFT, hop_length=HOP_LENGTH, center=False)) ** 2
        mel[:, a:b] = mel_basis @ power
    return librosa.onset.onset_strength(
        S=librosa.power_to_db(mel), sr=sr, hop_length=HOP_LENGTH, n_fft=N_FFT, aggregate=np.median
    )


def estimate_tempo(env: np.ndarray, sr: int, chunk_frames: int = TEMPOGRAM_CHUNK_FRAMES) -> float:
    """``librosa.feature.tempo(onset_envelope=env)``, averaging the tempogram one chunk at a time.

    librosa materializes the whole (8 s window x frames) autocorrelation tempogram just to take
    its mean; summing chunks of it keeps memory constant.
    """
    win = int(librosa.time_to_frames(AC_SIZE_SEC, sr=sr, hop_length=HOP_LENGTH))
    n = env.shape[-1]
    padded = np.pad(env, win // 2, mode="linear_ramp", end_values=(0, 0))  # tempogram(center=True)
    total = np.zeros(win, dtype=np.float64)
    for a in range(0, n, chunk_frames):
        b = min(a + chunk_frames, n)
        tg = librosa.feature.tempogram(
            onset_envelope=padded[a : b - 1 + win], sr=sr, hop_length=HOP_LENGTH, win_length=win, center=False
        )
        total += tg.sum(axis=-1)
    tempo = librosa.feature.tempo(tg=(total / n)[:, None], sr=sr, hop_length=HOP_LENGTH, aggregate=None)
    return float(np.atleast_1d(tempo)[0])


def _trim_weak_edge_beats(frames: np.ndarray, onset_env: np.ndarray) -> np.ndarray:
    """Drop leading/trailing beats whose smoothed onset strength is below 0.5 x RMS.

    This is librosa 0.10's ``trim=True`` behaviour. librosa 0.11's built-in trim compares raw
    scores against a threshold about 2x too high (it forgets the smoothing window's gain), so
    when a song ends on a section with weaker-than-average onsets (e.g. a dense final chorus)
    it drops that whole section. Hence beat_track(trim=False) plus this.
    """
    if len(frames) < 3:
        return frames
    last = len(onset_env) - 1
    strength = np.max([onset_env[np.clip(frames + k, 0, last)] for k in range(-2, 3)], axis=0)
    # "full" then slice == "same" for any length; "same" misaligns when len(strength) < 5.
    smooth = np.convolve(strength, np.hanning(5))[2 : 2 + len(strength)]
    valid = np.flatnonzero(smooth > 0.5 * np.sqrt(np.mean(smooth**2)))
    return frames[valid[0] : valid[-1] + 1] if valid.size else frames[:0]


def bpm_from_beats(beats: np.ndarray | list[float]) -> float:
    """60 / median inter-beat interval, or 0.0 with fewer than two beats."""
    if len(beats) < 2:
        return 0.0
    ibi = float(np.median(np.diff(np.asarray(beats, dtype=np.float64))))
    return 60.0 / ibi if ibi > 0 else 0.0


def warmup() -> None:
    """Run beat tracking on ~3 s of clicks so numba compiles before the first real request."""
    start = time.perf_counter()
    try:
        clicks = librosa.clicks(times=np.arange(0.0, 3.0, 0.5), sr=DEFAULT_SR, length=3 * DEFAULT_SR)
        track_beats(clicks.astype(np.float32), DEFAULT_SR)
    except Exception:  # warmup is best effort; the first request just pays the JIT cost
        log.exception("beat tracker warmup failed")
        return
    log.info("beat tracker warm in %.1f s", time.perf_counter() - start)


def _finite_unit_peak(y: np.ndarray) -> np.ndarray:
    """float32, NaN/inf zeroed, scaled into [-1, 1] if louder (huge values overflow librosa's spectra).

    Copies only when something has to change. Beat tracking does not depend on absolute level.
    """
    y = np.asarray(y, dtype=np.float32)
    if not np.isfinite(y).all():
        y = np.nan_to_num(y, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    return y / np.float32(peak) if peak > 1.0 else y
