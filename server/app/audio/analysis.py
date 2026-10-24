"""Full song analysis (pure: samples in, JSON-ready dict out): beat grid, downbeats, onset
envelope, per-beat loudness and labeled sections. The HTTP layer adds id/title/source/etc.

Synchronous and CPU-heavy: call from a worker thread, never on the event loop.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from app.audio.beats import (
    HOP_LENGTH,
    MIN_DURATION_SEC,
    SILENCE_PEAK,
    _finite_unit_peak,
    beats_from_envelope,
    onset_envelope,
)
from app.audio.features import beat_features, frame_features
from app.audio.grid import BEATS_PER_BAR, beat_grid, downbeat_phase, grid_period, harmonic_change
from app.audio.structure import analyze_structure

# Bump whenever the output for the same audio changes: cached results are keyed by it.
ANALYSIS_VERSION = 2  # 2: back-to-back sections of one group are labeled as one run
ONSET_HOP_SEC = 0.05  # target spacing of the downsampled onset envelope
ONSET_NORM_PERCENTILE = 99.0
ENERGY_PERCENTILES = (5.0, 95.0)
MIN_ENERGY_SPAN_DB = 3.0  # flatter songs are centered rather than stretched to fill 0..1
GROUP_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def analyze_audio(y: np.ndarray, sr: int) -> dict[str, Any]:
    """Analysis fields for mono audio: durationSec, sampleRate, bpm, beatsPerBar, beats,
    filledBeats, downbeatPhase, downbeats, onsetEnvelope, beatEnergy, sections.

    Silent, < 1 s or beatless audio gives a valid result with no beats and one section.
    """
    y = _finite_unit_peak(y)
    duration = len(y) / sr if sr > 0 else 0.0
    if len(y) == 0:
        return _degenerate(duration, sr, np.zeros(0))
    env = onset_envelope(y, sr)
    if duration < MIN_DURATION_SEC or float(np.max(np.abs(y))) < SILENCE_PEAK or not env.any():
        return _degenerate(duration, sr, env)

    _, detected = beats_from_envelope(env, sr)
    beats, filled = beat_grid(detected, duration, env, sr, HOP_LENGTH)
    if len(beats) < 2:
        return _degenerate(duration, sr, env)
    period = grid_period(beats)

    feats = beat_features(y, sr, beats, period, frame_features(y, sr), env, HOP_LENGTH)
    phase = downbeat_phase(harmonic_change(feats.chroma), feats.kick, feats.onset)
    energy = scale_beat_energy(feats.power)
    raw_sections = analyze_structure(feats.chroma, feats.mfcc, feats.power, feats.onset, feats.density, energy, phase)

    beat_list = [float(b) for b in beats]
    sections = []
    for i, (start_beat, end_beat, label, group, sec_energy) in enumerate(raw_sections):
        sections.append(
            {
                "start": 0.0 if i == 0 else beat_list[start_beat],
                "end": round(duration, 4) if i == len(raw_sections) - 1 else beat_list[end_beat],
                "label": label,
                "energy": _unit(sec_energy),
                "group": GROUP_LETTERS[min(group, len(GROUP_LETTERS) - 1)],
                "startBeat": start_beat,
                "endBeat": end_beat,
                "bars": _bars_in(start_beat, end_beat, phase),
            }
        )
    return {
        **_base(duration, sr, env),
        "bpm": round(60.0 / period, 2),
        "beats": beat_list,
        "filledBeats": [int(i) for i in np.flatnonzero(filled)],
        "downbeatPhase": phase,
        "downbeats": beat_list[phase::BEATS_PER_BAR],
        "beatEnergy": [_unit(e) for e in energy],
        "sections": sections,
    }


def scale_beat_energy(power: np.ndarray) -> np.ndarray:
    """Per-beat RMS in dB, mapped to 0..1 by the song's 5th..95th percentile (clipped)."""
    if power.size == 0:
        return np.zeros(0)
    db = 10.0 * np.log10(np.maximum(power, 1e-10))
    lo, hi = np.percentile(db, ENERGY_PERCENTILES)
    if hi - lo < MIN_ENERGY_SPAN_DB:
        mid = (hi + lo) / 2
        lo, hi = mid - MIN_ENERGY_SPAN_DB / 2, mid + MIN_ENERGY_SPAN_DB / 2
    return np.clip((db - lo) / (hi - lo), 0.0, 1.0)


def downsample_onsets(env: np.ndarray, sr: int) -> dict[str, Any]:
    """Max-pool the onset envelope to ~ONSET_HOP_SEC and normalize to 0..1."""
    factor = max(1, int(round(ONSET_HOP_SEC * sr / HOP_LENGTH)))
    hop_sec = round(factor * HOP_LENGTH / sr, 6) if sr > 0 else ONSET_HOP_SEC
    env = np.nan_to_num(np.asarray(env, dtype=np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    if env.size == 0:
        return {"hopSec": hop_sec, "values": []}
    n_out = -(-env.size // factor)
    pooled = np.pad(env, (0, n_out * factor - env.size)).reshape(n_out, factor).max(axis=1)
    scale = float(np.percentile(pooled, ONSET_NORM_PERCENTILE)) or float(pooled.max())
    values = np.clip(pooled / scale, 0.0, 1.0) if scale > 0 else np.zeros(n_out)
    return {"hopSec": hop_sec, "values": [round(float(v), 3) for v in values]}


def _base(duration: float, sr: int, env: np.ndarray) -> dict[str, Any]:
    return {
        "durationSec": round(duration, 4),
        "sampleRate": int(sr),
        "beatsPerBar": BEATS_PER_BAR,
        "onsetEnvelope": downsample_onsets(env, sr),
    }


def _degenerate(duration: float, sr: int, env: np.ndarray) -> dict[str, Any]:
    section = {
        "start": 0.0,
        "end": round(duration, 4),
        "label": "verse",
        "energy": 0.0,
        "group": "A",
        "startBeat": 0,
        "endBeat": 0,
        "bars": 0,
    }
    return {
        **_base(duration, sr, env),
        "bpm": 0.0,
        "beats": [],
        "filledBeats": [],
        "downbeatPhase": 0,
        "downbeats": [],
        "beatEnergy": [],
        "sections": [section],
    }


def _bars_in(start_beat: int, end_beat: int, phase: int) -> int:
    """Number of downbeats (beat indices phase + 4k) in [start_beat, end_beat)."""
    first = max(start_beat, phase)
    if first >= end_beat:
        return 0
    k0 = -(-(first - phase) // BEATS_PER_BAR)
    k1 = -(-(end_beat - phase) // BEATS_PER_BAR)
    return max(0, k1 - k0)


def _unit(x: float) -> float:
    x = float(x)
    return round(min(1.0, max(0.0, x)), 3) if np.isfinite(x) else 0.0
