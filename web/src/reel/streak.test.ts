import { describe, expect, it } from 'vitest'
import type { Judgment } from '../game/scoring'
import { KEEP_STREAK, START_STREAK, StreakTracker } from './streak'

const J: Record<string, Judgment> = { P: 'perfect', G: 'good', O: 'ok', M: 'miss' }
const run = (t: StreakTracker, s: string) => [...s].map((c) => t.push(J[c]).type)

describe('StreakTracker', () => {
  it('starts recording on the 3rd Good-or-better in a row', () => {
    expect(START_STREAK).toBe(3)
    expect(run(new StreakTracker(), 'PGP')).toEqual(['none', 'none', 'start'])
    expect(run(new StreakTracker(), 'PGOPGG')).toEqual(['none', 'none', 'none', 'none', 'none', 'start'])
  })

  it('OK breaks a streak like a miss', () => {
    const t = new StreakTracker()
    run(t, 'PPPP')
    expect(t.push('ok')).toEqual({ type: 'discard', length: 4 })
  })

  it('discards a streak that breaks before 8', () => {
    const t = new StreakTracker()
    run(t, 'PPPPPPP')
    expect(t.push('miss')).toEqual({ type: 'discard', length: KEEP_STREAK - 1 })
    expect(t.current).toBe(0)
  })

  it('keeps a streak of 8 or more', () => {
    const t = new StreakTracker()
    run(t, 'PPPPGGGGPP')
    expect(t.push('miss')).toEqual({ type: 'keep', length: 10 })
    expect(t.longest).toBe(10)
  })

  it('a short break is nothing to discard', () => {
    const t = new StreakTracker()
    expect(run(t, 'PPMPM')).toEqual(['none', 'none', 'none', 'none', 'none'])
  })

  it('unseen checkpoints break the streak', () => {
    const t = new StreakTracker()
    run(t, 'PPP')
    expect(t.push('good', true).type).toBe('discard')
  })

  it('end() at the song end keeps or discards', () => {
    const a = new StreakTracker()
    run(a, 'PPPPPPPP')
    expect(a.end()).toEqual({ type: 'keep', length: 8 })
    const b = new StreakTracker()
    run(b, 'PPP')
    expect(b.end()).toEqual({ type: 'discard', length: 3 })
  })
})
