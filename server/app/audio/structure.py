"""Song structure from per-beat features: bars, boundaries, repeated groups, section labels.

Works at bar resolution (4/4): bar k spans beats [starts[k], starts[k+1]); beats before the
first downbeat are a pickup that belongs to the first section.

1. Bar features: mean chroma (L2-normalized); MFCC 1-12 and onset strength/density at each
   beat position (standardized over the song); RMS dB.
2. Bar self-similarity: average of chroma, timbre (per-beat MFCC) and rhythm (onset pattern)
   cosine similarity.
3. Boundaries: Foote checkerboard novelty (Gaussian taper) plus a loudness-jump term,
   peak-picked >= MIN_SECTION_BARS apart, snapped to the 4-bar phrase grid when that
   costs little novelty.
4. Groups: sections whose bar-aligned chroma AND timbre similarity are high repeat the same
   music (average-linkage agglomeration); letters in order of first appearance.
5. Labels: chorus = loudest repeated group (else the loudest section), verse = other
   repeated groups, a quiet unique first/last section is intro/outro, other unique sections
   are verses before the first chorus and bridges after it.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

BEATS_PER_BAR = 4
MIN_SECTION_BARS = 4
MIN_EDGE_SECTION_BARS = 2  # intros/outros may be shorter than a phrase
PHRASE_BARS = 4
# Boundaries use all three similarities: chroma (harmony), MFCC (timbre), rhythm (drum pattern).
SSM_WEIGHTS = {"chroma": 1.0, "mfcc": 1.0, "rhythm": 1.0}
# Grouping needs harmony AND timbre to repeat (rhythm varies too much bar to bar to help).
GROUP_FEATURES = ("chroma", "mfcc")
NOVELTY_HALF_WIDTH = 4  # bars on each side of the checkerboard kernel
ENERGY_JUMP_WEIGHT = 0.5
ENERGY_JUMP_DB = 6.0  # a loudness jump of this many dB counts as much as the strongest novelty peak
PEAK_THRESHOLD = 0.3  # boundaries need novelty >= this (novelty is scaled to max 1 per song)
SNAP_KEEP = 0.7  # snap to the phrase grid when novelty there is >= this fraction of the peak
GROUP_THRESHOLD = 0.4  # sections whose scaled bar-aligned similarity exceeds this share a group
CHORUS_REPEAT_BONUS = 0.05
MAX_GROUPS = 26


@dataclass(frozen=True)
class BarFeatures:
    chroma: np.ndarray  # (bars, 12), rows L2-normalized
    mfcc: np.ndarray  # (bars, 4, 12): MFCC 1-12 of each beat of the bar, standardized, rows L2-normalized
    mfcc_mask: np.ndarray  # (bars, 4) bool: the beat exists (the last bar may be partial)
    rhythm: np.ndarray  # (bars, 8): onset at / onset density over each beat, standardized, rows L2-normalized
    rms_db: np.ndarray  # (bars,)


def bar_starts(n_beats: int, phase: int) -> np.ndarray:
    """Beat index where each bar starts (the downbeats)."""
    return np.arange(phase, n_beats, BEATS_PER_BAR) if n_beats > phase else np.zeros(0, dtype=int)


def bar_features(
    beat_chroma: np.ndarray,
    beat_mfcc: np.ndarray,
    beat_power: np.ndarray,
    beat_onset: np.ndarray,
    beat_density: np.ndarray,
    starts: np.ndarray,
) -> BarFeatures:
    n_beats = beat_chroma.shape[1]
    ends = np.append(starts[1:], n_beats)
    chroma = np.stack([beat_chroma[:, a:b].mean(axis=1) for a, b in zip(starts, ends, strict=True)])
    chroma /= np.maximum(np.linalg.norm(chroma, axis=1, keepdims=True), 1e-12)

    # Timbre per beat position, so a bar's rhythm pattern (kick/snare placement) counts too.
    used = beat_mfcc[1:13, starts[0] :]
    z = (used - used.mean(axis=1, keepdims=True)) / np.maximum(used.std(axis=1, keepdims=True), 1e-9)
    z /= np.maximum(np.linalg.norm(z, axis=0, keepdims=True), 1e-12)
    mfcc = np.zeros((len(starts), BEATS_PER_BAR, 12))
    mask = np.zeros((len(starts), BEATS_PER_BAR), dtype=bool)
    for k, (a, b) in enumerate(zip(starts, ends, strict=True)):
        m = b - a
        mfcc[k, :m] = z[:, a - starts[0] : b - starts[0]].T
        mask[k, :m] = True

    # Drum pattern: onset strength at each beat and onset density over it, per beat position.
    n_bars = len(starts)
    per_beat = np.log1p(np.stack([beat_onset, beat_density], axis=1))
    rhythm = np.zeros((n_bars, BEATS_PER_BAR, 2))
    for k, (a, b) in enumerate(zip(starts, ends, strict=True)):
        rhythm[k, : b - a] = per_beat[a:b]
    rhythm = rhythm.reshape(n_bars, -1)
    rhythm = (rhythm - rhythm.mean(axis=0)) / np.maximum(rhythm.std(axis=0), 1e-9)
    rhythm /= np.maximum(np.linalg.norm(rhythm, axis=1, keepdims=True), 1e-12)

    power = np.array([beat_power[a:b].mean() for a, b in zip(starts, ends, strict=True)])
    rms_db = 10.0 * np.log10(np.maximum(power, 1e-10))
    return BarFeatures(chroma=chroma, mfcc=mfcc, mfcc_mask=mask, rhythm=rhythm, rms_db=rms_db)


def feature_similarities(bars: BarFeatures) -> dict[str, np.ndarray]:
    """Bar x bar cosine similarity per feature, each mapped to [0, 1]."""
    dots = np.einsum("ikd,jkd->ij", bars.mfcc, bars.mfcc)
    counts = np.einsum("ik,jk->ij", bars.mfcc_mask.astype(float), bars.mfcc_mask.astype(float))
    return {
        "chroma": np.clip(bars.chroma @ bars.chroma.T, 0.0, 1.0),
        "mfcc": (np.clip(dots / np.maximum(counts, 1.0), -1.0, 1.0) + 1.0) / 2.0,
        "rhythm": (np.clip(bars.rhythm @ bars.rhythm.T, -1.0, 1.0) + 1.0) / 2.0,
    }


def self_similarity(sims: dict[str, np.ndarray]) -> np.ndarray:
    """Bar x bar similarity in [0, 1] for boundary detection: weighted mean of the feature similarities."""
    return sum(w * sims[name] for name, w in SSM_WEIGHTS.items()) / sum(SSM_WEIGHTS.values())


def novelty(ssm: np.ndarray, rms_db: np.ndarray, half_width: int = NOVELTY_HALF_WIDTH) -> np.ndarray:
    """Boundary strength before each bar (index b = boundary at the start of bar b), scaled to max 1.

    Checkerboard novelty as (tapered) mean similarity within each side minus mean similarity
    across, using only pairs inside the song and off the diagonal, so edges aren't penalized.
    """
    n = len(ssm)
    out = np.zeros(n + 1)
    if n < 2:
        return out
    offsets = np.arange(-half_width, half_width)
    taper = np.exp(-0.5 * ((offsets + 0.5) / (half_width / 2.0)) ** 2)
    weight = np.outer(taper, taper)
    same_side = (offsets[:, None] < 0) == (offsets[None, :] < 0)
    off_diag = offsets[:, None] != offsets[None, :]
    for b in range(1, n):
        idx = b + offsets
        valid = (idx >= 0) & (idx < n)
        mask = np.outer(valid, valid) & off_diag
        sub = np.zeros((len(offsets), len(offsets)))
        vi = idx[valid]
        sub[np.ix_(valid, valid)] = ssm[np.ix_(vi, vi)]
        w_same, w_cross = weight * (mask & same_side), weight * (mask & ~same_side)
        if w_same.sum() > 0 and w_cross.sum() > 0:
            out[b] = max(0.0, (w_same * sub).sum() / w_same.sum() - (w_cross * sub).sum() / w_cross.sum())
    if out.max() > 0:
        out /= out.max()

    jump = np.zeros(n + 1)
    for b in range(1, n):
        before, after = rms_db[max(0, b - 2) : b], rms_db[b : b + 2]
        jump[b] = abs(after.mean() - before.mean())
    total = out + ENERGY_JUMP_WEIGHT * np.clip(jump / ENERGY_JUMP_DB, 0.0, 1.0)
    return total / total.max() if total.max() > 0 else total


def pick_boundaries(nov: np.ndarray, n_bars: int) -> list[int]:
    """Bar indices where new sections start (excluding 0 and n_bars), strongest first, then sorted."""
    candidates = []
    for b in range(MIN_EDGE_SECTION_BARS, n_bars - MIN_EDGE_SECTION_BARS + 1):
        if nov[b] >= PEAK_THRESHOLD and nov[b] >= nov[b - 1] and nov[b] >= nov[b + 1]:
            candidates.append(b)
    chosen: list[int] = []
    for b in sorted(candidates, key=lambda c: -nov[c]):
        b = _snap(b, nov, n_bars)
        if b < MIN_EDGE_SECTION_BARS or b > n_bars - MIN_EDGE_SECTION_BARS:
            continue
        if all(abs(b - c) >= MIN_SECTION_BARS for c in chosen):
            chosen.append(b)
    return sorted(chosen)


def _snap(b: int, nov: np.ndarray, n_bars: int) -> int:
    grid = PHRASE_BARS * round(b / PHRASE_BARS)
    if abs(grid - b) == 1 and 0 < grid < n_bars and nov[grid] >= SNAP_KEEP * nov[b]:
        return grid
    return b


def segment_similarity(ssm: np.ndarray, bounds: list[int]) -> np.ndarray:
    """Mean similarity of bar-aligned pairs (bar k of one section vs bar k of the other)."""
    spans = list(zip(bounds[:-1], bounds[1:], strict=True))
    n = len(spans)
    out = np.eye(n)
    for i in range(n):
        for j in range(i + 1, n):
            (a, b), (c, d) = spans[i], spans[j]
            k = min(b - a, d - c)
            out[i, j] = out[j, i] = float(np.mean(ssm[np.arange(a, a + k), np.arange(c, c + k)])) if k else 0.0
    return out


def merge_short_sections(bounds: list[int], ssm: np.ndarray) -> list[int]:
    """Drop boundaries until interior sections have >= MIN_SECTION_BARS bars, edge ones >= MIN_EDGE_SECTION_BARS."""
    bounds = list(bounds)
    while len(bounds) > 2:
        lengths = np.diff(bounds)
        n = len(lengths)
        minimum = np.array(
            [MIN_EDGE_SECTION_BARS if i in (0, n - 1) else MIN_SECTION_BARS for i in range(n)], dtype=float
        )
        short = np.flatnonzero(lengths < minimum)
        if not short.size:
            break
        i = int(short[np.argmin(lengths[short])])
        if i == 0:
            del bounds[1]
        elif i == n - 1:
            del bounds[n - 1]
        else:
            sim = segment_similarity(ssm, bounds)
            del bounds[i if sim[i, i - 1] >= sim[i, i + 1] else i + 1]
    return bounds


def group_sections(bounds: list[int], sims: dict[str, np.ndarray]) -> list[int]:
    """Group id per section (0, 1, ... in order of first appearance).

    Section similarity = the lowest, over GROUP_FEATURES, of the bar-aligned similarity scaled
    so the song's typical bar pair is 0 and identical bars are 1. Average-linkage merging
    while the best link is >= GROUP_THRESHOLD (or there are more groups than letters).
    """
    scaled = np.minimum.reduce(
        [_scale_similarity(segment_similarity(sims[f], bounds), sims[f]) for f in GROUP_FEATURES]
    )
    n = len(scaled)
    clusters: list[list[int]] = [[i] for i in range(n)]
    while len(clusters) > 1:
        best, pair = -np.inf, (0, 1)
        for x in range(len(clusters)):
            for y in range(x + 1, len(clusters)):
                link = float(np.mean(scaled[np.ix_(clusters[x], clusters[y])]))
                if link > best:
                    best, pair = link, (x, y)
        if best < GROUP_THRESHOLD and len(clusters) <= MAX_GROUPS:
            break
        x, y = pair
        clusters[x] += clusters.pop(y)
    owner = {i: ci for ci, members in enumerate(clusters) for i in members}
    order: dict[int, int] = {}
    return [order.setdefault(owner[i], len(order)) for i in range(n)]


def _scale_similarity(seg_sim: np.ndarray, ssm: np.ndarray) -> np.ndarray:
    """Map similarities so that the song's typical bar pair is 0 and identical bars are 1."""
    n = len(ssm)
    if n < 2:
        return seg_sim
    typical = float(np.median(ssm[~np.eye(n, dtype=bool)]))
    return (seg_sim - typical) / max(1.0 - typical, 1e-6)


def label_sections(groups: list[int], energies: list[float], bars: list[int]) -> list[str]:
    """intro | verse | chorus | bridge | outro per section (see the module docstring).

    Back-to-back sections of the same group are one stretch of that music (e.g. an 8-bar
    fading outro split in two by its loudness drop), so they are labeled together: as one
    run, not as a group that repeats.
    """
    run_start = [i for i in range(len(groups)) if i == 0 or groups[i] != groups[i - 1]]
    run_end = [*run_start[1:], len(groups)]
    run_bars = [sum(bars[a:b]) for a, b in zip(run_start, run_end, strict=True)]
    run_energy = [
        float(np.average(energies[a:b], weights=np.maximum(bars[a:b], 1)))
        for a, b in zip(run_start, run_end, strict=True)
    ]
    run_labels = _label_runs([groups[a] for a in run_start], run_energy, run_bars)
    return [lab for lab, a, b in zip(run_labels, run_start, run_end, strict=True) for _ in range(a, b)]


def _label_runs(groups: list[int], energies: list[float], bars: list[int]) -> list[str]:
    n = len(groups)
    counts = {g: groups.count(g) for g in set(groups)}
    repeated = [g for g in counts if counts[g] > 1]
    # A group heard only as the first and last section (intro music coming back as the outro)
    # can be the chorus, but otherwise is labeled like a unique section (intro/outro).
    edge_only = {g for g in repeated if n >= 3 and [i for i in range(n) if groups[i] == g] == [0, n - 1]}
    labels = [""] * n
    if repeated:

        def score(g: int) -> float:
            members = [i for i in range(n) if groups[i] == g]
            return float(np.mean([energies[i] for i in members])) + CHORUS_REPEAT_BONUS * (counts[g] - 1)

        chorus_group = max(repeated, key=score)
        chorus_energy = float(np.mean([energies[i] for i in range(n) if groups[i] == chorus_group]))
        for i in range(n):
            if groups[i] == chorus_group:
                labels[i] = "chorus"
            elif counts[groups[i]] > 1 and groups[i] not in edge_only:
                labels[i] = "verse"
    else:
        eligible = [i for i in range(n) if bars[i] >= MIN_SECTION_BARS]
        if not eligible:
            return ["verse"] * n
        c = max(eligible, key=lambda i: energies[i])
        labels[c] = "chorus"
        chorus_energy = energies[c]

    if not labels[0] and energies[0] < chorus_energy:
        labels[0] = "intro"
    if n > 1 and not labels[-1] and energies[-1] < chorus_energy:
        labels[-1] = "outro"
    # Other unique sections: a verse if it comes before the first chorus, else a bridge.
    first_chorus = labels.index("chorus")
    return [lab or ("verse" if i < first_chorus else "bridge") for i, lab in enumerate(labels)]


def analyze_structure(
    beat_chroma: np.ndarray,
    beat_mfcc: np.ndarray,
    beat_power: np.ndarray,
    beat_onset: np.ndarray,
    beat_density: np.ndarray,
    beat_energy: np.ndarray,
    phase: int,
) -> list[tuple[int, int, str, int, float]]:
    """Sections as (startBeat, endBeat, label, group, energy). Pickup beats join the first section."""
    n_beats = beat_chroma.shape[1]
    starts = bar_starts(n_beats, phase)
    n_bars = len(starts)
    if n_bars == 0:
        energy = float(beat_energy.mean()) if n_beats else 0.0
        return [(0, n_beats, "verse", 0, energy)]

    bars = bar_features(beat_chroma, beat_mfcc, beat_power, beat_onset, beat_density, starts)
    sims = feature_similarities(bars)
    ssm = self_similarity(sims)
    nov = novelty(ssm, bars.rms_db)
    bounds = merge_short_sections([0, *pick_boundaries(nov, n_bars), n_bars], ssm)
    groups = group_sections(bounds, sims)

    beat_bounds = [0, *[int(starts[b]) for b in bounds[1:-1]], n_beats]
    energies = [float(beat_energy[a:b].mean()) for a, b in zip(beat_bounds[:-1], beat_bounds[1:], strict=True)]
    labels = label_sections(groups, energies, list(np.diff(bounds)))
    return [
        (beat_bounds[i], beat_bounds[i + 1], labels[i], groups[i], energies[i]) for i in range(len(groups))
    ]
