import { describe, expect, it } from 'vitest'
import type { StorageLike } from '../lib/storage'
import type { CheckpointResult, Judgment } from './scoring'
import { countdownSfx, judgmentSfx, loadSfxEnabled, saveSfxEnabled, SFX_KEY, SFX_NOTES, SFX_VOLUME, sfxDuration, type SfxName } from './sfx'

type R = Pick<CheckpointResult, 'judgment' | 'unseen' | 'combo'>
const r = (judgment: Judgment, combo: number, unseen?: boolean): R => ({ judgment, combo, ...(unseen ? { unseen } : {}) })

describe('judgment sounds', () => {
  it('plays the best judgment of a batch', () => {
    expect(judgmentSfx([r('ok', 1)], 0)).toEqual(['ok'])
    expect(judgmentSfx([r('good', 1), r('perfect', 2)], 0)).toEqual(['perfect'])
    expect(judgmentSfx([], 3)).toEqual([])
  })

  it('thuds on a seen miss, stays quiet on an unseen one', () => {
    expect(judgmentSfx([r('miss', 0)], 0)).toEqual(['miss'])
    expect(judgmentSfx([r('miss', 0, true)], 0)).toEqual([])
  })

  it('twinkles on every 10th combo and sighs when a long combo breaks', () => {
    expect(judgmentSfx([r('good', 10)], 9)).toEqual(['good', 'combo'])
    expect(judgmentSfx([r('good', 20)], 19)).toEqual(['good', 'combo'])
    expect(judgmentSfx([r('good', 11)], 10)).toEqual(['good'])
    expect(judgmentSfx([r('miss', 0)], 7)).toEqual(['comboBreak'])
    expect(judgmentSfx([r('miss', 0, true)], 7)).toEqual(['comboBreak'])
    expect(judgmentSfx([r('miss', 0)], 3)).toEqual(['miss'])
  })
})

describe('count-in cues', () => {
  const plan = { times: [-0.9, -0.4, 0.1, 0.6] }

  it('ticks only the beats the clock does not click, then "go" on Dance!', () => {
    expect(countdownSfx(plan, [-0.9, -0.4], -1.5)).toEqual([
      { t: 0.1, name: 'tick' },
      { t: 0.6, name: 'go' },
    ])
    expect(countdownSfx(plan, [], -1.5).map((c) => c.name)).toEqual(['tick', 'tick', 'tick', 'go'])
  })

  it('skips cues before the start position (resume / seek) and without a plan', () => {
    expect(countdownSfx(plan, [], 0.3)).toEqual([{ t: 0.6, name: 'go' }])
    expect(countdownSfx(plan, [], 5)).toEqual([])
    expect(countdownSfx({ times: [] }, [], 0)).toEqual([])
  })
})

describe('sound recipes', () => {
  it('are short and quiet next to the music', () => {
    for (const name of Object.keys(SFX_NOTES) as SfxName[]) {
      expect(sfxDuration(name)).toBeGreaterThan(0)
      expect(sfxDuration(name)).toBeLessThan(name === 'fanfare' ? 2 : 0.6)
      for (const n of SFX_NOTES[name]) expect(n.gain * SFX_VOLUME).toBeLessThanOrEqual(0.15)
    }
  })

  it('remembers the toggle (default on)', () => {
    const data: Record<string, string> = {}
    const st: StorageLike = { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
    expect(loadSfxEnabled(st)).toBe(true)
    saveSfxEnabled(false, st)
    expect(data[SFX_KEY]).toBe('false')
    expect(loadSfxEnabled(st)).toBe(false)
    expect(loadSfxEnabled(null)).toBe(true)
  })
})
