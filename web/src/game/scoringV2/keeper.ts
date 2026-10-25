// ScoreKeeperV2: a drop-in for the classic ScoreKeeper (same constructor, addFrame, advanceTo,
// state, results, summary, checkpoints). Per checkpoint:
//  - every frame in the window is scored by scoreFrameV2 (forgiving angles, hero limbs carry
//    heroWeight of the score, the rest only add; limbs carried through short dropouts);
//  - timing: the frame where the hero limbs come closest to the target (ties go to the one nearest
//    the beat) gives offsetSec, the Early / Late tag and a small timing factor on the best score;
//  - a motion bonus (direction of travel, snap) is added to any hit that isn't a miss, capped at 100.
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
import { timingFactor, v2ConfigFor, type V2Config } from './config'
import { LimbCarry, scoreFrameV2, visibleLimbDirs, type FrameScoreV2 } from './frame'
import { heroLimbs } from './heroLimbs'
import { LimbHistory, motionBonus, type MotionBonus } from './motion'

export type TimingTag = 'early' | 'late'

export interface CheckpointResultV2 extends CheckpointResult {
  /** Set when the hero limbs peaked more than timingTagSec off the beat. */
  timing?: TimingTag
  v2?: { raw: number; timingFactor: number; bonus: MotionBonus; heroes: LimbName[] }
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
  private readonly carry: LimbCarry
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
    this.carry = new LimbCarry(this.v2.carrySec)
    this.open = this.checkpoints.map(() => ({ best: null, samples: [] }))
  }

  addFrame(frame: PlayerFrame): CheckpointResultV2[] {
    this.shadow?.addFrame(frame)
    const t = frame.songTime
    if (Number.isFinite(t)) {
      const dirs = this.carry.apply(t, visibleLimbDirs(frame, this.config.minVisibility))
      this.history.push(t, dirs)
      const w = this.v2.windowSec
      for (let i = this.next; i < this.checkpoints.length; i++) {
        const cp = this.checkpoints[i]
        if (cp.time - w > t) break
        const offset = t - cp.time
        if (Math.abs(offset) > w) continue
        const s = scoreFrameV2(cp, this.heroes[i], dirs, this.config, this.v2)
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
    while (this.next < this.checkpoints.length && songTime > this.checkpoints[this.next].time + this.v2.windowSec) {
      out.push(this.finalize(this.next))
      this.next++
    }
    return out
  }

  /**
   * Timing offset of checkpoint i. With the motion track: the shift (on a 1/60 s grid within the
   * window) that best lines the player's hero-limb directions up with the coach's over the
   * quarter beat either side of the beat. Otherwise the frame where the hero limbs came closest
   * to the target. Near-ties (timingTieDeg) go to the offset nearest the beat.
   */
  private timingOffset(i: number, samples: readonly Sample[]): number {
    if (this.track) {
      const cp = this.checkpoints[i]
      const q = Math.max(0.05, this.beatSec * this.v2.travelBeats)
      const coach = [-q, -q / 2, 0, q / 2, q].map((ds) => this.track!.sample(cp.time + ds).pose)
      const errs: Sample[] = []
      const w = this.v2.windowSec
      for (let k = Math.ceil(-w * 60); k <= Math.floor(w * 60); k++) {
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
    if (best) {
      const offset = this.timingOffset(i, samples)
      const factor = timingFactor(offset, this.v2)
      const timed = best.score * factor
      const bonus: MotionBonus =
        timed >= this.config.thresholds.ok
          ? motionBonus(heroes, cp.time, cp.time + offset, this.beatSec, this.history, this.track, this.v2)
          : { direction: 0, snap: 0 }
      score = Math.min(100, timed + bonus.direction + bonus.snap)
      offsetSec = offset
      if (Math.abs(offset) > this.v2.timingTagSec) timing = offset > 0 ? 'late' : 'early'
      detail = { raw: best.score, timingFactor: factor, bonus, heroes: [...heroes] }
    }
    const judgment = judge(score, this.config)
    const points = Math.round(JUDGMENT_POINTS[judgment] * comboMultiplier(this.combo))
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
