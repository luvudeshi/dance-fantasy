"""Procedural choreographer (pure, deterministic): an Analysis and a MoveLibrary in, a Routine out.

Layout
  * Bars start on ``analysis.downbeats`` and are 4 beats long. Pickup beats before the first
    downbeat get no moves. Every full bar is tiled by moves that never cross a bar line, except
    moves whose length is a multiple of 4 (8-beat moves): they start on a downbeat and span bars.
  * Each section *group* (same letter = same music) is choreographed once, for its longest
    occurrence, and replayed for every occurrence, so choruses match exactly. A shorter occurrence
    plays a prefix; if the cut falls inside an 8-beat move, the rest of its last bar gets a small
    patch, computed once per (group, bars) and reused.
  * Beats after the last full bar (less than a bar) get short moves when they fit, unless the
    routine already ends on a finisher (style "finale": curtsy / bow), which then holds through them.

Search: beam search over beat offsets within a group (or patch / trailing segment). Placing move
m after move p costs
      w_trans * transition(p.end -> m.start)       mean joint distance (+ root jump, + anchor mismatch)
    + (w_int * d + w_int2 * d^2) * bars(m)         d = |m.intensity - target|; target from section energy
    + w_diff  * |level(m) - level(difficulty)| * bars(m)
    + length cost                                  difficulty-dependent; easy likes 4/8-beat moves
    + w_rep   * (# of m.baseId among the last rep_window moves of the routine; the mirror partner
                 right after its twin does not count)
    + w_usage * (# of earlier uses of m.baseId in the routine, capped)
    - w_novel * fit  if m.baseId hasn't been used in the routine yet (variety). fit in [0, 1] fades with
                 the intensity mismatch, fast for moves hotter than the target (novel_over) so calmer
                 sections don't use up the chorus moves, slowly for calmer ones (novel_under)
    - w_mirror  if m is the L/R mirror of p
    + w_finisher_mid for finishers (style "finale"), - w_finale for a finisher that ends the routine
    + jitter    per-move noise from (seed, group): different seeds give different routines.
Transitions, repetition and usage see the whole routine so far, across group boundaries.

1-beat moves: hard places them anywhere; easy/normal only as an identical pair filling a 2-beat slot
(clap_clap x2 on beats 1-2 or 3-4 of a bar). The repeat pays its static and self-transition cost only.
"""

from __future__ import annotations

import bisect
import hashlib
import json
import math
import threading
import weakref
from dataclasses import dataclass
from collections.abc import Sequence
from typing import Any, NamedTuple

import numpy as np

from app.analysis import Analysis, AnalysisSection, song_from_analysis
from app.moves.types import NEUTRAL_ANCHOR, CompiledMove, MoveLibrary
from app.routine import Routine
from app.signature.pins import pin_key, pinned_sections, with_pinned_moves
from app.skeleton import JOINTS

# Bump when output for the same inputs changes (it is part of routine ids).
# v2: finishers are moves styled "finale" (v1 treated every storybook move as one).
# v3: 1-beat moves as pairs in easy/normal, novelty bonus for not-yet-used moves.
GENERATOR = "procedural-v3"
BEATS_PER_BAR = 4
MODES = ("standing", "seated")
DIFFICULTY_LEVEL = {"easy": 0, "normal": 1, "hard": 2}
INTENSITY_RANGE = {"easy": (1.0, 3.0), "normal": (1.0, 4.0), "hard": (2.0, 5.0)}
FINISHER_STYLE = "finale"  # curtsy / bow / goodbye wave; NOT every storybook move (those are the theme)
ROUND_DIGITS = 4
BEAT_MATCH_TOLERANCE = 1e-3
INF = math.inf

# Neutral standing pose (shared/README.md): what the dancer "comes from" before the first move.
NEUTRAL_POSE: dict[str, tuple[float, float]] = {
    "nose": (0.0, -1.45),
    "l_eye": (-0.07, -1.52),
    "r_eye": (0.07, -1.52),
    "l_ear": (-0.15, -1.48),
    "r_ear": (0.15, -1.48),
    "l_shoulder": (-0.45, -1.0),
    "r_shoulder": (0.45, -1.0),
    "l_elbow": (-0.52, -0.42),
    "r_elbow": (0.52, -0.42),
    "l_wrist": (-0.55, 0.12),
    "r_wrist": (0.55, 0.12),
    "l_hip": (-0.22, 0.0),
    "r_hip": (0.22, 0.0),
    "l_knee": (-0.22, 0.95),
    "r_knee": (0.22, 0.95),
    "l_ankle": (-0.22, 1.85),
    "r_ankle": (0.22, 1.85),
}


class NoEligibleMoves(ValueError):
    """The library has no moves that can fill a bar for this difficulty / mode."""


@dataclass(frozen=True)
class ChoreoConfig:
    beam_width: int = 12
    w_trans: float = 1.0
    w_root: float = 0.5  # weight of the root (hip offset) jump inside the transition distance
    w_anchor: float = 0.15  # extra transition cost when p.endAnchor != m.startAnchor
    w_int: float = 0.8
    w_int2: float = 0.3  # quadratic part: a far-off intensity (a bow in the chorus) costs much more
    w_diff: float = 0.25
    w_rep: float = 1.2
    rep_window: int = 4
    w_usage: float = 0.1
    usage_cap: int = 8
    w_novel: float = 0.4  # bonus for a baseId the routine hasn't used yet, fading out with the mismatch:
    novel_over: float = 0.5  # ... gone for moves this much more intense than the target
    novel_under: float = 1.5  # ... or this much calmer
    w_mirror: float = 0.8
    w_finale: float = 3.0
    w_finisher_mid: float = 0.4  # finishers (bows) are for the end; mild penalty elsewhere
    jitter: float = 0.5  # amplitude of the centered uniform per-move noise, per (seed, group)
    # Per-move cost by length class (1, 2, 4, 8+ beats); inf = not allowed (unless nothing else can tile a bar).
    # Easy/normal place 1-beat moves as identical pairs, so a pair pays the 1-beat cost twice.
    length_cost_easy: tuple[float, float, float, float] = (0.35, 0.6, 0.0, 0.0)
    length_cost_normal: tuple[float, float, float, float] = (0.15, 0.25, 0.0, 0.05)
    length_cost_hard: tuple[float, float, float, float] = (0.1, 0.0, 0.0, 0.1)
    min_pool_bases: int = 6  # easy also uses normal moves when fewer distinct easy baseIds are eligible

    def length_cost(self, difficulty: str) -> tuple[float, float, float, float]:
        return {"easy": self.length_cost_easy, "normal": self.length_cost_normal, "hard": self.length_cost_hard}[
            difficulty
        ]


DEFAULT_CONFIG = ChoreoConfig()


def routine_id(
    analysis_id: str,
    analysis_version: int,
    library_version: str,
    difficulty: str,
    mode: str,
    seed: int,
    generator: str = GENERATOR,
    pins: Sequence[Any] = (),
) -> str:
    """First 16 hex chars of sha256 over the canonical JSON of everything that determines a routine."""
    payload: dict[str, Any] = {
        "analysisId": analysis_id,
        "analysisVersion": analysis_version,
        "libraryVersion": library_version,
        "generator": generator,
        "difficulty": difficulty,
        "mode": mode,
        "seed": seed,
    }
    if pins:  # signature dances (app.signature); absent = the same ids as before pins existed
        payload["pinnedMoves"] = list(pins)
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------------- library preparation


def _usable_length(n: int) -> bool:
    return n >= 1 and (BEATS_PER_BAR % n == 0 or n % BEATS_PER_BAR == 0)


def _length_class(n: int) -> int:
    return {1: 0, 2: 1, 4: 2}.get(n, 3)


@dataclass(frozen=True)
class _Prepared:
    moves: tuple[CompiledMove, ...]
    length: np.ndarray  # int (M,)
    length_class: np.ndarray  # int (M,), index into ChoreoConfig.length_cost_*
    intensity: np.ndarray  # float (M,)
    level: np.ndarray  # int (M,)
    upper: np.ndarray  # bool (M,)
    finisher: np.ndarray  # bool (M,): style "finale", ends neutral
    base: np.ndarray  # int (M,), index of baseId
    n_bases: int
    partner: np.ndarray  # int (M + 1,): L/R mirror partner, -1 if none; last row = neutral start
    joint_dist: np.ndarray  # (M + 1, M) mean joint distance end(row) -> start(col); row M = neutral pose
    root_dist: np.ndarray  # (M + 1, M)
    anchor_diff: np.ndarray  # (M + 1, M) 1.0 where end anchor != start anchor
    keyframes: tuple[list[dict[str, Any]], ...]  # JSON-ready, per move


def _pose_array(pose: dict[str, Any]) -> np.ndarray:
    return np.array([pose.get(j, NEUTRAL_POSE[j]) for j in JOINTS], dtype=np.float64)


def _r(x: float) -> float:
    return round(float(x), ROUND_DIGITS)


def _keyframes_json(move: CompiledMove) -> list[dict[str, Any]]:
    out = []
    for k in move.keyframes:
        pose = {j: [_r(k.pose[j][0]), _r(k.pose[j][1])] for j in JOINTS if j in k.pose}
        out.append({"t": _r(min(1.0, max(0.0, k.t))), "pose": pose, "root": [_r(k.root[0]), _r(k.root[1])]})
    return out


def _prepare(library: MoveLibrary) -> _Prepared:
    moves = tuple(m for m in library.moves if _usable_length(m.lengthBeats) and m.keyframes)
    n = len(moves)
    base_ids = sorted({m.baseId for m in moves})
    base_index = {b: i for i, b in enumerate(base_ids)}

    starts = np.stack([_pose_array(m.startPose) for m in moves]) if n else np.zeros((0, len(JOINTS), 2))
    ends = np.stack([_pose_array(m.endPose) for m in moves] + [_pose_array(NEUTRAL_POSE)])
    root_s = np.array([m.keyframes[0].root for m in moves], dtype=np.float64).reshape(n, 2)
    root_e = np.array([m.keyframes[-1].root for m in moves] + [(0.0, 0.0)], dtype=np.float64)
    start_anchor = np.array([m.startAnchor for m in moves], dtype=object)
    end_anchor = np.array([m.endAnchor for m in moves] + [NEUTRAL_ANCHOR], dtype=object)

    by_side: dict[tuple[str, str], int] = {}
    for i, m in enumerate(moves):
        by_side.setdefault((m.baseId, m.side), i)
    flip = {"L": "R", "R": "L"}
    partner = [by_side.get((m.baseId, flip[m.side]), -1) if m.side in flip else -1 for m in moves] + [-1]

    return _Prepared(
        moves=moves,
        length=np.array([m.lengthBeats for m in moves], dtype=np.int64),
        length_class=np.array([_length_class(m.lengthBeats) for m in moves], dtype=np.int64),
        intensity=np.array([m.intensity for m in moves], dtype=np.float64),
        level=np.array([DIFFICULTY_LEVEL.get(m.difficulty, 1) for m in moves], dtype=np.int64),
        upper=np.array([bool(m.upperBodyOnly) for m in moves], dtype=bool),
        finisher=np.array([FINISHER_STYLE in m.styles and m.endAnchor == NEUTRAL_ANCHOR for m in moves], dtype=bool),
        base=np.array([base_index[m.baseId] for m in moves], dtype=np.int64),
        n_bases=len(base_ids),
        partner=np.array(partner, dtype=np.int64),
        joint_dist=np.linalg.norm(ends[:, None] - starts[None], axis=-1).mean(axis=-1),
        root_dist=np.linalg.norm(root_e[:, None] - root_s[None], axis=-1),
        anchor_diff=(end_anchor[:, None] != start_anchor[None, :]).astype(np.float64),
        keyframes=tuple(_keyframes_json(m) for m in moves),
    )


_prep_lock = threading.Lock()
_prep_cache: dict[int, tuple[weakref.ref[MoveLibrary], _Prepared]] = {}


def _prepared(library: MoveLibrary) -> _Prepared:
    """Per-library precomputation, reused while the same MoveLibrary object is alive."""
    key = id(library)
    with _prep_lock:
        hit = _prep_cache.get(key)
        if hit is not None and hit[0]() is library:
            return hit[1]
    prep = _prepare(library)
    with _prep_lock:
        for k in [k for k, (ref, _) in _prep_cache.items() if ref() is None]:
            del _prep_cache[k]
        _prep_cache[key] = (weakref.ref(library), prep)
    return prep


def _eligible(
    prep: _Prepared, difficulty: str, mode: str, cfg: ChoreoConfig, exclude: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """(pool mask, per-move length cost with inf outside the pool). ``exclude``: moves the search never picks."""
    base_mask = prep.upper.copy() if mode == "seated" else np.ones(len(prep.moves), dtype=bool)
    if exclude is not None:
        base_mask &= ~exclude
    len_cost = np.array(cfg.length_cost(difficulty), dtype=np.float64)[prep.length_class]
    len_ok = np.isfinite(len_cost)
    level_sets = {"easy": [(0,), (0, 1)], "normal": [(0, 1)], "hard": [(0, 1, 2)]}[difficulty]
    pool = base_mask
    for i, levels in enumerate(level_sets):
        pool = base_mask & np.isin(prep.level, levels)
        enough = len(set(prep.base[pool & len_ok].tolist())) >= cfg.min_pool_bases
        if enough or i == len(level_sets) - 1:
            break
    fills_bar = BEATS_PER_BAR % np.maximum(prep.length, 1) == 0
    if not (pool & len_ok & fills_bar).any():  # nothing allowed can tile a bar: allow every length
        len_cost = np.where(len_ok, len_cost, 0.0)
        len_ok = np.ones_like(len_ok)
    pool = pool & len_ok
    if not (pool & fills_bar).any():
        raise NoEligibleMoves(f"No {difficulty} moves for {mode} mode can fill a bar.")
    return pool, np.where(pool, len_cost, INF)


# --------------------------------------------------------------------------- search


def _stable_hash(text: str) -> int:
    return int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:8], "big")


class _Costs(NamedTuple):
    static: np.ndarray  # (M,) per-placement cost that doesn't depend on the routine so far
    novel: np.ndarray  # (M,) bonus while the move's baseId is still unused


class _Planner:
    """Places moves in playback order; each search sees everything placed so far as context."""

    def __init__(
        self, prep: _Prepared, difficulty: str, mode: str, seed: int, cfg: ChoreoConfig, exclude: np.ndarray | None = None
    ) -> None:
        self.prep, self.cfg, self.seed = prep, cfg, seed
        self.level = DIFFICULTY_LEVEL[difficulty]
        self.pairs = difficulty != "hard"  # 1-beat moves only as identical pairs on even beats
        self.pool, self.len_cost = _eligible(prep, difficulty, mode, cfg, exclude)
        self.trans = cfg.w_trans * (prep.joint_dist + cfg.w_root * prep.root_dist + cfg.w_anchor * prep.anchor_diff)
        self.placed: list[tuple[int, int]] = []  # (move index, start beat)
        self.usage = np.zeros(prep.n_bases)

    def static_cost(self, target: float, salt: str) -> _Costs:
        p, cfg = self.prep, self.cfg
        bars = p.length / BEATS_PER_BAR
        dev = np.abs(p.intensity - target)
        rng = np.random.default_rng([self.seed % 2**64, _stable_hash(salt)])
        jitter = (rng.random(len(p.moves)) - 0.5) * cfg.jitter
        static = (
            (cfg.w_int * dev + cfg.w_int2 * dev**2) * bars
            + cfg.w_diff * np.abs(p.level - self.level) * bars
            + cfg.w_finisher_mid * p.finisher
            + self.len_cost
            + jitter
        )
        over = np.maximum(p.intensity - target, 0.0) / cfg.novel_over
        under = np.maximum(target - p.intensity, 0.0) / cfg.novel_under
        return _Costs(static, cfg.w_novel * np.clip(1.0 - over - under, 0.0, 1.0))

    def tileable(self, beats: int) -> int:
        """Longest prefix of a partial bar of ``beats`` beats that the pool can fill."""
        lengths = set(self.prep.length[self.pool].tolist())
        if 1 in lengths and not self.pairs:
            return beats
        return 2 if beats >= 2 and lengths & {1, 2} else 0

    def search(self, total: int, costs: _Costs, finale: bool) -> list[tuple[int, int]]:
        """Best (move index, beat offset) sequence tiling ``total`` beats, offset 0 on a downbeat."""
        p, cfg = self.prep, self.cfg
        static, novel = costs
        n_moves, width, window = len(p.moves), cfg.beam_width, cfg.rep_window
        lens = p.length
        prev0 = self.placed[-1][0] if self.placed else n_moves  # row n_moves = neutral pose
        recent0 = [int(p.base[m]) for m, _ in self.placed[-window:]] if window > 0 else []
        finale_bonus = (cfg.w_finale + cfg.w_finisher_mid) * p.finisher if finale else None

        # bucket[offset] = [(cost, move indices so far)]
        buckets: dict[int, list[tuple[float, tuple[int, ...]]]] = {0: [(0.0, ())]}
        for o in range(total):
            states = buckets.pop(o, None)
            if not states:
                continue
            states.sort(key=lambda s: s[0])
            del states[width:]
            allowed = (
                self.pool
                & (o + lens <= total)
                & (((BEATS_PER_BAR % lens == 0) & (o % lens == 0)) | ((lens % BEATS_PER_BAR == 0) & (o % 4 == 0)))
            )
            if self.pairs and o % 2 == 0:  # a 1-beat pair starts on an even beat and must fit
                allowed &= (lens != 1) | (o + 2 <= total)
            elif self.pairs:  # odd beats only finish a pair (reached via a 1-beat move only)
                allowed &= lens == 1
            if not allowed.any():
                continue
            n_states = len(states)
            prev = np.array([s[1][-1] if s[1] else prev0 for s in states], dtype=np.int64)
            rep = np.zeros((n_states, p.n_bases))
            use = np.tile(self.usage, (n_states, 1))
            for i, (_, seq) in enumerate(states):
                bases = p.base[list(seq)].tolist() if seq else []
                if window > 0:
                    np.add.at(rep[i], (recent0 + bases)[-window:], 1.0)
                if bases:
                    np.add.at(use[i], bases, 1.0)
            rep_m = rep[:, p.base]
            partner = p.partner[prev]
            rows = np.flatnonzero(partner >= 0)
            rep_m[rows, partner[rows]] -= 1.0  # X_L then X_R is a pair, not a repeat
            base_cost = np.array([s[0] for s in states])
            used_m = use[:, p.base]
            cost = (
                base_cost[:, None]
                + static[None, :]
                + self.trans[prev]
                + cfg.w_rep * rep_m
                + cfg.w_usage * np.minimum(used_m, cfg.usage_cap)
                - novel[None, :] * (used_m == 0)
            )
            cost[rows, partner[rows]] -= cfg.w_mirror
            if self.pairs and o % 2 == 1:  # finish the pair: the same 1-beat move again (no rep/usage/novelty)
                cost = np.full_like(cost, INF)
                cost[np.arange(n_states), prev] = base_cost + static[prev] + self.trans[prev, prev]
            if finale_bonus is not None:
                cost -= np.where(o + lens == total, finale_bonus, 0.0)[None, :]
            for length in np.unique(lens[allowed]).tolist():
                cols = np.flatnonzero(allowed & (lens == length))
                flat = cost[:, cols].ravel()
                k = min(width, flat.size)
                best = np.argpartition(flat, k - 1)[:k] if k < flat.size else np.arange(flat.size)
                bucket = buckets.setdefault(o + length, [])
                for f in best.tolist():
                    if math.isfinite(flat[f]):
                        si, ci = divmod(f, len(cols))
                        bucket.append((float(flat[f]), states[si][1] + (int(cols[ci]),)))
        final = buckets.get(total)
        if not final:
            raise NoEligibleMoves(f"Could not tile {total} beats with the eligible moves.")
        _, seq = min(final, key=lambda s: s[0])
        out, offset = [], 0
        for m in seq:
            out.append((m, offset))
            offset += int(lens[m])
        return out

    def place(self, seq: list[tuple[int, int]], bar_starts: list[int]) -> None:
        for m, offset in seq:
            self.placed.append((m, bar_starts[offset // BEATS_PER_BAR] + offset % BEATS_PER_BAR))
            self.usage[self.prep.base[m]] += 1


def _pinned_search(planner: _Planner, pins: tuple[int, ...], total: int, costs: _Costs, finale: bool) -> list[tuple[int, int]]:
    """planner.search, with the pinned moves (whole bars) first; the search continues from the last of them."""
    head, offset = [], 0
    for m in pins:
        if offset + int(planner.prep.length[m]) <= total:
            head.append((m, offset))
            offset += int(planner.prep.length[m])
    if not head:
        return planner.search(total, costs, finale=finale)
    if offset == total:
        return head
    planner.placed.extend((m, -1) for m, _ in head)  # context only (transition, repetition), removed again
    try:
        rest = planner.search(total - offset, costs, finale=finale)
    finally:
        del planner.placed[-len(head) :]
    return head + [(m, offset + o) for m, o in rest]


# --------------------------------------------------------------------------- bars & sections


def _downbeat_indices(beats: list[float], downbeats: list[float]) -> list[int]:
    arr = np.asarray(beats, dtype=np.float64)
    out = set()
    for d in downbeats:
        i = int(np.searchsorted(arr, d - BEAT_MATCH_TOLERANCE))
        if i < len(arr) and abs(arr[i] - d) <= BEAT_MATCH_TOLERANCE:
            out.add(i)
    return sorted(out)


def _full_bars(downbeat_idx: list[int], n_beats: int) -> list[int]:
    """Start beat of every full (4-beat), non-overlapping bar."""
    starts, last_end = [], -1
    for i in downbeat_idx:
        if i >= last_end and i + BEATS_PER_BAR <= n_beats:
            starts.append(i)
            last_end = i + BEATS_PER_BAR
    return starts


def _section_of(section_starts: list[int], beat: int) -> int:
    return max(0, bisect.bisect_right(section_starts, beat) - 1)


def _target(energy: float, difficulty: str) -> float:
    lo, hi = INTENSITY_RANGE[difficulty]
    return lo + min(1.0, max(0.0, energy)) * (hi - lo)


# --------------------------------------------------------------------------- entry point


def generate_routine(
    analysis: Analysis,
    library: MoveLibrary,
    difficulty: str = "normal",
    mode: str = "standing",
    seed: int = 0,
    config: ChoreoConfig = DEFAULT_CONFIG,
    pinned: Sequence[Any] = (),
) -> Routine:
    """A beat-synced routine for ``analysis``. Same inputs (incl. seed) -> identical routine.

    ``pinned``: signature dances (app.signature.pins.PinnedMove: ``move``, ``placement``, ``tag``), each placed on
    the first downbeat of every matching section; the beam search fills everything else and never picks them.
    """
    if difficulty not in DIFFICULTY_LEVEL:
        raise ValueError(f"difficulty must be one of {sorted(DIFFICULTY_LEVEL)}")
    if mode not in MODES:
        raise ValueError(f"mode must be one of {list(MODES)}")
    n_base = len(library.moves)
    if pinned:
        library = with_pinned_moves(library, pinned)
    prep = _prepared(library)
    pin_ids = {m.id for m in library.moves[n_base:]}
    exclude = np.array([m.id in pin_ids for m in prep.moves], dtype=bool) if pinned else None
    planner = _Planner(prep, difficulty, mode, seed, config, exclude)

    beats = [float(b) for b in analysis.beats]
    n_beats = len(beats)
    downbeat_idx = _downbeat_indices(beats, analysis.downbeats)
    bars = _full_bars(downbeat_idx, n_beats)

    sections: list[AnalysisSection] = list(analysis.sections)
    order = sorted(range(len(sections)), key=lambda i: (sections[i].startBeat, i))
    starts_sorted = [sections[i].startBeat for i in order]
    sec_bars: dict[int, list[int]] = {i: [] for i in range(len(sections))}
    if sections:
        for b in bars:
            sec_bars[order[_section_of(starts_sorted, b)]].append(b)

    occurrences: dict[str, list[int]] = {}
    for i in order:
        if sec_bars[i]:
            occurrences.setdefault(sections[i].group, []).append(i)
    group_bars = {g: max(len(sec_bars[i]) for i in occ) for g, occ in occurrences.items()}
    group_target = {}  # from the bar-weighted mean energy of the group's occurrences
    for g, occ in occurrences.items():
        energy = sum(sections[i].energy * len(sec_bars[i]) for i in occ) / sum(len(sec_bars[i]) for i in occ)
        group_target[g] = _target(energy, difficulty)

    has_finisher = bool((planner.pool & prep.finisher).any())
    with_bars = [i for i in order if sec_bars[i]]
    finale_group = None
    if has_finisher and with_bars and len(occurrences[sections[with_bars[-1]].group]) == 1:
        finale_group = sections[with_bars[-1]].group

    pins_at: dict[int, tuple[int, ...]] = {}  # section -> pinned move indices, placed from its first downbeat
    if pinned:
        index = {m.id: j for j, m in enumerate(prep.moves)}
        info = [(s.label, s.group, s.energy, len(sec_bars[j])) for j, s in enumerate(sections)]
        for pin in pinned:
            for j in pinned_sections(info, pin.placement):
                pins_at[j] = pins_at.get(j, ()) + (index[pin.move.id],)

    rows: dict[int, dict[str, Any]] = {}
    statics: dict[str, _Costs] = {}
    plans: dict[tuple[str, tuple[int, ...]], list[tuple[int, int]]] = {}
    variants: dict[tuple[str, int, tuple[int, ...]], list[tuple[int, int]]] = {}
    for i in order:
        sec = sections[i]
        first = len(planner.placed)
        occ_bars = sec_bars[i]
        if occ_bars:
            g, k, pins = sec.group, len(occ_bars), pins_at.get(i, ())
            if g not in statics:
                statics[g] = planner.static_cost(group_target[g], f"group:{g}")
            if (g, pins) not in plans:
                plans[(g, pins)] = _pinned_search(planner, pins, BEATS_PER_BAR * group_bars[g], statics[g], g == finale_group)
            if (g, k, pins) in variants:
                planner.place(variants[(g, k, pins)], occ_bars)
            else:  # first occurrence with this many bars: play the plan's prefix, patch a cut 8-beat move
                prefix = [(m, o) for m, o in plans[(g, pins)] if o + prep.length[m] <= BEATS_PER_BAR * k]
                planner.place(prefix, occ_bars)
                covered = sum(int(prep.length[m]) for m, _ in prefix)
                patch: list[tuple[int, int]] = []
                if covered < BEATS_PER_BAR * k:
                    rest = planner.search(BEATS_PER_BAR * k - covered, statics[g], finale=False)
                    patch = [(m, covered + o) for m, o in rest]
                    planner.place(patch, occ_bars)
                variants[(g, k, pins)] = prefix + patch
        rows[i] = {
            "section": i,
            "group": sec.group,
            "label": sec.label,
            "bars": len(occ_bars),
            "targetIntensity": round(group_target[sec.group], 2) if occ_bars else None,
            "firstMove": first if len(planner.placed) > first else None,
            "lastMove": len(planner.placed) - 1 if len(planner.placed) > first else None,
        }

    # Beats after the last full bar: short moves, unless the routine already ends on a finisher.
    if bars:
        tail = bars[-1] + BEATS_PER_BAR
        ends_on_finisher = bool(planner.placed) and bool(prep.finisher[planner.placed[-1][0]])
        fill = planner.tileable(n_beats - tail) if 0 < n_beats - tail < BEATS_PER_BAR else 0
        if fill and tail in downbeat_idx and not ends_on_finisher:
            si = order[_section_of(starts_sorted, tail)] if sections else None
            energy = sections[si].energy if si is not None else 0.5
            first = len(planner.placed)
            static = planner.static_cost(_target(energy, difficulty), "trailing")
            planner.place(planner.search(fill, static, finale=has_finisher), [tail])
            if si is not None:
                row = rows[si]
                row["firstMove"] = first if row["firstMove"] is None else row["firstMove"]
                row["lastMove"] = len(planner.placed) - 1

    period = float(np.median(np.diff(beats))) if n_beats >= 2 else 0.5

    def beat_time(i: int) -> float:
        return beats[i] if i < n_beats else round(beats[-1] + (i - n_beats + 1) * period, ROUND_DIGITS)

    moves_out = []
    for m_idx, start in planner.placed:
        m = prep.moves[m_idx]
        moves_out.append(
            {
                "id": m.id,
                "name": m.name,
                "startBeat": start,
                "lengthBeats": m.lengthBeats,
                "startTime": beats[start],
                "endTime": beat_time(start + m.lengthBeats),
                "intensity": min(5, max(1, int(m.intensity))),
                "scoredJoints": list(m.scoredJoints),
                "keyframes": prep.keyframes[m_idx],
            }
        )
        if m.id in pin_ids:
            moves_out[-1]["signatureDance"] = next(p.tag for p in pinned if p.move.id == m.id)

    rid = routine_id(analysis.id, analysis.analysisVersion, library.version, difficulty, mode, seed, pins=pin_key(pinned))
    return Routine.model_validate(
        {
            "version": 1,
            "song": song_from_analysis(analysis),
            "difficulty": difficulty,
            "mode": mode,
            "seed": seed,
            "moves": moves_out,
            "meta": {
                "routineId": rid,
                "generator": GENERATOR,
                "libraryVersion": library.version,
                "analysisId": analysis.id,
                "analysisVersion": analysis.analysisVersion,
                "sectionPlan": [rows[i] for i in range(len(sections))],
                **({"pinnedMoves": [{"moveId": p.move.id, "placement": p.placement} for p in pinned]} if pinned else {}),
            },
        }
    )
