"""Beat grid (gap filling, edge extrapolation, tempo octave guard) and downbeat phase (4/4)."""

from __future__ import annotations

import numpy as np

MIN_BPM = 70.0  # slower than this is taken as half tempo: beats are doubled
MAX_BPM = 190.0  # faster than this is taken as double tempo: every other beat is kept
GAP_FACTOR = 1.5  # an inter-beat gap longer than this many periods gets filled
END_MARGIN_SEC = 0.05  # no extrapolated beat within this distance of the end
START_SLACK_SEC = 0.02  # an extrapolated beat this close before 0 is put at 0
BEATS_PER_BAR = 4
# Downbeat cue weights: harmonic change, kick-band onset, overall onset strength.
PHASE_WEIGHTS = {"chroma": 1.0, "kick": 1.0, "onset": 0.5}


def beat_grid(
    detected: np.ndarray, duration: float, onset_env: np.ndarray, sr: int, hop: int
) -> tuple[np.ndarray, np.ndarray]:
    """(beats, filled) from detected beat times: a gap-free grid covering [0, duration].

    ``filled[i]`` is True when beats[i] came from the tempo grid rather than the tracker.
    Fewer than 2 detected beats give empty arrays (no tempo to extend).
    """
    beats = np.asarray(detected, dtype=np.float64)
    beats = beats[(beats >= 0) & (beats < duration)]
    if len(beats) < 2:
        return np.zeros(0), np.zeros(0, dtype=bool)
    filled = np.zeros(len(beats), dtype=bool)
    period = grid_period(beats)

    beats, filled = _fill_gaps(beats, filled, period)
    while 60.0 / period < MIN_BPM:
        mids = (beats[:-1] + beats[1:]) / 2
        beats = np.insert(beats, np.arange(1, len(beats)), mids)
        filled = np.insert(filled, np.arange(1, len(filled)), True)
        period /= 2
    while 60.0 / period > MAX_BPM and len(beats) >= 4:
        strength = _onset_at(onset_env, beats, sr, hop)
        keep = 0 if strength[0::2].mean() >= strength[1::2].mean() else 1
        beats, filled = beats[keep::2], filled[keep::2]
        period *= 2

    head = []
    t = beats[0] - period
    while t >= -START_SLACK_SEC:
        head.append(max(t, 0.0))
        t -= period
    tail = []
    t = beats[-1] + period
    while t <= duration - END_MARGIN_SEC:
        tail.append(t)
        t += period
    beats = np.concatenate([head[::-1], beats, tail])
    filled = np.concatenate([np.ones(len(head), bool), filled, np.ones(len(tail), bool)])

    beats = np.round(beats, 4)
    keep_mask = np.concatenate([[True], np.diff(beats) > 0])  # strictly ascending after rounding
    return beats[keep_mask], filled[keep_mask]


def grid_period(beats: np.ndarray) -> float:
    """Beat period: mean of the inter-beat intervals within 10 % of the median one.

    The median alone is quantized to whole onset frames (11.6 ms), e.g. 128 BPM reads as
    129.2; averaging the near-median intervals recovers the sub-frame period.
    """
    ibi = np.diff(np.asarray(beats, dtype=np.float64))
    if ibi.size == 0:
        return 0.0
    med = float(np.median(ibi))
    near = ibi[np.abs(ibi - med) <= 0.1 * med]
    return float(near.mean()) if near.size else med


def _fill_gaps(beats: np.ndarray, filled: np.ndarray, period: float) -> tuple[np.ndarray, np.ndarray]:
    out_b, out_f = [beats[0]], [filled[0]]
    for a, b, f in zip(beats[:-1], beats[1:], filled[1:], strict=True):
        gap = b - a
        if gap > GAP_FACTOR * period:
            n = int(round(gap / period))
            out_b.extend(a + gap * k / n for k in range(1, n))
            out_f.extend([True] * (n - 1))
        out_b.append(b)
        out_f.append(f)
    return np.array(out_b), np.array(out_f, dtype=bool)


def _onset_at(env: np.ndarray, times: np.ndarray, sr: int, hop: int) -> np.ndarray:
    idx = np.clip(np.round(times * sr / hop).astype(int), 0, len(env) - 1)
    return env[idx]


def harmonic_change(beat_chroma: np.ndarray, span: int = 2) -> np.ndarray:
    """Per beat: cosine distance between the chroma of the ``span`` beats before and after it (NaN at edges)."""
    n = beat_chroma.shape[1]
    out = np.full(n, np.nan)
    cs = np.concatenate([np.zeros((12, 1)), np.cumsum(beat_chroma, axis=1)], axis=1)
    for i in range(span, n - span + 1):
        before = cs[:, i] - cs[:, i - span]
        after = cs[:, i + span] - cs[:, i]
        nb, na = np.linalg.norm(before), np.linalg.norm(after)
        if nb > 0 and na > 0:
            out[i] = 1.0 - float(before @ after) / (nb * na)
    return out


def downbeat_phase(chroma_change: np.ndarray, kick: np.ndarray, onset: np.ndarray) -> int:
    """Index of the first downbeat (0..3): the beat phase where bar-start cues are strongest."""
    n = len(kick)
    phases = range(min(BEATS_PER_BAR, n))
    if len(phases) < 2:
        return 0
    score = np.zeros(len(phases))
    for name, values in (("chroma", chroma_change), ("kick", kick), ("onset", onset)):
        means = np.array([_nanmean(values[p::BEATS_PER_BAR]) for p in phases])
        if np.isnan(means).any():
            continue
        spread = means.std()
        if spread > 1e-9 * (abs(means.mean()) + 1.0):
            score += PHASE_WEIGHTS[name] * (means - means.mean()) / spread
    return int(np.argmax(score))


def _nanmean(x: np.ndarray) -> float:
    x = x[np.isfinite(x)]
    return float(x.mean()) if x.size else float("nan")
