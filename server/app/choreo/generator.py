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

Move sources (``move_source``): "classic" uses the angle-based library moves only (exactly the v3 search);
"aist" prefers the real-dancer clips (app.moves.clips) and keeps library moves only as a fallback, at
w_off_source per bar, except the storybook finisher that ends the routine; "mix" uses both, with clips
nudged by mix_aist_bias per bar so neither source crowds out the other. Clips have free anchors, so the
transition distance *is* the motion-graph edge weight: transitions into or out of a clip cost
w_free_trans x the distance, and an edge longer than trans_cap (mean joint distance + w_root x root jump,
body units) is taken only when a state has no other way on, at an extra w_over_cap. A search costs the edge
into its segment and every edge inside it, but a group plan is replayed after other sections than the one
it was searched after, and its end (or a shorter occurrence's cut) leads into sections it never saw. So with
clips in the pool the plan also pays those section-boundary edges when the move on the other side is already
settled (``_Planner.exit_cost`` / ``entry_cost``): into the opening move of a section that replays a planned
group (a chorus coming back), out of the settled last move of the section before a later occurrence; and an
end pose with no edge under the cap (a dead end) costs w_over_cap where an unknown section follows. The
(moves + neutral) x moves distance matrices are computed once per library and sliced to the eligible pool
per call, so the search only ever looks at eligible moves.
"""

from __future__ import annotations

import bisect
import hashlib
import json
import math
import threading
import weakref
from dataclasses import dataclass
from typing import Any, NamedTuple

import numpy as np

from app.analysis import Analysis, AnalysisSection, song_from_analysis
from app.moves.clips import FREE_ANCHOR
from app.moves.types import NEUTRAL_ANCHOR, CompiledMove, MoveLibrary
from app.routine import Routine
from app.skeleton import JOINTS

# Bump when output for the same inputs changes (it is part of routine ids).
# v2: finishers are moves styled "finale" (v1 treated every storybook move as one).
# v3: 1-beat moves as pairs in easy/normal, novelty bonus for not-yet-used moves.
# v4: move sources (classic / real-dancer clips / mix), capped clip transitions; moveSource in routine ids.
# v5: with clips in the pool, group plans also cost the section-boundary edges around their replays
#     (exit / entry / dead-end costs); classic routines are unchanged.
GENERATOR = "procedural-v5"
MOVE_SOURCES = ("classic", "aist", "mix")
DEFAULT_MOVE_SOURCE = "classic"  # what the API uses when a request doesn't say
AIST_CREDIT = "Real-dancer moves: AIST++ (CC BY 4.0) · AIST Dance Video Database"
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
    # Real-dancer clips (free anchors): see "Move sources" above.
    w_free_trans: float = 2.0  # transition weight multiplier for an edge into or out of a clip
    trans_cap: float = 0.35  # longest clip edge taken freely (mean joint distance + w_root * root jump)
    w_over_cap: float = 3.0  # extra cost of a longer edge, taken only when a state has nothing shorter
    w_off_source: float = 2.5  # per bar: a library move in an "aist" routine (fallback only)
    mix_aist_bias: float = 0.25  # per bar: bonus for clips in a "mix" routine (~half the moves when standing)

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
    move_source: str = DEFAULT_MOVE_SOURCE,
    generator: str = GENERATOR,
) -> str:
    """First 16 hex chars of sha256 over the canonical JSON of everything that determines a routine."""
    payload = {
        "analysisId": analysis_id,
        "analysisVersion": analysis_version,
        "libraryVersion": library_version,
        "generator": generator,
        "difficulty": difficulty,
        "mode": mode,
        "seed": seed,
        "moveSource": move_source,
    }
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
    anchor_diff: np.ndarray  # (M + 1, M) 1.0 where end anchor != start anchor (a free anchor matches any)
    keyframes: tuple[list[dict[str, Any]], ...]  # JSON-ready, per move
    aist: np.ndarray  # bool (M,): a real-dancer clip (source "aist")
    free: np.ndarray  # bool (M + 1, 2): free start / free end anchor; last row = neutral start (not free)


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


def _mean_joint_distance(ends: np.ndarray, starts: np.ndarray) -> np.ndarray:
    """(E, S) mean over joints of |end_j - start_j|, one joint at a time (no (E, S, J, 2) temporary)."""
    out = np.zeros((len(ends), len(starts)))
    for j in range(ends.shape[1]):
        out += np.hypot(ends[:, None, j, 0] - starts[None, :, j, 0], ends[:, None, j, 1] - starts[None, :, j, 1])
    return out / max(1, ends.shape[1])


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
    free_start = start_anchor == FREE_ANCHOR
    free_end = end_anchor == FREE_ANCHOR

    by_side: dict[tuple[str, str], int] = {}
    index = {m.id: i for i, m in enumerate(moves)}
    for i, m in enumerate(moves):
        by_side.setdefault((m.baseId, m.side), i)
    flip = {"L": "R", "R": "L"}
    partner = [by_side.get((m.baseId, flip[m.side]), -1) if m.side in flip else -1 for m in moves] + [-1]
    for i, m in enumerate(moves):  # side-"both" mirror twins (real-dancer clips <id> / <id>_m) pair up too
        if m.side == "both" and m.mirrorOf is not None and m.mirrorOf in index:
            partner[i], partner[index[m.mirrorOf]] = index[m.mirrorOf], i

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
        joint_dist=_mean_joint_distance(ends, starts),
        root_dist=np.hypot(root_e[:, None, 0] - root_s[None, :, 0], root_e[:, None, 1] - root_s[None, :, 1]),
        anchor_diff=(
            (end_anchor[:, None] != start_anchor[None, :]) & ~free_end[:, None] & ~free_start[None, :]
        ).astype(np.float64),
        keyframes=tuple(_keyframes_json(m) for m in moves),
        aist=np.array([m.source == "aist" for m in moves], dtype=bool),
        free=np.stack([np.append(free_start, False), free_end], axis=1).astype(bool),
    )


def _subset(prep: _Prepared, idx: np.ndarray) -> _Prepared:
    """The prepared arrays restricted to moves ``idx`` (in order); the neutral row stays last."""
    rows = np.append(idx, len(prep.moves))
    local = np.full(len(prep.moves) + 1, -1, dtype=np.int64)
    local[idx] = np.arange(len(idx))
    partner = prep.partner[rows]
    partner = np.where(partner >= 0, local[partner], -1)
    return _Prepared(
        moves=tuple(prep.moves[i] for i in idx),
        length=prep.length[idx],
        length_class=prep.length_class[idx],
        intensity=prep.intensity[idx],
        level=prep.level[idx],
        upper=prep.upper[idx],
        finisher=prep.finisher[idx],
        base=prep.base[idx],
        n_bases=prep.n_bases,
        partner=partner,
        joint_dist=prep.joint_dist[np.ix_(rows, idx)],
        root_dist=prep.root_dist[np.ix_(rows, idx)],
        anchor_diff=prep.anchor_diff[np.ix_(rows, idx)],
        keyframes=tuple(prep.keyframes[i] for i in idx),
        aist=prep.aist[idx],
        free=np.concatenate([prep.free[idx], prep.free[-1:]]),
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
    prep: _Prepared, difficulty: str, mode: str, cfg: ChoreoConfig, move_source: str = DEFAULT_MOVE_SOURCE
) -> tuple[np.ndarray, np.ndarray]:
    """(pool mask, per-move length cost with inf outside the pool).

    "classic" leaves the clips out; "aist" keeps library moves in the pool as a (penalized) fallback, so the
    difficulty fallback below counts only the clips ("preferred") when deciding whether a level set is enough.
    """
    source_mask = ~prep.aist if move_source == "classic" else np.ones(len(prep.moves), dtype=bool)
    preferred = prep.aist if move_source == "aist" else source_mask
    base_mask = (prep.upper.copy() if mode == "seated" else np.ones(len(prep.moves), dtype=bool)) & source_mask
    len_cost = np.array(cfg.length_cost(difficulty), dtype=np.float64)[prep.length_class]
    len_ok = np.isfinite(len_cost)
    level_sets = {"easy": [(0,), (0, 1)], "normal": [(0, 1)], "hard": [(0, 1, 2)]}[difficulty]
    pool = base_mask
    for i, levels in enumerate(level_sets):
        pool = base_mask & np.isin(prep.level, levels)
        enough = len(set(prep.base[pool & len_ok & preferred].tolist())) >= cfg.min_pool_bases
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
    """Places moves in playback order; each search sees everything placed so far as context.

    Works on the eligible pool only: ``self.prep`` is the library's _Prepared sliced to the pool (indices in
    ``placed`` are pool-local; ``self.idx`` maps them back to the library).
    """

    def __init__(
        self, full: _Prepared, difficulty: str, mode: str, seed: int, cfg: ChoreoConfig, move_source: str
    ) -> None:
        self.cfg, self.seed = cfg, seed
        self.level = DIFFICULTY_LEVEL[difficulty]
        self.pairs = difficulty != "hard"  # 1-beat moves only as identical pairs on even beats
        pool, len_cost = _eligible(full, difficulty, mode, cfg, move_source)
        self.n_full = len(full.moves)
        self.idx = np.flatnonzero(pool)
        self.prep = prep = _subset(full, self.idx)
        self.pool = np.ones(len(self.idx), dtype=bool)
        self.len_cost = len_cost[self.idx]
        bars = prep.length / BEATS_PER_BAR
        if move_source == "aist":
            self.source_cost = cfg.w_off_source * bars * ~prep.aist
        elif move_source == "mix":
            self.source_cost = -cfg.mix_aist_bias * bars * prep.aist
        else:
            self.source_cost = np.zeros(len(self.idx))
        # The finisher that ends an "aist" routine is the one library move that pays no off-source cost.
        self.finale_bonus = (cfg.w_finale + cfg.w_finisher_mid + np.maximum(self.source_cost, 0.0)) * prep.finisher
        # Motion-graph edges: end of row (pool moves + neutral) -> start of column (pool moves).
        dist = prep.joint_dist + cfg.w_root * prep.root_dist
        free_edge = prep.free[:, 1][:, None] | prep.free[:-1, 0][None, :]
        self.trans = cfg.w_trans * (np.where(free_edge, cfg.w_free_trans * dist, dist) + cfg.w_anchor * prep.anchor_diff)
        self.over = free_edge & (dist > cfg.trans_cap)  # clip edges taken only when nothing shorter fits
        self.capped = bool(self.over.any())
        # Section-boundary edges (exit_cost / entry_cost), only with clips in the pool: classic stays the v3 search.
        self.lookahead = bool(prep.free[:-1].any())
        self.lead_in = self.trans[:-1] + cfg.w_over_cap * self.over[:-1]  # rows: pool moves (never neutral)
        self.placed: list[tuple[int, int]] = []  # (pool-local move index, start beat)
        self.usage = np.zeros(prep.n_bases)

    def static_cost(self, target: float, salt: str) -> _Costs:
        p, cfg = self.prep, self.cfg
        bars = p.length / BEATS_PER_BAR
        dev = np.abs(p.intensity - target)
        rng = np.random.default_rng([self.seed % 2**64, _stable_hash(salt)])
        # Drawn for the whole library, then sliced: a move's jitter doesn't depend on which others are eligible.
        jitter = (rng.random(self.n_full)[self.idx] - 0.5) * cfg.jitter
        static = (
            (cfg.w_int * dev + cfg.w_int2 * dev**2) * bars
            + cfg.w_diff * np.abs(p.level - self.level) * bars
            + cfg.w_finisher_mid * p.finisher
            + self.len_cost
            + self.source_cost
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

    def exit_cost(self, followed: bool, then: int | None = None, into: np.ndarray | None = None) -> np.ndarray | None:
        """Extra cost of a move that ends a section, for the edge out of it (None: nothing to add).

        Only with clips in the pool (classic routines stay the v3 search) and when more moves follow
        (``followed``): the edge into ``then`` (the move the next section opens with, when that is already
        known), else w_over_cap if the move's end pose is a dead end: every edge from it into the moves that
        can come next (``into``, a pool mask; default all) is over the cap.
        """
        if not (followed and self.lookahead):
            return None
        if then is not None:
            return self.lead_in[:, then]
        over = self.over[:-1] if into is None else self.over[:-1][:, into]
        return self.cfg.w_over_cap * (over.all(axis=1) if over.shape[1] else np.zeros(len(over)))

    def entry_cost(self, before: list[int]) -> np.ndarray | None:
        """Extra cost of the opening move of a group plan, for the edges into it from the moves that will
        precede its later occurrences (``before``, already known): only with clips in the pool."""
        if not (before and self.lookahead):
            return None
        return self.lead_in[before].sum(axis=0)

    def search(
        self,
        total: int,
        costs: _Costs,
        ends: dict[int, np.ndarray] | None = None,
        entry: np.ndarray | None = None,
    ) -> list[tuple[int, int]]:
        """Best (move index, beat offset) sequence tiling ``total`` beats, offset 0 on a downbeat.

        ``ends[offset]`` is added for a move that ends exactly at that offset (a section boundary: the end of
        the segment, or where a shorter occurrence of the group stops), ``entry`` for the move at offset 0.
        The search itself costs the edge from the routine so far into the segment and every edge inside it.
        """
        p, cfg = self.prep, self.cfg
        static, novel = costs
        n_moves, width, window = len(p.moves), cfg.beam_width, cfg.rep_window
        lens = p.length
        prev0 = self.placed[-1][0] if self.placed else n_moves  # row n_moves = neutral pose
        recent0 = [int(p.base[m]) for m, _ in self.placed[-window:]] if window > 0 else []

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
            cost0 = (
                base_cost[:, None]
                + static[None, :]
                + cfg.w_rep * rep_m
                + cfg.w_usage * np.minimum(used_m, cfg.usage_cap)
                - novel[None, :] * (used_m == 0)
            )
            cost0[rows, partner[rows]] -= cfg.w_mirror
            trans = self.trans[prev]
            if self.capped:  # clip edges over the cap: only for states with no other way on
                over = self.over[prev]
                cost = cost0 + np.where(over, INF, trans)
                stuck = ~np.isfinite(cost[:, allowed]).any(axis=1)
                if stuck.any():
                    cost[stuck] = cost0[stuck] + trans[stuck] + cfg.w_over_cap * over[stuck]
            else:
                cost = cost0 + trans
            if self.pairs and o % 2 == 1:  # finish the pair: the same 1-beat move again (no rep/usage/novelty)
                cost = np.full_like(cost, INF)
                cost[np.arange(n_states), prev] = base_cost + static[prev] + self.trans[prev, prev]
            if o == 0 and entry is not None:
                cost += entry[None, :]
            for offset, extra in (ends or {}).items():
                cost += np.where(o + lens == offset, extra, 0.0)[None, :]
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
    move_source: str = DEFAULT_MOVE_SOURCE,
) -> Routine:
    """A beat-synced routine for ``analysis``. Same inputs (incl. seed) -> identical routine."""
    if difficulty not in DIFFICULTY_LEVEL:
        raise ValueError(f"difficulty must be one of {sorted(DIFFICULTY_LEVEL)}")
    if mode not in MODES:
        raise ValueError(f"mode must be one of {list(MODES)}")
    if move_source not in MOVE_SOURCES:
        raise ValueError(f"move_source must be one of {list(MOVE_SOURCES)}")
    planner = _Planner(_prepared(library), difficulty, mode, seed, config, move_source)
    prep = planner.prep  # the eligible pool; planner.placed indexes it

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

    rows: dict[int, dict[str, Any]] = {}
    statics: dict[str, _Costs] = {}
    plans: dict[str, list[tuple[int, int]]] = {}
    variants: dict[tuple[str, int], list[tuple[int, int]]] = {}

    def prefix_of(g: str, k: int) -> list[tuple[int, int]]:
        return [(m, o) for m, o in plans[g] if o + prep.length[m] <= BEATS_PER_BAR * k]

    def opening_move(j: int) -> int | None:
        """The move section ``j`` will open with, when its group is already planned (else None)."""
        g, k = sections[j].group, len(sec_bars[j])
        known = variants.get((g, k)) or (prefix_of(g, k) if g in plans else None)
        return known[0][0] if known else None

    def closing_move(j: int) -> int | None:
        """The move section ``j`` will end on, when that is already settled (else None: a patch still to search)."""
        g, k = sections[j].group, len(sec_bars[j])
        if (g, k) in variants:
            return variants[(g, k)][-1][0]
        prefix = prefix_of(g, k) if g in plans else []
        return prefix[-1][0] if prefix and sum(int(prep.length[m]) for m, _ in prefix) == BEATS_PER_BAR * k else None

    # Beats after the last full bar (less than a bar) get short moves when they fit; see the end.
    tail = bars[-1] + BEATS_PER_BAR if bars else n_beats
    fill = planner.tileable(n_beats - tail) if 0 < n_beats - tail < BEATS_PER_BAR and tail in downbeat_idx else 0
    next_of: dict[int, int | None] = dict(zip(with_bars, [*with_bars[1:], None]))  # the section that plays next
    prev_of: dict[int, int | None] = dict(zip(with_bars, [None, *with_bars[:-1]]))

    def exit_cost(j: int) -> np.ndarray | None:
        """planner.exit_cost for the move that ends section ``j``: the next section or the tail follows."""
        nxt = next_of[j]
        if nxt is not None:
            return planner.exit_cost(True, opening_move(nxt))
        return planner.exit_cost(fill > 0, into=(prep.length <= fill) & (BEATS_PER_BAR % prep.length == 0))

    def ends_at(*pairs: tuple[int, np.ndarray | None]) -> dict[int, np.ndarray] | None:
        out: dict[int, np.ndarray] = {}
        for offset, extra in pairs:
            if extra is not None:
                out[offset] = out[offset] + extra if offset in out else extra
        return out or None

    for i in order:
        sec = sections[i]
        first = len(planner.placed)
        occ_bars = sec_bars[i]
        if occ_bars:
            g, k = sec.group, len(occ_bars)
            if g not in plans:
                statics[g] = planner.static_cost(group_target[g], f"group:{g}")
                total = BEATS_PER_BAR * group_bars[g]
                # Section boundaries the plan lays out: where each occurrence stops (the edge out of it, when
                # costed) and, for the later occurrences, the edges in from moves that are already settled.
                ends = ends_at(
                    (total, -planner.finale_bonus if g == finale_group else None),
                    *((BEATS_PER_BAR * len(sec_bars[j]), exit_cost(j)) for j in occurrences[g]),
                )
                before = [prev_of[j] for j in occurrences[g][1:]]
                entry = planner.entry_cost([m for j in before if j is not None and (m := closing_move(j)) is not None])
                plans[g] = planner.search(total, statics[g], ends, entry)
            if (g, k) in variants:
                planner.place(variants[(g, k)], occ_bars)
            else:  # first occurrence with this many bars: play the plan's prefix, patch a cut 8-beat move
                prefix = prefix_of(g, k)
                planner.place(prefix, occ_bars)
                covered = sum(int(prep.length[m]) for m, _ in prefix)
                patch: list[tuple[int, int]] = []
                if covered < BEATS_PER_BAR * k:
                    rest_beats = BEATS_PER_BAR * k - covered
                    rest = planner.search(rest_beats, statics[g], ends_at((rest_beats, exit_cost(i))))
                    patch = [(m, covered + o) for m, o in rest]
                    planner.place(patch, occ_bars)
                variants[(g, k)] = prefix + patch
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
        ends_on_finisher = bool(planner.placed) and bool(prep.finisher[planner.placed[-1][0]])
        if fill and not ends_on_finisher:
            si = order[_section_of(starts_sorted, tail)] if sections else None
            energy = sections[si].energy if si is not None else 0.5
            first = len(planner.placed)
            static = planner.static_cost(_target(energy, difficulty), "trailing")
            finale = ends_at((fill, -planner.finale_bonus if has_finisher else None))
            planner.place(planner.search(fill, static, finale), [tail])
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

    rid = routine_id(analysis.id, analysis.analysisVersion, library.version, difficulty, mode, seed, move_source)
    n_aist = sum(1 for m_idx, _ in planner.placed if prep.aist[m_idx])
    sources: dict[str, Any] = {"moveSource": move_source, "aistMoves": n_aist}
    if n_aist:
        sources["credit"] = library.attribution or AIST_CREDIT
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
                **sources,
                "sectionPlan": [rows[i] for i in range(len(sections))],
            },
        }
    )
