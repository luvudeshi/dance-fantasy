import { describe, expect, it } from 'vitest'
import { barSeekTarget, effectiveRehearsal, loadRehearsal, REHEARSAL_KEY, saveRehearsal } from './rehearsal'

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init))
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

describe('rehearsal choice', () => {
  it('is remembered, defaulting to Just play', () => {
    const s = memoryStorage()
    expect(loadRehearsal(s)).toBe('none')
    saveRehearsal('watch', s)
    expect(loadRehearsal(s)).toBe('watch')
    expect(loadRehearsal(memoryStorage({ [REHEARSAL_KEY]: '"dance!"' }))).toBe('none')
    expect(loadRehearsal(memoryStorage({ [REHEARSAL_KEY]: '{oops' }))).toBe('none')
    expect(loadRehearsal(null)).toBe('none')
  })

  it('autoplay turns a practice run into a preview', () => {
    expect(effectiveRehearsal('practice', true)).toBe('watch')
    expect(effectiveRehearsal('practice', false)).toBe('practice')
    expect(effectiveRehearsal('watch', true)).toBe('watch')
    expect(effectiveRehearsal('none', true)).toBe('none')
  })
})

describe('barSeekTarget', () => {
  const bars = [0.5, 2.5, 4.5, 6.5]

  it('forward: the next bar start', () => {
    expect(barSeekTarget(bars, -1.2, 1)).toBe(0.5) // from the count-in
    expect(barSeekTarget(bars, 1, 1)).toBe(2.5)
    expect(barSeekTarget(bars, 2.48, 1)).toBe(4.5) // (almost) on a bar: the one after
    expect(barSeekTarget(bars, 7, 1)).toBeNull()
  })

  it('back: the start of this bar, or the previous one right after a bar start', () => {
    expect(barSeekTarget(bars, 3.6, -1)).toBe(2.5)
    expect(barSeekTarget(bars, 2.7, -1)).toBe(0.5)
    expect(barSeekTarget(bars, 0.9, -1)).toBe(0)
    expect(barSeekTarget(bars, 0, -1)).toBeNull()
    expect(barSeekTarget(bars, -1, -1)).toBeNull()
    expect(barSeekTarget([0, 2], 2.2, -1)).toBe(0)
    expect(barSeekTarget([], 5, -1)).toBe(0)
  })
})
