import { describe, expect, it } from 'vitest'
import { audibleContextTime, beatIndexAt, songTime } from './clock'

interface FakeCtx {
  currentTime: number
  baseLatency: number
  outputLatency: number
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number }
}

const asCtx = (c: FakeCtx): AudioContext => c as unknown as AudioContext

describe('beatIndexAt', () => {
  const beats = [0.5, 1.0, 1.5, 2.0]
  it('returns the last beat at or before t', () => {
    expect(beatIndexAt(beats, 0)).toBe(-1)
    expect(beatIndexAt(beats, 0.5)).toBe(0)
    expect(beatIndexAt(beats, 0.99)).toBe(0)
    expect(beatIndexAt(beats, 1.0)).toBe(1)
    expect(beatIndexAt(beats, 99)).toBe(3)
    expect(beatIndexAt([], 1)).toBe(-1)
  })
})

describe('audibleContextTime', () => {
  it('uses getOutputTimestamp, extrapolated to now', () => {
    const ctx = asCtx({
      currentTime: 10.05,
      baseLatency: 0.005,
      outputLatency: 0.02,
      getOutputTimestamp: () => ({ contextTime: 10.0, performanceTime: 5000 }),
    })
    expect(audibleContextTime(ctx, 5016)).toBeCloseTo(10.016, 9)
  })

  it('falls back to currentTime minus latency when the timestamp is missing or bogus', () => {
    const base = { currentTime: 10, baseLatency: 0.01, outputLatency: 0.04 }
    expect(audibleContextTime(asCtx(base), 0)).toBeCloseTo(9.95, 9)
    const zero = asCtx({ ...base, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) })
    expect(audibleContextTime(zero, 1234)).toBeCloseTo(9.95, 9)
    const future = asCtx({ ...base, getOutputTimestamp: () => ({ contextTime: 12, performanceTime: 1000 }) })
    expect(audibleContextTime(future, 1000)).toBeCloseTo(9.95, 9)
  })

  it('songTime can ignore latency compensation', () => {
    const ctx = asCtx({ currentTime: 3, baseLatency: 0.01, outputLatency: 0.2 })
    expect(songTime({ ctx, startAt: 1, compensateLatency: false })).toBeCloseTo(2, 9)
    expect(songTime({ ctx, startAt: 1, compensateLatency: true }, 0)).toBeCloseTo(1.79, 9)
  })
})
