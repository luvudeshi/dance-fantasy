// Per-beat scoring of the player's pose against the routine.
// STAGE 4 INTERFACE: exported names and shapes are stable (fields/exports may be added).
//
// How a song is judged (all pure, no DOM; poses are in the shared body frame, shared/README.md):
//  1. buildCheckpoints: one checkpoint per ON-BEAT keyframe of every move (a move's t=0 keyframe
//     and the previous move's t=1 keyframe at the same instant are one checkpoint). Compared
//     limbs follow the distal-joint rule on move.scoredJoints, plus the torso when the target
//     leans; seated mode drops legs (and the torso, whose mid-hip end is built from leg joints).
//     Checkpoints whose target is the resting pose on every compared limb are skipped, so a
//     player who just stands there earns nothing between moves.
//  2. scoreFrame: per limb, the 2D angle between the player's and the target's limb direction
//     -> 100 at <= perfectDeg, linear to 0 at >= zeroDeg; weighted mean over usable limbs.
//     The player's sides are compared directly (the webcam body frame already reports the
//     player's anatomical sides, and the player copies the mirrored coach like a mirror).
//  3. ScoreKeeper: a checkpoint's score is the best frame within +-windowSec of its time;
//     it is finalized (judged, combo, points) once advanceTo() passes time + windowSec.

import type { Mode, Routine } from '@shared/routine'
import { LEG_JOINTS, LIMBS, type JointName, type LimbEnd, type LimbName, type Pose2D, type Vec2 } from '@shared/skeleton'
import { NEUTRAL_POSE } from '../routine/pose'
import type { PlayerFrame } from './poseSource'

export type Judgment = 'perfect' | 'good' | 'ok' | 'miss'

export const LIMB_NAMES = Object.keys(LIMBS) as LimbName[]

export interface ScoringConfig {
  /** Best match is searched within ±windowSec of each checkpoint (after latency correction). */
  windowSec: number
  /** Joints below this MediaPipe visibility don't count. */
  minVisibility: number
  /** Score (0..100) thresholds. */
  thresholds: { perfect: number; good: number; ok: number }
  /** A limb within this angle (degrees) of the target direction scores 100. */
  perfectDeg?: number
  /** A limb this far (degrees) or further from the target direction scores 0 (linear in between). */
  zeroDeg?: number
  /** Weight of each limb in a checkpoint's mean. */
  limbWeights?: Partial<Record<LimbName, number>>
}

/** Limb weights: arms carry the dance, legs are noisier on webcams, the torso only counts when leaning. */
export const DEFAULT_LIMB_WEIGHTS: Readonly<Record<LimbName, number>> = {
  l_upper_arm: 1,
  r_upper_arm: 1,
  l_forearm: 1,
  r_forearm: 1,
  l_thigh: 0.8,
  r_thigh: 0.8,
  l_shin: 0.6,
  r_shin: 0.6,
  torso: 0.8,
}

/**
 * Tuned on the bot simulation (scoring.sim.test.ts): ~12° per-limb error stays nearly all
 * perfect, ~30° lands mostly good/ok, standing still always misses, the wrong side < 60%.
 */
export const DEFAULT_SCORING: ScoringConfig = {
  windowSec: 0.15,
  minVisibility: 0.5,
  thresholds: { perfect: 90, good: 75, ok: 55 },
  perfectDeg: 15,
  zeroDeg: 60,
  limbWeights: DEFAULT_LIMB_WEIGHTS,
}

/** "Lenient" judging (game/judging.ts): wider window and angles, lower thresholds. */
export const LENIENT_SCORING: ScoringConfig = {
  ...DEFAULT_SCORING,
  windowSec: 0.2,
  thresholds: { perfect: 85, good: 68, ok: 48 },
  perfectDeg: 20,
  zeroDeg: 70,
}

/** "Strict" judging: tighter window and angles, higher thresholds. */
export const STRICT_SCORING: ScoringConfig = {
  ...DEFAULT_SCORING,
  windowSec: 0.12,
  thresholds: { perfect: 92, good: 80, ok: 60 },
  perfectDeg: 12,
  zeroDeg: 55,
}

/** Base points per judgment, before the combo multiplier. */
export const JUDGMENT_POINTS: Readonly<Record<Judgment, number>> = { perfect: 100, good: 70, ok: 40, miss: 0 }
/** Each checkpoint of the running combo adds this much to the multiplier ... */
export const COMBO_STEP = 0.05
/** ... up to this many (so the multiplier tops out at 1 + 0.05 * 20 = 2x). */
export const COMBO_CAP = 20
/**
 * Five stars at this fraction of the all-perfect base score. Stars use base points only (no
 * combo bonus), so they measure how well you danced; the combo only inflates the score.
 */
export const FIVE_STAR_FRACTION = 0.85
/** A distinct move needs this many judged checkpoints to be named hardest/best. */
export const MIN_CHECKPOINTS_FOR_HIGHLIGHT = 2
/** hardestMove is only named when it trails bestMove by at least this many points. */
export const MIN_HIGHLIGHT_GAP = 1

/** Keyframes count as on-beat when t * lengthBeats is within this many beats of an integer. */
export const ON_BEAT_TOLERANCE_BEATS = 0.02
/** Keyframes closer than this (s) are one checkpoint (a move's start and the previous move's end). */
export const SAME_TIME_SEC = 0.01
/** The torso is compared when the target leans more than this from vertical (degrees). */
export const TORSO_LEAN_DEG = 10
/** A limb within this angle (degrees) of NEUTRAL_POSE counts as resting; a checkpoint whose compared
 *  limbs all rest is skipped. Wide enough to cover the library's relaxed "ready" stance. */
export const NEUTRAL_SKIP_DEG = 30
/** Target limbs shorter than this (body units) have no reliable 2D direction and aren't compared. */
export const MIN_TARGET_LIMB_LEN = 0.05

/** Multiplier for a hit made while carrying a combo of `combo` checkpoints. */
export const comboMultiplier = (combo: number): number => 1 + COMBO_STEP * Math.min(Math.max(0, combo), COMBO_CAP)

/** A moment the player is judged: an on-beat keyframe of a move. */
export interface Checkpoint {
  index: number
  moveIndex: number
  /** Song time (s), = a beat time. */
  time: number
  target: Pose2D
  /** Limbs compared at this checkpoint (distal-joint rule; legs dropped in seated mode). */
  limbs: LimbName[]
  /** Compared limbs whose target is (near) the resting pose: they can lower the score but never
   *  raise it above the moving limbs' score (see scoreFrame). */
  resting?: LimbName[]
  /** Points multiplier for this checkpoint only (signature moves, src/signature); default 1. */
  multiplier?: number
}

export interface CheckpointResult {
  checkpoint: Checkpoint
  /** 0..100 */
  score: number
  judgment: Judgment
  /** Offset (s) of the best-matching frame from the checkpoint time; null if no usable frame. */
  offsetSec: number | null
  /** 0..100 per compared limb (for "left arm late"-style hints). */
  perLimb: Partial<Record<LimbName, number>>
  /** true when no frame in the window showed at least half of the compared limbs (score 0). */
  unseen?: boolean
  /** Points awarded for this checkpoint (base points x combo multiplier). */
  points?: number
  /** Combo after this checkpoint. */
  combo?: number
}

export interface ScoreState {
  score: number
  combo: number
  maxCombo: number
  counts: Record<Judgment, number>
  /** 0..5, fractional while filling. */
  stars: number
  /** Checkpoints judged so far / total. */
  judged: number
  total: number
}

export interface MoveSummary {
  moveIndex: number
  id: string
  name: string
  /** Mean checkpoint score, 0..100. */
  avgScore: number
  checkpoints: number
}

export interface ResultsSummary {
  state: ScoreState
  /** Mean checkpoint score, 0..100. */
  accuracy: number
  perMove: MoveSummary[]
  /** Lowest-scoring distinct move (by id) with enough checkpoints, or null. */
  hardestMove: MoveSummary | null
  bestMove: MoveSummary | null
}

// --- geometry ----------------------------------------------------------------------------

const RAD2DEG = 180 / Math.PI

function midpoint(a: Vec2 | undefined, b: Vec2 | undefined): Vec2 | undefined {
  return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : undefined
}

function endPoint(p: Pose2D, e: LimbEnd): Vec2 | undefined {
  if (e === 'mid_hip') return midpoint(p.l_hip, p.r_hip)
  if (e === 'mid_shoulder') return midpoint(p.l_shoulder, p.r_shoulder)
  return p[e]
}

function endVisibility(vis: Partial<Record<JointName, number>>, e: LimbEnd): number {
  if (e === 'mid_hip') return Math.min(vis.l_hip ?? 0, vis.r_hip ?? 0)
  if (e === 'mid_shoulder') return Math.min(vis.l_shoulder ?? 0, vis.r_shoulder ?? 0)
  return vis[e] ?? 0
}

/** Proximal -> distal vector of a limb, or undefined when an endpoint is missing / not finite. */
export function limbVector(p: Pose2D, limb: LimbName): Vec2 | undefined {
  const [a, b] = LIMBS[limb]
  const pa = endPoint(p, a)
  const pb = endPoint(p, b)
  if (!pa || !pb) return undefined
  const v: Vec2 = [pb[0] - pa[0], pb[1] - pa[1]]
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) ? v : undefined
}

/** Unsigned angle (degrees, 0..180) between two 2D vectors. */
export function angleBetweenDeg(a: Vec2, b: Vec2): number {
  return Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * RAD2DEG
}

/** 0..100 for an angular error (degrees): 100 up to perfectDeg, linear to 0 at zeroDeg. */
export function limbScore(errorDeg: number, config: ScoringConfig = DEFAULT_SCORING): number {
  const perfect = config.perfectDeg ?? 15
  const zero = Math.max(perfect + 1e-6, config.zeroDeg ?? 60)
  if (!(errorDeg > perfect)) return Number.isNaN(errorDeg) ? 0 : 100
  if (errorDeg >= zero) return 0
  return (100 * (zero - errorDeg)) / (zero - perfect)
}

const limbLength = (v: Vec2): number => Math.hypot(v[0], v[1])

// --- checkpoints -------------------------------------------------------------------------

const LEG_SET: ReadonlySet<JointName> = new Set(LEG_JOINTS)
const NEUTRAL_DIR = Object.fromEntries(LIMB_NAMES.map((l) => [l, limbVector(NEUTRAL_POSE, l)])) as Record<LimbName, Vec2>
const VERTICAL_UP: Vec2 = [0, -1]

/** Limbs compared for a target pose: distal-joint rule + leaning torso; seated drops legs and torso. */
export function checkpointLimbs(scoredJoints: Iterable<JointName>, target: Pose2D, mode: Mode): LimbName[] {
  const scored = new Set(scoredJoints)
  const out: LimbName[] = []
  for (const limb of LIMB_NAMES) {
    const v = limbVector(target, limb)
    if (!v || limbLength(v) < MIN_TARGET_LIMB_LEN) continue
    if (limb === 'torso') {
      // mid_hip is built from the hips, which seated mode ignores (shared/README.md).
      if (mode !== 'seated' && angleBetweenDeg(v, VERTICAL_UP) > TORSO_LEAN_DEG) out.push(limb)
      continue
    }
    const distal = LIMBS[limb][1] as JointName
    if (!scored.has(distal)) continue
    if (mode === 'seated' && LEG_SET.has(distal)) continue
    out.push(limb)
  }
  return out
}

/** Limbs of `target` (among `limbs`) pointing within restDeg of the resting pose. */
export function restingLimbs(target: Pose2D, limbs: readonly LimbName[], restDeg = NEUTRAL_SKIP_DEG): LimbName[] {
  return limbs.filter((l) => {
    const v = limbVector(target, l)
    return !v || angleBetweenDeg(v, NEUTRAL_DIR[l]) <= restDeg
  })
}

/** true when every listed limb of `target` points within restDeg of the resting pose. */
export function isRestingPose(target: Pose2D, limbs: readonly LimbName[], restDeg = NEUTRAL_SKIP_DEG): boolean {
  return restingLimbs(target, limbs, restDeg).length === limbs.length
}

interface Candidate {
  moveIndex: number
  time: number
  target: Pose2D
  joints: Set<JointName>
}

/**
 * One checkpoint per on-beat keyframe (t * lengthBeats ≈ integer) of every move, at
 * startTime + t * (endTime - startTime). Keyframes at the same instant (a move's t=0 and the
 * previous move's t=1) merge into one checkpoint that keeps the earlier keyframe's pose (the
 * coach holds the previous end pose at the boundary) and compares the union of both moves'
 * limbs. Checkpoints with no comparable limb, or whose target is the resting pose on every
 * compared limb, are dropped. Result is sorted by time and indexed 0..n-1.
 */
export function buildCheckpoints(routine: Pick<Routine, 'moves'>, mode: Mode, restDeg = NEUTRAL_SKIP_DEG): Checkpoint[] {
  const cands: Candidate[] = []
  routine.moves.forEach((move, moveIndex) => {
    const dur = move.endTime - move.startTime
    if (!(dur > 0)) return
    const beats = Math.max(1, move.lengthBeats)
    for (const kf of move.keyframes) {
      if (!(kf.t >= 0 && kf.t <= 1)) continue
      const b = kf.t * beats
      if (Math.abs(b - Math.round(b)) > ON_BEAT_TOLERANCE_BEATS) continue
      const time = move.startTime + kf.t * dur
      const last = cands[cands.length - 1]
      if (last && Math.abs(time - last.time) < SAME_TIME_SEC) {
        for (const j of move.scoredJoints) last.joints.add(j)
        continue
      }
      cands.push({ moveIndex, time, target: kf.pose, joints: new Set(move.scoredJoints) })
    }
  })
  cands.sort((a, b) => a.time - b.time)
  const out: Checkpoint[] = []
  for (const c of cands) {
    const limbs = checkpointLimbs(c.joints, c.target, mode)
    const resting = restingLimbs(c.target, limbs, restDeg)
    if (limbs.length === 0 || resting.length === limbs.length) continue
    out.push({ index: out.length, moveIndex: c.moveIndex, time: c.time, target: c.target, limbs, resting })
  }
  return out
}

// --- frames ------------------------------------------------------------------------------

export interface FrameScore {
  /** 0..100 (0 when unseen). */
  score: number
  perLimb: Partial<Record<LimbName, number>>
  /** Fewer than half of the checkpoint's limbs were usable. */
  unseen: boolean
}

/**
 * Scores one player frame against a checkpoint. A limb is usable when both endpoints are present
 * with visibility >= minVisibility (missing joints count as invisible) and it has a direction.
 * Score = weighted mean over usable limbs, except that resting limbs (cp.resting) can only pull
 * it down: min(mean of the moving limbs, mean of all limbs). So standing still never earns a
 * checkpoint, while flailing arms during a leg move still cost points. 0 + unseen when fewer than
 * half of the limbs, or none of the moving ones, are usable.
 */
export function scoreFrame(cp: Pick<Checkpoint, 'target' | 'limbs' | 'resting'>, frame: PlayerFrame, config: ScoringConfig = DEFAULT_SCORING): FrameScore {
  const perLimb: Partial<Record<LimbName, number>> = {}
  if (cp.limbs.length === 0) return { score: 0, perLimb, unseen: true }
  if (!frame.valid) return { score: 0, perLimb, unseen: true }
  const weights = config.limbWeights ?? DEFAULT_LIMB_WEIGHTS
  let usable = 0
  let wSum = 0
  let sum = 0
  let wMoving = 0
  let sumMoving = 0
  for (const limb of cp.limbs) {
    const [a, b] = LIMBS[limb]
    if (endVisibility(frame.visibility, a) < config.minVisibility || endVisibility(frame.visibility, b) < config.minVisibility) continue
    const pv = limbVector(frame.pose, limb)
    const tv = limbVector(cp.target, limb)
    if (!pv || !tv || !(limbLength(pv) > 1e-9) || !(limbLength(tv) > 1e-9)) continue
    const s = limbScore(angleBetweenDeg(pv, tv), config)
    const w = Math.max(0, weights[limb] ?? DEFAULT_LIMB_WEIGHTS[limb])
    perLimb[limb] = s
    usable++
    wSum += w
    sum += w * s
    if (!cp.resting?.includes(limb)) {
      wMoving += w
      sumMoving += w * s
    }
  }
  if (usable * 2 < cp.limbs.length || !(wSum > 0) || !(wMoving > 0)) return { score: 0, perLimb, unseen: true }
  return { score: Math.min(sumMoving / wMoving, sum / wSum), perLimb, unseen: false }
}

export function judge(score: number, config: ScoringConfig = DEFAULT_SCORING): Judgment {
  const t = config.thresholds
  return score >= t.perfect ? 'perfect' : score >= t.good ? 'good' : score >= t.ok ? 'ok' : 'miss'
}

// --- score keeper ------------------------------------------------------------------------

interface Best extends FrameScore {
  offsetSec: number
}

/** Higher score wins, then a seen frame over an unseen one, then the frame closer to the beat. */
function isBetter(s: FrameScore, offset: number, cur: Best | null): boolean {
  if (!cur) return true
  if (s.score !== cur.score) return s.score > cur.score
  if (s.unseen !== cur.unseen) return !s.unseen
  return Math.abs(offset) < Math.abs(cur.offsetSec)
}

/**
 * Judges checkpoints as frames arrive. Feed every frame with addFrame (any order within a
 * checkpoint's window; each frame is scored against the still-open checkpoints whose window
 * contains it, keeping the best) and call advanceTo(t) every animation frame with the song
 * time up to which frames have been delivered; advanceTo(Infinity) closes the song. Each
 * checkpoint is finalized exactly once, in time order.
 */
export class ScoreKeeper {
  readonly checkpoints: readonly Checkpoint[]
  readonly config: ScoringConfig

  private readonly best: (Best | null)[]
  private next = 0
  private readonly done: CheckpointResult[] = []
  private points = 0
  private basePoints = 0
  private combo = 0
  private maxCombo = 0
  private readonly counts: Record<Judgment, number> = { perfect: 0, good: 0, ok: 0, miss: 0 }

  constructor(checkpoints: readonly Checkpoint[], config: ScoringConfig = DEFAULT_SCORING) {
    this.checkpoints = [...checkpoints].sort((a, b) => a.time - b.time)
    this.config = config
    this.best = this.checkpoints.map(() => null)
  }

  /** Feed a player frame; returns checkpoints finalized because of it (in order). */
  addFrame(frame: PlayerFrame): CheckpointResult[] {
    const t = frame.songTime
    if (Number.isFinite(t)) {
      const w = this.config.windowSec
      for (let i = this.next; i < this.checkpoints.length; i++) {
        const cp = this.checkpoints[i]
        if (cp.time - w > t) break
        const offset = t - cp.time
        if (Math.abs(offset) > w) continue
        const s = scoreFrame(cp, frame, this.config)
        if (isBetter(s, offset, this.best[i])) this.best[i] = { ...s, offsetSec: offset }
      }
    }
    return this.advanceTo(t)
  }

  /** Finalize every checkpoint whose window has closed by songTime (call every animation frame). */
  advanceTo(songTime: number): CheckpointResult[] {
    const out: CheckpointResult[] = []
    const w = this.config.windowSec
    while (this.next < this.checkpoints.length && songTime > this.checkpoints[this.next].time + w) {
      out.push(this.finalize(this.next))
      this.next++
    }
    return out
  }

  private finalize(i: number): CheckpointResult {
    const cp = this.checkpoints[i]
    const b = this.best[i]
    this.best[i] = null
    const seen = b !== null && !b.unseen
    const score = seen ? b.score : 0
    const judgment = judge(score, this.config)
    const points = Math.round(JUDGMENT_POINTS[judgment] * comboMultiplier(this.combo) * (cp.multiplier ?? 1))
    if (judgment === 'miss') {
      this.combo = 0
    } else {
      this.combo++
      this.maxCombo = Math.max(this.maxCombo, this.combo)
    }
    this.counts[judgment]++
    this.points += points
    this.basePoints += JUDGMENT_POINTS[judgment]
    const result: CheckpointResult = {
      checkpoint: cp,
      score,
      judgment,
      offsetSec: seen ? b.offsetSec : null,
      perLimb: b ? b.perLimb : {},
      points,
      combo: this.combo,
    }
    if (!seen) result.unseen = true
    this.done.push(result)
    return result
  }

  get state(): ScoreState {
    const total = this.checkpoints.length
    const full = FIVE_STAR_FRACTION * JUDGMENT_POINTS.perfect * total
    const stars = full > 0 ? Math.min(5, Math.max(0, (5 * this.basePoints) / full)) : 0
    return {
      score: this.points,
      combo: this.combo,
      maxCombo: this.maxCombo,
      counts: { ...this.counts },
      stars,
      judged: this.done.length,
      total,
    }
  }

  results(): CheckpointResult[] {
    return [...this.done]
  }

  summary(routine: Pick<Routine, 'moves'>): ResultsSummary {
    const done = this.done
    const accuracy = done.length > 0 ? done.reduce((s, r) => s + r.score, 0) / done.length : 0

    const byIndex = new Map<number, { sum: number; n: number }>()
    for (const r of done) {
      const m = byIndex.get(r.checkpoint.moveIndex) ?? { sum: 0, n: 0 }
      m.sum += r.score
      m.n++
      byIndex.set(r.checkpoint.moveIndex, m)
    }
    const perMove: MoveSummary[] = [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([moveIndex, { sum, n }]) => {
        const move = routine.moves[moveIndex]
        return { moveIndex, id: move?.id ?? `move_${moveIndex}`, name: move?.name ?? `Move ${moveIndex + 1}`, avgScore: sum / n, checkpoints: n }
      })

    // Distinct moves by id (repeats pooled), in first-occurrence order.
    const byId = new Map<string, MoveSummary & { sum: number }>()
    for (const m of perMove) {
      const cur = byId.get(m.id)
      if (cur) {
        cur.sum += m.avgScore * m.checkpoints
        cur.checkpoints += m.checkpoints
      } else {
        byId.set(m.id, { ...m, sum: m.avgScore * m.checkpoints })
      }
    }
    let best: MoveSummary | null = null
    let hardest: MoveSummary | null = null
    for (const { sum, ...m } of byId.values()) {
      if (m.checkpoints < MIN_CHECKPOINTS_FOR_HIGHLIGHT) continue
      const s: MoveSummary = { ...m, avgScore: sum / m.checkpoints }
      if (!best || s.avgScore > best.avgScore) best = s
      if (!hardest || s.avgScore < hardest.avgScore) hardest = s
    }
    if (hardest && best && (hardest.id === best.id || hardest.avgScore > best.avgScore - MIN_HIGHLIGHT_GAP)) hardest = null

    return { state: this.state, accuracy, perMove, hardestMove: hardest, bestMove: best }
  }
}
