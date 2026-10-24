"""Frame and per-beat features for downbeat and structure analysis.

The STFT is computed one chunk at a time (like ``beats.onset_envelope``), so only the small
feature rows (12 chroma + 13 MFCC + 1 kick band per frame) are held for the whole song.

Synchronous and CPU-heavy: call from a worker thread.
"""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np

FEATURE_HOP = 512
FEATURE_N_FFT = 2048  # ~10.8 Hz bins at 22.05 kHz: enough to resolve the 40-150 Hz kick band and chroma
CHUNK_FRAMES = 4096
KICK_BAND_HZ = (40.0, 150.0)
CHROMA_CENTER_OCTAVE = 4.0  # weight chroma around C4 (librosa: C5), i.e. harmony over lead melody
N_MELS = 64
N_MFCC = 13
PEAK_WINDOW_SEC = 0.035  # onsets are searched within this distance of each beat time


@dataclass(frozen=True)
class FrameFeatures:
    sr: int
    hop: int
    chroma: np.ndarray  # (12, frames) chroma energy (linear)
    mfcc: np.ndarray  # (13, frames)
    kick_flux: np.ndarray  # (frames,) rise in kick-band power per frame (power scaled to max 1), >= 0


@dataclass(frozen=True)
class BeatFeatures:
    chroma: np.ndarray  # (12, beats) mean chroma over each beat interval
    mfcc: np.ndarray  # (13, beats)
    kick: np.ndarray  # (beats,) strongest kick-band onset near the beat
    onset: np.ndarray  # (beats,) strongest onset (full band) near the beat
    density: np.ndarray  # (beats,) mean onset strength over the beat interval (how busy the drums are)
    power: np.ndarray  # (beats,) mean squared amplitude over the beat interval


def frame_features(y: np.ndarray, sr: int) -> FrameFeatures:
    n_frames = 1 + len(y) // FEATURE_HOP  # librosa's centered framing
    padded = np.pad(y, FEATURE_N_FFT // 2)
    chroma_fb = librosa.filters.chroma(sr=sr, n_fft=FEATURE_N_FFT, tuning=0.0, ctroct=CHROMA_CENTER_OCTAVE)
    mel_fb = librosa.filters.mel(sr=sr, n_fft=FEATURE_N_FFT, n_mels=N_MELS)
    freqs = librosa.fft_frequencies(sr=sr, n_fft=FEATURE_N_FFT)
    kick_bins = (freqs >= KICK_BAND_HZ[0]) & (freqs <= KICK_BAND_HZ[1])

    chroma = np.empty((12, n_frames), dtype=np.float32)
    mfcc = np.empty((N_MFCC, n_frames), dtype=np.float32)
    kick = np.empty(n_frames, dtype=np.float64)
    for a in range(0, n_frames, CHUNK_FRAMES):
        b = min(a + CHUNK_FRAMES, n_frames)
        segment = padded[a * FEATURE_HOP : (b - 1) * FEATURE_HOP + FEATURE_N_FFT]
        power = np.abs(librosa.stft(segment, n_fft=FEATURE_N_FFT, hop_length=FEATURE_HOP, center=False)) ** 2
        chroma[:, a:b] = chroma_fb @ power
        # top_db=None: a per-chunk dynamic-range clamp would make chunks inconsistent.
        mel_db = librosa.power_to_db(mel_fb @ power, top_db=None)
        mfcc[:, a:b] = librosa.feature.mfcc(S=mel_db, n_mfcc=N_MFCC)
        kick[a:b] = power[kick_bins].sum(axis=0)

    # Linear (not dB) rise: in dB, noise in quiet passages and short gaps between bass notes
    # produce rises as big as real kicks; linear power lets the loud, clear kicks dominate.
    kick /= max(float(kick.max()), 1e-20)
    kick_flux = np.maximum(0.0, np.diff(kick, prepend=kick[:1]))
    return FrameFeatures(sr=sr, hop=FEATURE_HOP, chroma=chroma, mfcc=mfcc, kick_flux=kick_flux)


def beat_features(
    y: np.ndarray,
    sr: int,
    beats: np.ndarray,
    period: float,
    frames: FrameFeatures,
    onset_env: np.ndarray,
    onset_hop: int,
) -> BeatFeatures:
    """Aggregate frame features over each beat interval [beats[i], beats[i+1]) (the last one lasts ``period``)."""
    duration = len(y) / sr
    ends = np.append(beats[1:], min(beats[-1] + period, duration))

    starts_f, ends_f = _intervals(beats, ends, sr, frames.hop, frames.chroma.shape[1])
    chroma = _interval_means(frames.chroma, starts_f, ends_f)
    mfcc = _interval_means(frames.mfcc, starts_f, ends_f)
    kick = _peak_near(frames.kick_flux, beats, sr, frames.hop)
    onset = _peak_near(onset_env, beats, sr, onset_hop)
    env_starts, env_ends = _intervals(beats, ends, sr, onset_hop, len(onset_env))
    density = _interval_means(np.asarray(onset_env, dtype=np.float64)[None, :], env_starts, env_ends)[0]

    power = np.empty(len(beats))
    for i, (t0, t1) in enumerate(zip(beats, ends, strict=True)):
        a = min(int(round(t0 * sr)), len(y) - 1)
        b = max(a + 1, min(int(round(t1 * sr)), len(y)))
        seg = y[a:b].astype(np.float64)
        power[i] = float(np.mean(seg * seg))
    return BeatFeatures(chroma=chroma, mfcc=mfcc, kick=kick, onset=onset, density=density, power=power)


def _intervals(starts: np.ndarray, ends: np.ndarray, sr: int, hop: int, n: int) -> tuple[np.ndarray, np.ndarray]:
    s = np.clip(np.round(starts * sr / hop).astype(int), 0, n - 1)
    e = np.clip(np.round(ends * sr / hop).astype(int), 0, n)
    return s, np.maximum(e, s + 1)


def _interval_means(x: np.ndarray, starts: np.ndarray, ends: np.ndarray) -> np.ndarray:
    cs = np.concatenate([np.zeros((x.shape[0], 1)), np.cumsum(x, axis=1, dtype=np.float64)], axis=1)
    return (cs[:, ends] - cs[:, starts]) / (ends - starts)


def _peak_near(x: np.ndarray, times: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Max of ``x`` within PEAK_WINDOW_SEC of each time."""
    w = max(1, int(round(PEAK_WINDOW_SEC * sr / hop)))
    centers = np.clip(np.round(times * sr / hop).astype(int), 0, len(x) - 1)
    padded = np.pad(np.asarray(x, dtype=np.float64), w, mode="edge")
    windows = np.stack([padded[centers + w + k] for k in range(-w, w + 1)])
    return windows.max(axis=0)
