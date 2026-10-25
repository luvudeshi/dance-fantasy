"""Tempo and beat phase from the motion alone (AIST++ ships no music timing).

1. Speed signals: per-joint speed (world, torso units / s), lightly smoothed, slow trend removed.
2. Coarse tempo: the mean of the per-joint normalized autocorrelations, scored for every candidate in
   [MIN_BPM, MAX_BPM] with a comb over 1, 2, 4 and 8 beat lags (dances repeat 8-counts), plus a very weak
   log-normal prior over the AIST range and an optional weak *song-digit* hint (AIST songs get faster with
   the digit in the music id) that breaks near-ties such as 3:2 confusions.
3. Fine tempo: the same autocorrelation, combed over every beat multiple up to 60% of the sequence, within
   +-1.5% of the coarse tempo (long lags make the estimate precise).
4. Phase: a constant beat grid (AIST songs have constant tempo) whose beats best line up with motion
   *hits*: speed minima (a pose held / reversed) plus a little deceleration (a motion stopping).
   ``local_shift`` re-aligns the grid inside a window, absorbing residual tempo drift.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

MIN_BPM, MAX_BPM = 75.0, 140.0
PRIOR_CENTER, PRIOR_SIGMA, PRIOR_WEIGHT = 105.0, 0.35, 0.05  # whole AIST range (80-135), very weak
DIGIT_SIGMA, DIGIT_WEIGHT = 0.12, 0.15  # song-digit hint
COARSE_COMB = ((1, 1.0), (2, 0.5), (4, 0.5), (8, 0.5))
SMOOTH_SIGMA = 2.0  # frames
HIT_DECEL = 0.25  # weight of deceleration peaks next to speed minima in the hit signal
FINE_SPAN = 0.015
HINT_TOLERANCE = 0.04  # an estimate this far from the digit hint is re-checked near the hint
HINT_SUPPORT = 0.05  # ... and moved there only if the motion's comb score there is this close to its best


@dataclass(frozen=True)
class TempoResult:
    bpm: float
    beat0: float  # seconds: time of one beat of the grid, in [0, 60/bpm)
    score: float  # mean hit strength on the grid (z units; > ~0.4 is a clear pulse)
    comb: float  # autocorrelation comb score at bpm (periodicity strength)
    coarse_bpm: float
    hint: str  # "none" | "agrees" | "moved" (re-estimated near the digit hint) | "disagrees"

    @property
    def period(self) -> float:
        return 60.0 / self.bpm

    def beat_times(self, duration: float) -> np.ndarray:
        k0 = -int(np.floor(self.beat0 / self.period))
        k = np.arange(k0, int(np.ceil((duration - self.beat0) / self.period)) + 1)
        t = self.beat0 + k * self.period
        return t[(t >= -1e-9) & (t <= duration + 1e-9)]


def gaussian_smooth(x: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian smoothing along axis 0 (edge-padded)."""
    if sigma <= 0:
        return np.array(x, dtype=np.float64, copy=True)
    r = int(np.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    x2 = np.asarray(x, dtype=np.float64).reshape(len(x), -1)
    pad = np.pad(x2, [(r, r), (0, 0)], mode="edge")
    out = np.stack([np.convolve(pad[:, c], k, mode="valid") for c in range(x2.shape[1])], axis=1)
    return out.reshape(np.shape(x))


def joint_speeds(points: np.ndarray, fps: float) -> np.ndarray:
    """(N, J, D) positions -> (N, J) smoothed joint speeds."""
    p = gaussian_smooth(points, SMOOTH_SIGMA)
    return np.linalg.norm(np.gradient(p, axis=0) * fps, axis=-1)


def detrend(x: np.ndarray, fps: float) -> np.ndarray:
    d = x - gaussian_smooth(x, 0.5 * fps)
    sd = float(d.std())
    return d / sd if sd > 1e-9 else d * 0.0


def autocorr(x: np.ndarray) -> np.ndarray:
    """Normalized, unbiased autocorrelation (r[0] = 1)."""
    n = len(x)
    f = np.fft.rfft(x - x.mean(), 2 * n)
    r = np.fft.irfft(f * np.conj(f))[:n]
    r = r / max(float(r[0]), 1e-12)
    return r * n / np.maximum(n - np.arange(n), 1)


def mean_autocorr(speeds: np.ndarray, fps: float) -> np.ndarray:
    return np.mean([autocorr(detrend(speeds[:, j], fps)) for j in range(speeds.shape[1])], axis=0)


def _at(r: np.ndarray, lag: np.ndarray) -> np.ndarray:
    """r at fractional lags (0 beyond the end)."""
    lag = np.asarray(lag, dtype=np.float64)
    ok = lag < len(r) - 1
    i = np.minimum(lag.astype(int), len(r) - 2)
    w = lag - i
    return np.where(ok, r[i] * (1 - w) + r[i + 1] * w, 0.0)


def comb_scores(r: np.ndarray, fps: float, bpms: np.ndarray, comb: tuple[tuple[int, float], ...] = COARSE_COMB) -> np.ndarray:
    lag = 60.0 * fps / np.asarray(bpms, dtype=np.float64)
    total = sum(w for _, w in comb)
    return sum(w * _at(r, k * lag) for k, w in comb) / total


def prior(bpms: np.ndarray, digit_bpm: float | None) -> np.ndarray:
    p = -PRIOR_WEIGHT * 0.5 * (np.log(bpms / PRIOR_CENTER) / PRIOR_SIGMA) ** 2
    if digit_bpm:
        p = p + DIGIT_WEIGHT * np.exp(-0.5 * (np.log(bpms / digit_bpm) / DIGIT_SIGMA) ** 2)
    return p


def hit_signal(speed: np.ndarray, fps: float) -> np.ndarray:
    """z-scored 'hit' strength per frame from the summed speed: low speed (the motion stops on the hit) plus a
    little deceleration (HIT_DECEL; more biases the phase early, since the smoothed deceleration peaks before
    the stop)."""
    s = detrend(speed, fps)
    decel = np.maximum(0.0, -np.gradient(gaussian_smooth(speed, 3.0)))
    dz = (decel - decel.mean()) / max(float(decel.std()), 1e-9)
    return -s + HIT_DECEL * dz


def grid_frames(n: int, fps: float, bpm: float, beat0: float) -> np.ndarray:
    period = 60.0 * fps / bpm
    start = beat0 * fps
    k0 = -int(np.floor(start / period))
    frames = start + period * np.arange(k0, int((n - 1 - start) / period) + 1)
    return frames[(frames >= 0) & (frames <= n - 1)]


def sample(x: np.ndarray, frames: np.ndarray) -> np.ndarray:
    i = np.clip(np.floor(frames).astype(int), 0, len(x) - 1)
    j = np.minimum(i + 1, len(x) - 1)
    w = frames - np.floor(frames)
    return x[i] * (1 - w) + x[j] * w


def best_phase(hit: np.ndarray, fps: float, bpm: float, steps: int = 96) -> tuple[float, float]:
    period = 60.0 / bpm
    best = (-np.inf, 0.0)
    for ph in np.arange(steps) * period / steps:
        f = grid_frames(len(hit), fps, bpm, float(ph))
        if len(f):
            sc = float(sample(hit, f).mean())
            if sc > best[0]:
                best = (sc, float(ph))
    return best[1], best[0]


def local_shift(hit: np.ndarray, fps: float, beat_times: np.ndarray, period: float, max_frac: float = 0.25) -> float:
    """Shift (seconds, |shift| <= max_frac beats) that best aligns ``beat_times`` with hits; mild pull to 0."""
    best = (-np.inf, 0.0)
    for frac in np.linspace(-max_frac, max_frac, 21):
        f = (beat_times + frac * period) * fps
        f = f[(f >= 0) & (f <= len(hit) - 1)]
        if not len(f):
            continue
        sc = float(sample(hit, f).mean()) - 0.6 * abs(frac)
        if sc > best[0]:
            best = (sc, frac * period)
    return best[1]


def estimate_tempo(points: np.ndarray, fps: float, digit_bpm: float | None = None) -> TempoResult:
    """Tempo + phase of a dance from (N, J, D) joint positions sampled at ``fps``."""
    speeds = joint_speeds(points, fps)
    r = mean_autocorr(speeds, fps)
    bpms = np.arange(MIN_BPM, MAX_BPM + 1e-9, 0.05)
    comb = comb_scores(r, fps, bpms)
    i = int(np.argmax(comb + prior(bpms, digit_bpm)))
    coarse = float(bpms[i])
    hint = "none"
    if digit_bpm:
        hint = "agrees"
        if abs(coarse / digit_bpm - 1) > HINT_TOLERANCE:
            near = np.abs(bpms / digit_bpm - 1) <= HINT_TOLERANCE
            j = int(np.flatnonzero(near)[np.argmax(comb[near])]) if near.any() else -1
            if j >= 0 and comb[j] >= comb.max() - HINT_SUPPORT:
                coarse, hint = float(bpms[j]), "moved"
            else:
                hint = "disagrees"
    # fine: comb over every beat multiple that fits in 60% of the sequence
    fine = np.arange(coarse * (1 - FINE_SPAN), coarse * (1 + FINE_SPAN) + 1e-9, 0.01)
    kmax = max(1, int(0.6 * len(r) / (60.0 * fps / coarse)))
    fine_scores = comb_scores(r, fps, fine, tuple((k, 1.0) for k in range(1, kmax + 1)))
    bpm = float(fine[int(np.argmax(fine_scores))])
    hit = hit_signal(speeds.sum(axis=1), fps)
    beat0, score = best_phase(hit, fps, bpm)
    return TempoResult(
        bpm=round(bpm, 2),
        beat0=beat0,
        score=score,
        comb=float(comb_scores(r, fps, np.array([bpm]))[0]),
        coarse_bpm=coarse,
        hint=hint,
    )


def digit_tempo(genre: str, digit: int) -> float:
    """Song-digit hint: AIST songs get faster with the digit (house spans a narrower, faster range).

    Checked against the data: every basic-dance (sBM) sequence in our subset lasts exactly 16 beats at this
    tempo. Used only as a weak prior / tie-breaker, never as the answer.
    """
    return (110.0 + 5.0 * digit) if genre == "HO" else (80.0 + 10.0 * digit)
