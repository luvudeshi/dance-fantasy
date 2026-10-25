"""Pick a diverse, well-connected, high-quality subset of the kept windows per genre (deterministic).

Greedy farthest-point sampling on a pose-sequence feature (9 poses at t = k/8 plus the root, compared
mirror-invariantly, since the loader adds every clip's mirror image), separately for 8- and 4-beat clips,
with bonuses for
  * quality: a calm start (start between hits), held poses on the beats, low jitter, steady facing;
  * connectivity: the clip's end pose is close to many clips' start poses (and its start to many ends), so
    the motion graph has cheap transitions;
  * intensity coverage: intensity levels the genre has but the selection lacks.
Near-duplicates (the same choreography danced to another song or by another dancer) are skipped, windows
of one sequence never overlap in time, and each choreography contributes a limited number of clips.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Sequence as Seq
from dataclasses import dataclass

import numpy as np

from app.skeleton import JOINTS, MIRROR
from scripts.aist.segment import Candidate

MIRROR_IDX = np.array([JOINTS.index(MIRROR[j]) for j in JOINTS])
W_ROOT = 0.5  # weight of the root offset in a transition distance (same as app.choreo ChoreoConfig.w_root)
FEATURE_TIMES = np.linspace(0.0, 1.0, 9)


@dataclass(frozen=True)
class SelectConfig:
    per_genre: int = 25
    share_8: float = 0.48  # fraction of 8-beat clips
    w_quality: float = 0.35
    w_connect: float = 1.0
    w_intensity: float = 0.35
    dup_frac: float = 0.3  # near-duplicate: feature distance below this fraction of the pool's median distance
    cap_basic: int = 3  # clips per basic-dance choreography (repeated 8-counts)
    cap_advanced: int = 6  # clips per advanced choreography
    knn: int = 10  # neighbours averaged for the connectivity score
    w_anchor_conn: float = 0.5  # weight of the distance to the classic anchor poses inside the connectivity score


def mirror_pose(pose: np.ndarray) -> np.ndarray:
    out = pose[..., MIRROR_IDX, :].copy()
    out[..., 0] *= -1.0
    return out


def mirror_root(root: np.ndarray) -> np.ndarray:
    out = np.array(root, dtype=np.float64, copy=True)
    out[..., 0] *= -1.0
    return out


def transition_distance(end_pose: np.ndarray, end_root: np.ndarray, start_pose: np.ndarray, start_root: np.ndarray) -> np.ndarray:
    """Generator-style transition cost: mean joint distance + W_ROOT * root distance (broadcasts)."""
    joints = np.linalg.norm(end_pose - start_pose, axis=-1).mean(axis=-1)
    return joints + W_ROOT * np.linalg.norm(end_root - start_root, axis=-1)


def resample(c: Candidate, times: np.ndarray = FEATURE_TIMES) -> tuple[np.ndarray, np.ndarray]:
    pose = np.stack([np.stack([np.interp(times, c.times, c.pose[:, j, d]) for d in (0, 1)], axis=-1) for j in range(len(JOINTS))], axis=1)
    root = np.stack([np.interp(times, c.times, c.root[:, d]) for d in (0, 1)], axis=-1)
    return pose, root


def features(cands: Seq[Candidate]) -> tuple[np.ndarray, np.ndarray]:
    """(M, 9, 18, 2) pose-sequence features (root as an 18th point) and their mirror images."""
    feats, mirrors = [], []
    for c in cands:
        pose, root = resample(c)
        feats.append(np.concatenate([pose, root[:, None, :]], axis=1))
        mirrors.append(np.concatenate([mirror_pose(pose), mirror_root(root)[:, None, :]], axis=1))
    return np.array(feats), np.array(mirrors)


def feature_distance(f: np.ndarray, g: np.ndarray, g_mirror: np.ndarray) -> np.ndarray:
    """Mirror-invariant mean point distance between features f (M, ...) and one feature g."""
    d = np.linalg.norm(f - g, axis=-1).mean(axis=(-1, -2))
    dm = np.linalg.norm(f - g_mirror, axis=-1).mean(axis=(-1, -2))
    return np.minimum(d, dm)


def endpoints(cands: Seq[Candidate]) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    sp = np.array([c.pose[0] for c in cands])
    sr = np.array([c.root[0] for c in cands])
    ep = np.array([c.pose[-1] for c in cands])
    er = np.array([c.root[-1] for c in cands])
    return sp, sr, ep, er


def connectivity(cands: Seq[Candidate], k: int = 10) -> np.ndarray:
    """Per window: mean of its k cheapest outgoing (end -> start) and incoming transitions within the pool
    (mirror images included, the window itself excluded). Lower = better connected."""
    sp, sr, ep, er = endpoints(cands)
    sp2 = np.concatenate([sp, mirror_pose(sp)])
    sr2 = np.concatenate([sr, mirror_root(sr)])
    ep2 = np.concatenate([ep, mirror_pose(ep)])
    er2 = np.concatenate([er, mirror_root(er)])
    m = len(cands)
    out = np.zeros(m)
    k = max(1, min(k, 2 * m - 2))
    for i in range(m):
        d_out = transition_distance(ep[i], er[i], sp2, sr2)
        d_in = transition_distance(ep2, er2, sp[i], sr[i])
        d_out[[i, i + m]] = np.inf
        d_in[[i, i + m]] = np.inf
        out[i] = 0.5 * (np.sort(d_out)[:k].mean() + np.sort(d_in)[:k].mean())
    return out


def anchor_connectivity(cands: Seq[Candidate]) -> np.ndarray:
    """Per window: how close its end is to the nearest classic anchor pose (app.moves.anchors), and the
    nearest anchor to its start, averaged. Low = the clip chains well with the classic moves ("Mix")."""
    from app.moves.anchors import ANCHORS, anchor_pose

    poses, roots = [], []
    for name in ANCHORS:
        pose, root = anchor_pose(name)
        poses.append([pose[j] for j in JOINTS])
        roots.append(root)
    ap, ar = np.array(poses), np.array(roots)
    sp, sr, ep, er = endpoints(cands)
    to_anchor = transition_distance(ep[:, None], er[:, None], ap[None], ar[None]).min(axis=1)
    from_anchor = transition_distance(ap[None], ar[None], sp[:, None], sr[:, None]).min(axis=1)
    return 0.5 * (to_anchor + from_anchor)


def diversity(cands: Seq[Candidate]) -> float:
    """Median distance from each clip to its most similar other clip (mirror-invariant feature distance)."""
    if len(cands) < 2:
        return 0.0
    f, m = features(cands)
    out = []
    for i in range(len(cands)):
        d = feature_distance(f, f[i], m[i])
        d[i] = np.inf
        out.append(d.min())
    return float(np.median(out))


def quality(cands: Seq[Candidate]) -> np.ndarray:
    """0..1, higher = better: calm start, held poses on the beats, clean data, steady facing, little travel."""
    def rank(x: np.ndarray) -> np.ndarray:
        order = np.argsort(x, kind="stable")
        r = np.empty(len(x))
        r[order] = np.arange(len(x))
        return r / max(len(x) - 1, 1)

    cols = [
        (np.array([c.m.get("start_speed", 1.0) for c in cands]), 0.3),
        (np.array([c.m.get("beat_speed", 1.0) for c in cands]), 0.3),
        (np.array([c.m.get("jitter", 0.0) for c in cands]), 0.1),
        (np.array([c.m.get("facing_dev", 0.0) for c in cands]), 0.15),
        (np.array([c.m.get("travel", 0.0) for c in cands]), 0.15),
    ]
    bad = sum(w * rank(x) for x, w in cols) / sum(w for _, w in cols)
    return 1.0 - bad


def _overlaps(a: Candidate, b: Candidate) -> bool:
    return a.seq == b.seq and a.t0 < b.end_t - 1e-6 and b.t0 < a.end_t - 1e-6


def select_genre(cands: Seq[Candidate], cfg: SelectConfig, conn: np.ndarray | None = None) -> list[Candidate]:
    """Deterministic greedy selection of ~cfg.per_genre windows from one genre's kept windows."""
    if not cands:
        return []
    order = sorted(range(len(cands)), key=lambda i: (cands[i].seq, cands[i].length, cands[i].start_beat))
    pool = [cands[i] for i in order]
    conn = np.asarray(conn)[order] if conn is not None else connectivity(pool, cfg.knn)
    q = quality(pool)
    cn = (conn - conn.min()) / max(float(np.ptp(conn)), 1e-9)
    feats, mirrors = features(pool)
    # scale: median distance between a sample of pairs
    idx = np.arange(0, len(pool), max(1, len(pool) // 60))
    sample = [feature_distance(feats[idx], feats[i], mirrors[i]) for i in idx]
    scale = float(np.median(np.concatenate(sample)[np.concatenate(sample) > 0])) if len(idx) > 1 else 1.0
    dup = cfg.dup_frac * scale
    n8 = int(round(cfg.per_genre * cfg.share_8))
    quotas = {8: n8, 4: cfg.per_genre - n8}
    chosen: list[int] = []
    group_count: Counter[str] = Counter()
    for length in (8, 4):
        if length == 4:  # 8-beat slots the genre could not fill go to 4-beat clips
            quotas[4] = cfg.per_genre - len(chosen)
        ids = [i for i, c in enumerate(pool) if c.length == length]
        if not ids:
            continue
        levels = Counter(pool[i].tags.get("intensity", 3) for i in ids)
        target = quotas[length] / max(len(levels), 1)
        have: Counter[int] = Counter()
        mind = np.full(len(pool), np.inf)
        for j in chosen:  # distance to clips picked for the other length
            mind = np.minimum(mind, feature_distance(feats, feats[j], mirrors[j]))
        alive = np.zeros(len(pool), dtype=bool)
        alive[ids] = True
        picked = 0
        while picked < quotas[length] and alive.any():
            div = np.where(np.isfinite(mind), np.minimum(mind / scale, 1.5), 1.5)
            need = np.array([max(0.0, target - have[pool[i].tags.get("intensity", 3)]) / max(target, 1e-9) for i in range(len(pool))])
            obj = div + cfg.w_quality * q - cfg.w_connect * cn + cfg.w_intensity * need
            obj[~alive] = -np.inf
            i = int(np.argmax(obj))
            c = pool[i]
            alive[i] = False
            cap = cfg.cap_basic if c.info.get("sit") == "BM" else cfg.cap_advanced
            if mind[i] < dup or group_count[c.group] >= cap or any(_overlaps(c, pool[j]) for j in chosen):
                continue
            chosen.append(i)
            picked += 1
            group_count[c.group] += 1
            have[c.tags.get("intensity", 3)] += 1
            mind = np.minimum(mind, feature_distance(feats, feats[i], mirrors[i]))
    return [pool[i] for i in chosen]


def nn_transition(cands: Seq[Candidate], with_mirrors: bool = True) -> np.ndarray:
    """Per clip (and its mirror): cheapest transition from its end to any OTHER clip's start in the set."""
    sp, sr, ep, er = endpoints(cands)
    if with_mirrors:
        sp, sr = np.concatenate([sp, mirror_pose(sp)]), np.concatenate([sr, mirror_root(sr)])
        ep, er = np.concatenate([ep, mirror_pose(ep)]), np.concatenate([er, mirror_root(er)])
    d = transition_distance(ep[:, None], er[:, None], sp[None], sr[None])
    np.fill_diagonal(d, np.inf)
    return d.min(axis=1)


def by_genre(cands: Seq[Candidate]) -> dict[str, list[Candidate]]:
    out: dict[str, list[Candidate]] = defaultdict(list)
    for c in cands:
        out[c.genre].append(c)
    return dict(sorted(out.items()))
