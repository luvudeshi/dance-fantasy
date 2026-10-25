import { describe, expect, it } from 'vitest'
import type { LimbName } from '@shared/skeleton'
import { JUDGMENT_STYLE } from './hud'
import {
  buildResultsView,
  formatPercent,
  formatScore,
  meanOffset,
  moveRows,
  practiceTip,
  rankTitle,
  roundDetails,
  scoreBand,
  scoreColor,
  weakestLimb,
} from './results'
import { DEFAULT_SCORING, type CheckpointResult, type Judgment, type MoveSummary, type ResultsSummary } from './scoring'

const ms = (moveIndex: number, id: string, avgScore: number, checkpoints = 2): MoveSummary => ({
  moveIndex,
  id,
  name: id.replace(/_/g, ' '),
  avgScore,
  checkpoints,
})

function cr(moveIndex: number, perLimb: Partial<Record<LimbName, number>>, offsetSec: number | null, judgment: Judgment = 'ok'): CheckpointResult {
  return {
    checkpoint: { index: 0, moveIndex, time: 0, target: {}, limbs: Object.keys(perLimb) as LimbName[] },
    score: 50,
    judgment,
    offsetSec,
    perLimb,
  }
}

describe('formatting', () => {
  it('formats scores with separators and percents clamped to 0..100', () => {
    expect(formatScore(1234567.4)).toBe('1,234,567')
    expect(formatScore(0)).toBe('0')
    expect(formatScore(Number.NaN)).toBe('0')
    expect(formatPercent(86.6)).toBe('87%')
    expect(formatPercent(-3)).toBe('0%')
    expect(formatPercent(140)).toBe('100%')
  })

  it('ranks stars with storybook titles', () => {
    expect(rankTitle(5)).toBe('Midnight Princess')
    expect(rankTitle(4.2)).toBe('Belle of the Ball')
    expect(rankTitle(0)).toBe('Shy Wallflower')
  })

  it('colours bars by the judgment thresholds', () => {
    const t = DEFAULT_SCORING.thresholds
    expect(scoreBand(100)).toBe('perfect')
    expect(scoreBand(t.perfect)).toBe('perfect')
    expect(scoreBand(t.good)).toBe('good')
    expect(scoreBand(t.ok)).toBe('ok')
    expect(scoreBand(t.ok - 0.1)).toBe('miss')
    expect(scoreBand(80, { perfect: 90, good: 70, ok: 50 })).toBe('good')
    expect(scoreColor(100)).toBe(JUDGMENT_STYLE.perfect.color)
  })
})

describe('moveRows', () => {
  it('merges repeats by id (checkpoint-weighted), sorts best first, ties in routine order', () => {
    const rows = moveRows([
      ms(0, 'step_touch', 50, 2),
      ms(1, 'arm_wave', 80, 2),
      ms(2, 'step_touch', 80, 4), // (50*2 + 80*4) / 6 = 70
      ms(3, 'disco', 80, 1),
      ms(4, 'idle_hold', 0, 0), // never judged: dropped
    ])
    expect(rows.map((r) => [r.id, Math.round(r.accuracy), r.checkpoints, r.firstIndex])).toEqual([
      ['arm_wave', 80, 2, 1],
      ['disco', 80, 1, 3],
      ['step_touch', 70, 6, 0],
    ])
  })
})

describe('practice tips', () => {
  it('names the weakest limb on average and the timing tendency', () => {
    // Per result the worst limbs differ; on average the right forearm (55) is weaker than the left (60).
    const res = [cr(0, { l_forearm: 40, r_forearm: 90 }, 0.1), cr(0, { l_forearm: 80, r_forearm: 20 }, 0.12)]
    expect(weakestLimb(res)).toBe('r_forearm')
    expect(meanOffset(res)).toBeCloseTo(0.11, 9)
    const tip = practiceTip('Arm Wave', [cr(0, { l_upper_arm: 20, torso: 90 }, 0.1)])
    expect(tip).toContain('left arm')
    expect(tip).toContain('Arm Wave')
    expect(tip).toContain('late')
    expect(practiceTip('Arm Wave', [cr(0, { r_shin: 10 }, -0.2)])).toContain('rushing')
    expect(practiceTip('Arm Wave', [cr(0, { r_shin: 10 }, 0.01)])).not.toMatch(/late|rushing/)
  })

  it('falls back to a generic tip without data', () => {
    expect(practiceTip('Twirl', [cr(0, {}, null)])).toBe('Practice “Twirl” slowly with the coach, then at full speed.')
    expect(meanOffset([cr(0, {}, null)])).toBeNull()
  })
})

describe('buildResultsView', () => {
  const routine = {
    moves: [{ id: 'step_touch' }, { id: 'arm_wave' }, { id: 'step_touch' }, { id: 'disco' }],
  } as unknown as Parameters<typeof buildResultsView>[2]

  const summary = (o: Partial<ResultsSummary> = {}): ResultsSummary => ({
    state: {
      score: 12345,
      combo: 3,
      maxCombo: 17,
      counts: { perfect: 10, good: 5, ok: 2, miss: 3 },
      stars: 3.6,
      judged: 20,
      total: 20,
    },
    accuracy: 78.4,
    perMove: [ms(0, 'step_touch', 60), ms(1, 'arm_wave', 90), ms(2, 'step_touch', 70), ms(3, 'disco', 85)],
    hardestMove: ms(0, 'step_touch', 65, 4),
    bestMove: ms(1, 'arm_wave', 90),
    ...o,
  })

  it('formats the headline numbers and keeps P/G/O/M order', () => {
    const v = buildResultsView(summary(), [], routine)
    expect(v.score).toBe('12,345')
    expect(v.accuracy).toBe('78%')
    expect(v.maxCombo).toBe(17)
    expect(v.stars).toBe(3.6)
    expect(v.title).toBe('Courtly Dancer')
    expect(v.counts.map((c) => [c.label, c.count])).toEqual([
      ['PERFECT', 10],
      ['GOOD', 5],
      ['OK', 2],
      ['MISS', 3],
    ])
    expect(v.moves.map((m) => m.id)).toEqual(['arm_wave', 'disco', 'step_touch'])
  })

  it('spotlights the hardest move with a tip from all its repeats, and the best move', () => {
    const results = [cr(0, { l_shin: 10, r_shin: 90 }, null), cr(2, { l_shin: 30, r_shin: 95 }, null), cr(1, { r_shin: 0 }, null)]
    const v = buildResultsView(summary(), results, routine)
    expect(v.hardest?.moveIndex).toBe(0)
    expect(v.hardest?.row.accuracy).toBeCloseTo(65, 9) // merged step_touch row
    expect(v.hardest?.tip).toContain('left leg') // arm_wave's right shin isn't counted
    expect(v.best?.row.id).toBe('arm_wave')
    expect(v.best?.moveIndex).toBe(1)
  })

  it('hides the best move when it is the hardest one, and survives an empty game', () => {
    const one = buildResultsView(summary({ bestMove: ms(0, 'step_touch', 65) }), [], routine)
    expect(one.best).toBeNull()
    const empty = buildResultsView(
      summary({ perMove: [], hardestMove: null, bestMove: null, accuracy: 0, state: { ...summary().state, score: 0, stars: Number.NaN } }),
      [],
      routine,
    )
    expect(empty.hardest).toBeNull()
    expect(empty.best).toBeNull()
    expect(empty.moves).toEqual([])
    expect(empty.stars).toBe(0)
    expect(empty.score).toBe('0')
  })

  it('finds the move by id when the summary index points elsewhere', () => {
    const v = buildResultsView(summary({ hardestMove: ms(1, 'disco', 40) }), [], routine)
    expect(v.hardest?.moveIndex).toBe(3)
  })
})

describe('round details line', () => {
  it('names the judging and the latency used', () => {
    expect(roundDetails({ judging: 'Standard', latencySec: 0.1234, latencySource: 'measured', autoplay: false })).toBe(
      'Judging: Standard · camera latency 123 ms (measured)',
    )
    expect(roundDetails({ judging: 'Lenient', latencySec: 0.12, latencySource: 'default', autoplay: false })).toBe(
      'Judging: Lenient · camera latency 120 ms (default)',
    )
    expect(roundDetails({ judging: 'Strict', latencySec: null, autoplay: true })).toBe('Judging: Strict · danced by the bot')
  })

  it('colours bars with the round\'s own thresholds', () => {
    expect(scoreColor(86)).toBe(JUDGMENT_STYLE.good.color)
    expect(scoreColor(86, { perfect: 85, good: 68, ok: 48 })).toBe(JUDGMENT_STYLE.perfect.color)
  })
})
