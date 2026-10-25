import { describe, expect, it } from 'vitest'
import { crossedBeat, DriftMeter, estimateSongTime, percentile, SyncMonitor, syncSummary } from './sync'

describe('estimateSongTime', () => {
  it('extrapolates the output timestamp to the frame time, relative to the song start', () => {
    expect(estimateSongTime({ contextTime: 10, performanceTime: 5000 }, 5016, 4)).toBeCloseTo(6.016, 9)
    expect(estimateSongTime({ contextTime: 10, performanceTime: 5000 }, 4990, 4)).toBeCloseTo(5.99, 9)
  })

  it('is null without a valid timestamp or a running song', () => {
    expect(estimateSongTime(null, 1, 0)).toBeNull()
    expect(estimateSongTime({ contextTime: 10, performanceTime: 5000 }, 1, null)).toBeNull()
    expect(estimateSongTime({ contextTime: 0, performanceTime: 0 }, 1, 0)).toBeNull()
    expect(estimateSongTime({}, 1, 0)).toBeNull()
    expect(estimateSongTime({ contextTime: Number.NaN, performanceTime: 5 }, 1, 0)).toBeNull()
  })
})

describe('crossedBeat', () => {
  const beats = [1, 2, 3]
  it('returns the newest beat in (prevT, t]', () => {
    expect(crossedBeat(beats, 0.9, 1)).toBe(0)
    expect(crossedBeat(beats, 1, 1.5)).toBe(-1)
    expect(crossedBeat(beats, 0.5, 2.5)).toBe(1)
    expect(crossedBeat(beats, 2, 2)).toBe(-1)
    expect(crossedBeat(beats, 2.5, 1.5)).toBe(-1) // backwards (restart)
    expect(crossedBeat(beats, -1, 0.5)).toBe(-1)
    expect(crossedBeat([], 0, 1)).toBe(-1)
  })
})

describe('percentile', () => {
  it('nearest rank', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(xs, 95)).toBe(95)
    expect(percentile(xs, 100)).toBe(100)
    expect(percentile([5], 95)).toBe(5)
    expect(percentile([], 95)).toBe(0)
  })
})

describe('DriftMeter', () => {
  it('aggregates max |drift|, signed mean, p95, rejects and long frames', () => {
    const m = new DriftMeter()
    for (const d of [2, -4, 6]) m.addDrift(d)
    m.addDrift(1500) // bogus timestamp, not drift
    m.addDrift(Number.NaN)
    for (const f of [16.7, 40, 16.6, 33]) m.addFrame(f)
    expect(m.stats()).toEqual({
      beats: 3,
      maxDriftMs: 6,
      meanDriftMs: expect.closeTo(4 / 3, 9),
      p95DriftMs: 6,
      lastDriftMs: 6,
      rejected: 2,
      frames: 4,
      longFrames: 1,
      maxFrameMs: 40,
    })
    m.reset()
    expect(m.stats()).toMatchObject({ beats: 0, maxDriftMs: 0, meanDriftMs: 0, p95DriftMs: 0, lastDriftMs: null, frames: 0 })
  })

  it('formats the end-of-song summary line', () => {
    const m = new DriftMeter()
    m.addDrift(3)
    m.addDrift(-1.25)
    m.addFrame(50)
    expect(syncSummary(m.stats())).toBe('sync: beats=2 maxDrift=3.0 ms p95=3.0 ms longFrames=1')
  })
})

describe('SyncMonitor', () => {
  it('samples drift once per beat crossing against the independent estimate', () => {
    const mon = new SyncMonitor([1, 2, 3])
    const asked: number[] = []
    const est = (ms: number): number => {
      asked.push(ms)
      return 0.997
    }
    expect(mon.frame(1000, 0.98, est)).toBeNull() // first frame only arms
    expect(mon.frame(1016.7, 1.0, est)).toBeCloseTo(3, 9) // crossed beat 1: drawn 1.000 vs heard 0.997
    expect(mon.frame(1033.4, 1.016, est)).toBeNull()
    expect(asked).toEqual([1016.7]) // estimate only on crossings, at the frame's rAF time
    expect(mon.stats()).toMatchObject({ beats: 1, maxDriftMs: expect.closeTo(3, 9), frames: 2, longFrames: 0 })
  })

  it('a break in continuity (hidden tab) is neither a long frame nor a stale crossing', () => {
    const mon = new SyncMonitor([1, 2, 3])
    const est = (): number => 0
    mon.frame(1000, 0.5, est)
    mon.breakContinuity()
    expect(mon.frame(9000, 2.5, est)).toBeNull() // crossed 1 and 2 while hidden: ignored
    mon.frame(9016, 2.52, est)
    expect(mon.stats()).toMatchObject({ beats: 0, frames: 1, longFrames: 0 })
    mon.frame(9100, 2.6, est)
    expect(mon.stats().longFrames).toBe(1)
  })

  it('skips the sample when no estimate is available; reset clears everything', () => {
    const mon = new SyncMonitor([1])
    mon.frame(0, 0.9, () => null)
    expect(mon.frame(16, 1.01, () => null)).toBeNull()
    expect(mon.stats().beats).toBe(0)
    mon.reset()
    expect(mon.stats().frames).toBe(0)
    expect(mon.summary()).toBe('sync: beats=0 maxDrift=0.0 ms p95=0.0 ms longFrames=0')
  })
})
