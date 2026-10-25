// ScoreKeeperV2: a drop-in for the classic ScoreKeeper (same constructor, addFrame, advanceTo,
// state, results, summary, checkpoints). Per checkpoint:
//  - every frame in the window is scored by scoreFrameV2 (forgiving angles, hero limbs carry
//    heroWeight of the score, the rest only add; limbs carried through short dropouts);
//  - movement: pathWeight of the raw score is how the hero limbs travelled over the beat leading
//    in, against the coach (the rest is the pose at its best moment);
//  - late catch-up: up to lateBeats late still scores, a little less the later it is;
//  - timing: the frame where the hero limbs come closest to the target (ties go to the one nearest
//    the beat) gives offsetSec, the Early / Late tag and a small timing factor on the best score;
//  - a motion bonus (direction of travel, snap) is added to any hit that isn't a miss, capped at 100;
//  - with triedFloor (Relaxed), moving the hero limbs the coach's way earns at least an OK.
// Shadow mode: the classic keeper runs on the same frames (`shadow`) for live comparison.

import type { Routine } from '@shared/routine'
import type { LimbName } from '@shared/skeleton'
import type { MotionTrack } from '../../routine/track'
import type { PlayerFrame } from '../poseSource'
import {
  comboMultiplier,
  DEFAULT_SCORING,
  FIVE_STAR_FRACTION,
  judge,
  JUDGMENT_POINTS,
  MIN_CHECKPOINTS_FOR_HIGHLIGHT,
  MIN_HIGHLIGHT_GAP,
  ScoreKeeper,
  type Checkpoint,
  type CheckpointResult,
  type Judgment,
  type MoveSummary,
  type ResultsSummary,
  type ScoreState,
  type ScoringConfig,
  angleBetweenDeg,
  limbVector,
} from '../scoring'
import { limbScoreV2, timingFactor, v2ConfigFor, type V2Config } from './config'
import { Foreshortening, LimbCarry, mirrorDirs, scoreFrameV2, visibleLimbDirs, type FrameScoreV2, type LimbDirs } from './frame'
import { heroLimbs } from './heroLimbs'
import { LimbHistory, motionBonus, type MotionBonus } from './motion'

export type TimingTag = 'early' | 'late'

export interface CheckpointResultV2 extends CheckpointResult {
  /** Set when the hero limbs peaked more than timingTagSec off the beat. */
  timing?: TimingTag
  /** tried: lifted to OK by the "tried it" floor (Relaxed). */
  v2?: { raw: number; pose: number; path: number | null; timingFactor: number; bonus: MotionBonus; heroes: LimbName[]; tried?: boolean }
}

export interface ScoreKeeperV2Options {
  /** The coach's motion (direction-of-travel bonus); without it only the snap bonus applies. */
  track?: MotionTrack | null
  /** Seconds per beat; default: estimated from the checkpoint spacing. */
  beatSec?: number
  /** Run the classic keeper alongside (default true). */
  shadow?: boolean
  v2?: Partial<V2Config>
}

interface Sample {
  offset: number
  err: number
}

interface Open {
  best: (FrameScoreV2 & { offset: number }) | null
  samples: Sample[]
}

/** Smallest checkpoint spacing of at least 0.2 s (checkpoints sit on beats); 0.5 s if none. */
export function estimateBeatSec(checkpoints: readonly Checkpoint[]): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 1; i < checkpoints.length; i++) {
    const d = checkpoints[i].time - checkpoints[i - 1].time
    if (d >= 0.2 && d < best) best = d
  }
  return Number.isFinite(best) ? best : 0.5
}

export class ScoreKeeperV2 {
  readonly checkpoints: readonly Checkpoint[]
  readonly config: ScoringConfig
  readonly v2: V2Config
  readonly heroes: readonly LimbName[][]
  readonly shadow: ScoreKeeper | null

  private readonly track: MotionTrack | null
  private readonly beatSec: number
  /** Early side (s) of each checkpoint's window: windowSec or windowBeats of a beat, whichever is wider. */
  readonly windowSec: number
  /** Late side (s): at least windowSec, up to lateBeats of a beat (late catch-up). */
  readonly lateSec: number
  private readonly carry: LimbCarry
  private readonly foreshortening: Foreshortening
  private readonly mirrorHistory = new LimbHistory()
  private readonly history = new LimbHistory()
  private readonly open: Open[]
  private next = 0
  private readonly done: CheckpointResultV2[] = []
  private points = 0
  private basePoints = 0
  private combo = 0
  private maxCombo = 0
  private readonly counts: Record<Judgment, number> = { perfect: 0, good: 0, ok: 0, miss: 0 }

  constructor(checkpoints: readonly Checkpoint[], config: ScoringConfig = DEFAULT_SCORING, opts: ScoreKeeperV2Options = {}) {
    this.checkpoints = [...checkpoints].sort((a, b) => a.time - b.time)
    this.config = config
    this.v2 = v2ConfigFor(config, opts.v2)
    this.heroes = heroLimbs(this.checkpoints, this.v2)
    this.shadow = opts.shadow === false ? null : new ScoreKeeper(this.checkpoints, config)
    this.track = opts.track ?? null
    this.beatSec = opts.beatSec ?? estimateBeatSec(this.checkpoints)
    this.windowSec = Math.max(this.v2.windowSec, this.v2.windowBeats * this.beatSec)
    this.lateSec = Math.max(this.windowSec, this.v2.lateBeats * this.beatSec)
    this.carry = new LimbCarry(this.v2.carrySec)
    this.foreshortening = new Foreshortening(this.v2.shortLimbRatio)
    this.open = this.checkpoints.map(() => ({ best: null, samples: [] }))
  }

  addFrame(frame: PlayerFrame): CheckpointResultV2[] {
    this.shadow?.addFrame(frame)
    const t = frame.songTime
    if (Number.isFinite(t)) {
      const dirs = this.carry.apply(t, this.foreshortening.apply(visibleLimbDirs(frame, this.config.minVisibility)))
      this.history.push(t, dirs)
      const mirrored: LimbDirs | null = this.v2.mirrorCredit > 0 ? mirrorDirs(dirs) : null
      if (mirrored) this.mirrorHistory.push(t, mirrored)
      const w = this.windowSec
      for (let i = this.next; i < this.checkpoints.length; i++) {
        const cp = this.checkpoints[i]
        if (cp.time - w > t) break
        const offset = t - cp.time
        if (offset < -w || offset > this.lateSec) continue
        let s = scoreFrameV2(cp, this.heroes[i], dirs, this.config, this.v2)
        if (mirrored) {
          const m = scoreFrameV2(cp, this.heroes[i], mirrored, this.config, this.v2)
          if (!m.unseen && (s.unseen || m.score * this.v2.mirrorCredit > s.score)) s = { ...m, score: m.score * this.v2.mirrorCredit }
        }
        if (s.unseen) continue
        const o = this.open[i]
        o.samples.push({ offset, err: s.heroErrDeg })
        if (!o.best || s.score > o.best.score || (s.score === o.best.score && Math.abs(offset) < Math.abs(o.best.offset))) o.best = { ...s, offset }
      }
    }
    return this.close(t)
  }

  advanceTo(songTime: number): CheckpointResultV2[] {
    this.shadow?.advanceTo(songTime)
    return this.close(songTime)
  }

  private close(songTime: number): CheckpointResultV2[] {
    const out: CheckpointResultV2[] = []
    while (this.next < this.checkpoints.length && songTime > this.checkpoints[this.next].time + this.lateSec) {
      out.push(this.finalize(this.next))
      this.next++
    }
    return out
  }

  /**
   * Timing offset of checkpoint i. With the motion track: the shift (on a 1/60 s grid within the
   * window, late side included) that best lines the player's hero-limb directions up with the coach's over the
   * quarter beat either side of the beat. Otherwise the frame where the hero limbs came closest
   * to the target. Near-ties (timingTieDeg) go to the offset nearest the beat.
   */
  private timingOffset(i: number, samples: readonly Sample[]): number {
    if (this.track) {
      const cp = this.checkpoints[i]
      const q = Math.max(0.05, this.beatSec * this.v2.travelBeats)
      const coach = [-q, -q / 2, 0, q / 2, q].map((ds) => this.track!.sample(cp.time + ds).pose)
      const errs: Sample[] = []
      for (let k = Math.ceil(-this.windowSec * 60); k <= Math.floor(this.lateSec * 60); k++) {
        const shift = k / 60
        let sum = 0
        let n = 0
        ;[-q, -q / 2, 0, q / 2, q].forEach((ds, j) => {
          for (const limb of this.heroes[i]) {
            const p = this.history.at(limb, cp.time + ds + shift, 0.04)
            const c = limbVector(coach[j], limb)
            if (!p || !c) continue
            sum += angleBetweenDeg(p, c)
            n++
          }
        })
        if (n > 0) errs.push({ offset: shift, err: sum / n })
      }
      if (errs.length > 0) return this.nearestOfBest(errs)
    }
    return this.nearestOfBest(samples)
  }

  /**
   * Movement score (0..100) of checkpoint i: the hero limbs' directions at pathSamples points over
   * the pathBeats before the beat (never reaching back past the previous checkpoint), each
   * compared with the coach at the same point of the move, the player shifted by `offset`.
   * null without the motion track or when fewer than half the samples were seen.
   */
  private pathScore(i: number, offset: number): number | null {
    const own = this.pathScoreOf(i, offset, this.history)
    if (!(this.v2.mirrorCredit > 0)) return own
    const m = this.pathScoreOf(i, offset, this.mirrorHistory)
    return m === null ? own : Math.max(own ?? 0, m * this.v2.mirrorCredit)
  }

  private pathScoreOf(i: number, offset: number, history: LimbHistory): number | null {
    if (!this.track) return null
    const cp = this.checkpoints[i]
    const prev = i > 0 ? this.checkpoints[i - 1].time : Number.NEGATIVE_INFINITY
    const span = Math.min(this.v2.pathBeats * this.beatSec, cp.time - prev)
    const n = Math.max(2, this.v2.pathSamples)
    if (!(span > 0)) return null
    let sum = 0
    let seen = 0
    let total = 0
    for (let j = 0; j < n; j++) {
      const s = cp.time - span + (span * (j + 1)) / n
      const coach = this.track.sample(s).pose
      for (const limb of this.heroes[i]) {
        const c = limbVector(coach, limb)
        if (!c) continue
        total++
        const p = history.at(limb, s + offset, 0.04)
        if (!p) continue
        sum += limbScoreV2(Math.max(0, angleBetweenDeg(p, c) - this.v2.pathSlackDeg), this.v2)
        seen++
      }
    }
    return seen > 0 && seen * 2 >= total ? sum / seen : null
  }

  private nearestOfBest(samples: readonly Sample[]): number {
    const min = Math.min(...samples.map((s) => s.err))
    let off = Number.POSITIVE_INFINITY
    for (const s of samples) if (s.err <= min + this.v2.timingTieDeg && Math.abs(s.offset) < Math.abs(off)) off = s.offset
    return off
  }

  private finalize(i: number): CheckpointResultV2 {
    const cp = this.checkpoints[i]
    const { best, samples } = this.open[i]
    this.open[i] = { best: null, samples: [] }
    const heroes = this.heroes[i]
    let score = 0
    let offsetSec: number | null = null
    let timing: TimingTag | undefined
    let detail: CheckpointResultV2['v2']
    let triedIt = false
    if (best) {
      const offset = this.timingOffset(i, samples)
      const factor = timingFactor(offset, this.v2, this.lateSec)
      const path = this.pathScore(i, offset)
      const raw = path === null ? best.score : (1 - this.v2.pathWeight) * best.score + this.v2.pathWeight * path
      const timed = raw * factor
      const ok = this.config.thresholds.ok
      const motion = motionBonus(heroes, cp.time, cp.time + offset, this.beatSec, this.history, this.track, this.v2)
      const bonus: MotionBonus = timed >= ok ? motion : { direction: 0, snap: 0, travelMatch: motion.travelMatch }
      score = Math.min(100, timed + bonus.direction + bonus.snap)
      const tried = this.v2.triedFloor && raw >= this.v2.triedMinRaw && (motion.travelMatch ?? 0) >= this.v2.triedMatch
      if (tried && score < ok) {
        score = ok
        triedIt = true
      }
      offsetSec = offset
      if (Math.abs(offset) > this.v2.timingTagSec) timing = offset > 0 ? 'late' : 'early'
      detail = { raw, pose: best.score, path, timingFactor: factor, bonus, heroes: [...heroes], ...(triedIt ? { tried: true } : {}) }
    }
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
    const result: CheckpointResultV2 = { checkpoint: cp, score, judgment, offsetSec, perLimb: best ? best.perLimb : {}, points, combo: this.combo }
    if (!best) result.unseen = true
    if (timing && judgment !== 'miss') result.timing = timing
    if (detail) result.v2 = detail
    this.done.push(result)
    return result
  }

  get state(): ScoreState {
    const total = this.checkpoints.length
    const full = FIVE_STAR_FRACTION * JUDGMENT_POINTS.perfect * total
    const stars = full > 0 ? Math.min(5, Math.max(0, (5 * this.basePoints) / full)) : 0
    return { score: this.points, combo: this.combo, maxCombo: this.maxCombo, counts: { ...this.counts }, stars, judged: this.done.length, total }
  }

  results(): CheckpointResultV2[] {
    return [...this.done]
  }

  summary(routine: Pick<Routine, 'moves'>): ResultsSummary {
    return summarize(this.done, this.state, routine)
  }
}

/** Accuracy, per-move means and the best / hardest distinct move (same rules as the classic keeper). */
export function summarize(done: readonly CheckpointResult[], state: ScoreState, routine: Pick<Routine, 'moves'>): ResultsSummary {
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
  const byId = new Map<string, { m: MoveSummary; sum: number }>()
  for (const m of perMove) {
    const cur = byId.get(m.id)
    if (cur) {
      cur.sum += m.avgScore * m.checkpoints
      cur.m.checkpoints += m.checkpoints
    } else byId.set(m.id, { m: { ...m }, sum: m.avgScore * m.checkpoints })
  }
  let best: MoveSummary | null = null
  let hardest: MoveSummary | null = null
  for (const { m, sum } of byId.values()) {
    if (m.checkpoints < MIN_CHECKPOINTS_FOR_HIGHLIGHT) continue
    const s: MoveSummary = { ...m, avgScore: sum / m.checkpoints }
    if (!best || s.avgScore > best.avgScore) best = s
    if (!hardest || s.avgScore < hardest.avgScore) hardest = s
  }
  if (hardest && best && (hardest.id === best.id || hardest.avgScore > best.avgScore - MIN_HIGHLIGHT_GAP)) hardest = null
  return { state, accuracy, perMove, hardestMove: hardest, bestMove: best }
}
