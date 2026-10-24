import { describe, expect, it } from 'vitest'
import { RateMeter } from './rateMeter'

describe('RateMeter', () => {
  it('counts events in the last window', () => {
    const m = new RateMeter(1000)
    for (let t = 0; t < 2000; t += 40) m.add(t, 12) // 25 per second
    expect(m.rate(1999)).toBe(25)
    expect(m.mean(1999)).toBeCloseTo(12, 9)
  })

  it('forgets old events and returns 0 when idle', () => {
    const m = new RateMeter(1000)
    m.add(0, 5)
    m.add(500, 15)
    expect(m.mean(600)).toBe(10)
    expect(m.rate(1200)).toBe(1)
    expect(m.mean(1200)).toBe(15)
    expect(m.rate(5000)).toBe(0)
    expect(m.mean(5000)).toBe(0)
  })

  it('stays correct over long runs (compaction)', () => {
    const m = new RateMeter(1000)
    for (let i = 0; i < 100_000; i++) m.add(i * 10, i % 2)
    expect(m.rate(999_990)).toBe(100)
    expect(m.mean(999_990)).toBeCloseTo(0.5, 9)
  })
})
