// Pure view model for the results screen (unit-tested): formatting, storybook titles, the
// per-move accuracy list, and the hardest move's practice tip.

import type { Routine } from '@shared/routine'
import type { LimbName } from '@shared/skeleton'
import { JUDGMENT_STYLE, LIMB_LABEL, worstLimb } from './hud'
import { DEFAULT_SCORING, type CheckpointResult, type Judgment, type MoveSummary, type ResultsSummary, type ScoringConfig } from './scoring'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** "12,345" (rounded). */
export function formatScore(n: number): string {
  return Math.round(Number.isFinite(n) ? n : 0).toLocaleString('en-US')
}

/** "87%" (0..100, rounded). */
export function formatPercent(v: number): string {
  return `${Math.round(clamp(Number.isFinite(v) ? v : 0, 0, 100))}%`
}

/** Judgment band of a 0..100 score (same thresholds as a checkpoint). */
export function scoreBand(score: number, thresholds: ScoringConfig['thresholds'] = DEFAULT_SCORING.thresholds): Judgment {
  if (score >= thresholds.perfect) return 'perfect'
  if (score >= thresholds.good) return 'good'
  if (score >= thresholds.ok) return 'ok'
  return 'miss'
}

/** Bar colour for a 0..100 score: the HUD colour of its judgment band. */
export const scoreColor = (score: number, thresholds?: ScoringConfig['thresholds']): string => JUDGMENT_STYLE[scoreBand(score, thresholds)].color

/** "Judging: Standard · camera latency 120 ms (measured)" (the bot needs no latency). */
export function roundDetails(o: { judging: string; latencySec: number | null; latencySource?: 'measured' | 'default'; autoplay: boolean }): string {
  const parts = [`Judging: ${o.judging}`]
  if (o.autoplay) parts.push('danced by the bot')
  else if (o.latencySec !== null && Number.isFinite(o.latencySec)) {
    const src = o.latencySource === 'measured' ? 'measured' : 'default'
    parts.push(`camera latency ${Math.round(o.latencySec * 1000)} ms (${src})`)
  }
  return parts.join(' · ')
}

/** Storybook rank for a 0..5 star result. */
export function rankTitle(stars: number): string {
  if (stars >= 5) return 'Midnight Princess'
  if (stars >= 4) return 'Belle of the Ball'
  if (stars >= 3) return 'Courtly Dancer'
  if (stars >= 2) return 'Village Dancer'
  if (stars >= 1) return 'Scullery Twirler'
  return 'Shy Wallflower'
}

export function rankBlurb(stars: number): string {
  if (stars >= 4) return 'Your slippers are worn right through. The whole court is talking about you!'
  if (stars >= 2) return 'A fine night of dancing. One more ball and the prince won’t look away.'
  return 'Every princess starts somewhere. Shake off the dust and dance again!'
}

export interface MoveRow {
  id: string
  name: string
  /** Checkpoint-weighted mean score over every time the move was danced, 0..100. */
  accuracy: number
  checkpoints: number
  /** Index of the move's first appearance in the routine. */
  firstIndex: number
}

/** Distinct moves (by id), best first; ties keep routine order. Moves never judged are dropped. */
export function moveRows(perMove: readonly MoveSummary[]): MoveRow[] {
  const byId = new Map<string, { row: MoveRow; sum: number }>()
  for (const m of perMove) {
    if (!(m.checkpoints > 0) || !Number.isFinite(m.avgScore)) continue
    let e = byId.get(m.id)
    if (!e) {
      e = { row: { id: m.id, name: m.name, accuracy: 0, checkpoints: 0, firstIndex: m.moveIndex }, sum: 0 }
      byId.set(m.id, e)
    }
    e.sum += m.avgScore * m.checkpoints
    e.row.checkpoints += m.checkpoints
    e.row.firstIndex = Math.min(e.row.firstIndex, m.moveIndex)
  }
  const rows = [...byId.values()].map(({ row, sum }) => ({ ...row, accuracy: sum / row.checkpoints }))
  return rows.sort((a, b) => b.accuracy - a.accuracy || a.firstIndex - b.firstIndex)
}

/** Mean of the non-null checkpoint offsets (s; + = late), null when there are none. */
export function meanOffset(results: readonly Pick<CheckpointResult, 'offsetSec'>[]): number | null {
  let sum = 0
  let n = 0
  for (const r of results) {
    if (r.offsetSec === null || !Number.isFinite(r.offsetSec)) continue
    sum += r.offsetSec
    n++
  }
  return n > 0 ? sum / n : null
}

/** Limb with the lowest mean score across results. */
export function weakestLimb(results: readonly Pick<CheckpointResult, 'perLimb'>[]): LimbName | null {
  const sums: Partial<Record<LimbName, { s: number; n: number }>> = {}
  for (const r of results) {
    for (const [limb, s] of Object.entries(r.perLimb) as Array<[LimbName, number | undefined]>) {
      if (s === undefined || !Number.isFinite(s)) continue
      const e = (sums[limb] ??= { s: 0, n: 0 })
      e.s += s
      e.n++
    }
  }
  const means: Partial<Record<LimbName, number>> = {}
  for (const [limb, e] of Object.entries(sums) as Array<[LimbName, { s: number; n: number }]>) means[limb] = e.s / e.n
  return worstLimb(means)
}

/** Timing below this mean offset (s) is not worth mentioning. */
export const TIMING_TIP_SEC = 0.06

/** One-sentence practice tip for a move from its checkpoint results. */
export function practiceTip(name: string, results: readonly Pick<CheckpointResult, 'perLimb' | 'offsetSec'>[]): string {
  const limb = weakestLimb(results)
  const off = meanOffset(results)
  const timing =
    off === null || Math.abs(off) < TIMING_TIP_SEC
      ? ''
      : off > 0
        ? ' You were a little late: hit the pose on the beat, not after it.'
        : ' You were rushing: wait for the beat before you hit the pose.'
  if (!limb) return `Practice “${name}” slowly with the coach, then at full speed.${timing}`
  const part = LIMB_LABEL[limb]
  const focus = part === 'body' ? 'Keep your body leaning with the coach' : `Lead with your ${part} and match the coach’s shape`
  return `${focus} in “${name}”.${timing}`
}

export interface CountRow {
  judgment: Judgment
  label: string
  color: string
  count: number
}

export interface Spotlight {
  row: MoveRow
  /** Routine index to draw its pictogram from. */
  moveIndex: number
}

export interface ResultsView {
  score: string
  stars: number
  title: string
  blurb: string
  accuracy: string
  counts: CountRow[]
  maxCombo: number
  moves: MoveRow[]
  hardest: (Spotlight & { tip: string }) | null
  /** Omitted when it is the hardest move too. */
  best: Spotlight | null
  /** Judgment thresholds of the round (bar colours). */
  thresholds: ScoringConfig['thresholds']
}

const COUNT_ORDER: readonly Judgment[] = ['perfect', 'good', 'ok', 'miss']

function spotlight(m: MoveSummary | null, rows: readonly MoveRow[], routine: Pick<Routine, 'moves'>): Spotlight | null {
  if (!m) return null
  const row = rows.find((r) => r.id === m.id) ?? {
    id: m.id,
    name: m.name,
    accuracy: m.avgScore,
    checkpoints: m.checkpoints,
    firstIndex: m.moveIndex,
  }
  const moveIndex = routine.moves[m.moveIndex]?.id === m.id ? m.moveIndex : routine.moves.findIndex((x) => x.id === m.id)
  return moveIndex >= 0 ? { row, moveIndex } : null
}

export function buildResultsView(
  summary: ResultsSummary,
  results: readonly CheckpointResult[],
  routine: Pick<Routine, 'moves'>,
  thresholds: ScoringConfig['thresholds'] = DEFAULT_SCORING.thresholds,
): ResultsView {
  const { state } = summary
  const moves = moveRows(summary.perMove)
  const hard = spotlight(summary.hardestMove, moves, routine)
  const best = spotlight(summary.bestMove, moves, routine)
  const stars = clamp(Number.isFinite(state.stars) ? state.stars : 0, 0, 5)
  let hardest: ResultsView['hardest'] = null
  if (hard) {
    const id = hard.row.id
    const mine = results.filter((r) => routine.moves[r.checkpoint.moveIndex]?.id === id)
    hardest = { ...hard, tip: practiceTip(hard.row.name, mine) }
  }
  return {
    score: formatScore(state.score),
    stars,
    title: rankTitle(stars),
    blurb: rankBlurb(stars),
    accuracy: formatPercent(summary.accuracy),
    counts: COUNT_ORDER.map((j) => ({ judgment: j, label: JUDGMENT_STYLE[j].label.replace('!', ''), color: JUDGMENT_STYLE[j].color, count: state.counts[j] })),
    maxCombo: state.maxCombo,
    moves,
    hardest,
    best: best && best.row.id !== hard?.row.id ? best : null,
    thresholds,
  }
}
