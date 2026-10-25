import { describe, expect, it } from 'vitest'
import type { StorageLike } from '../lib/storage'
import { DEFAULT_JUDGING, JUDGING_KEY, JUDGING_PRESETS, judgingLabel, loadJudging, saveJudging, scoringFor } from './judging'
import { DEFAULT_SCORING } from './scoring'

function memStorage(init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...init }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

describe('judging presets', () => {
  it('maps Standard to the default scoring and orders the others by strictness', () => {
    expect(scoringFor('standard')).toBe(DEFAULT_SCORING)
    const [l, s, t] = (['lenient', 'standard', 'strict'] as const).map(scoringFor)
    expect(l.windowSec).toBe(0.2)
    expect(t.windowSec).toBe(0.12)
    expect(l.thresholds).toEqual({ perfect: 85, good: 68, ok: 48 })
    expect(t.thresholds).toEqual({ perfect: 92, good: 80, ok: 60 })
    expect([l.perfectDeg, l.zeroDeg, t.perfectDeg, t.zeroDeg]).toEqual([20, 70, 12, 55])
    expect(l.windowSec > s.windowSec && s.windowSec > t.windowSec).toBe(true)
    // Everything else (limb weights, visibility) is shared.
    expect(l.limbWeights).toBe(s.limbWeights)
    expect(t.minVisibility).toBe(s.minVisibility)
  })

  it('labels every preset', () => {
    expect(JUDGING_PRESETS.map((p) => judgingLabel(p.value))).toEqual(['Lenient', 'Standard', 'Strict'])
  })

  it('remembers the choice and ignores junk', () => {
    const st = memStorage()
    expect(loadJudging(st)).toBe(DEFAULT_JUDGING)
    saveJudging('strict', st)
    expect(loadJudging(st)).toBe('strict')
    expect(loadJudging(memStorage({ [JUDGING_KEY]: '"brutal"' }))).toBe('standard')
    expect(loadJudging(memStorage({ [JUDGING_KEY]: '{oops' }))).toBe('standard')
    expect(loadJudging(null)).toBe('standard')
  })
})
