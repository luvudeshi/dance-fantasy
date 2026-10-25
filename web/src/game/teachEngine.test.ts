// End-to-end teach flow on a fake clock: the demo bot dances one 8-count over and over; tips
// appear, passes are recorded, 0.5x -> 0.75x -> 1x is suggested and the segment gets nailed.

import { describe, expect, it } from 'vitest'
import type { Routine } from '@shared/routine'
import { buildMotionTrack } from '../routine/track'
import routineJson from './__fixtures__/routine_synth120_normal.json'
import { loopAction, type LoopAction, type TeachRate } from './mediaClock'
import { buildCheckpoints, DEFAULT_SCORING } from './scoring'
import { buildSegments, segmentCheckpoints, suggestionFor } from './teach'
import { TeachEngine, type TeachClockLike } from './teachEngine'

const routine = routineJson as unknown as Routine

class FakeClock implements TeachClockLike {
  rate: TeachRate = 1
  playing = false
  t = 0
  region: { start: number; end: number } | null = null
  looping = true
  setRate(r: TeachRate): void {
    this.rate = r
  }
  setLoop(start: number, end: number, preRollSec = 0): void {
    this.region = { start: Math.max(0, start - preRollSec), end }
  }
  setLooping(on: boolean): void {
    this.looping = on
  }
  seek(t: number): void {
    this.t = t
  }
  play(): Promise<void> {
    this.playing = true
    return Promise.resolve()
  }
  pause(): void {
    this.playing = false
  }
  update(): LoopAction {
    if (!this.region || !this.playing) return 'none'
    const a = loopAction(this.t, this.region.end, this.looping)
    if (a !== 'none') this.t = this.region.start
    if (a === 'stop') this.playing = false
    return a
  }
  songTime(): number {
    return this.t
  }
}

function setup() {
  const clock = new FakeClock()
  const segments = buildSegments(routine)
  const checkpoints = buildCheckpoints(routine, routine.mode)
  const segment = segments.findIndex((s) => segmentCheckpoints(checkpoints, s).length >= 6)
  let nowMs = 0
  const engine = new TeachEngine({
    clock,
    routine,
    track: buildMotionTrack(routine),
    segments,
    checkpoints,
    base: DEFAULT_SCORING,
    calLatencySec: 0.12,
    initialSegment: segment,
    now: () => nowMs,
  })
  /** Runs `realSec` of 60 Hz frames; returns the tips seen. */
  const run = (realSec: number): string[] => {
    const tips: string[] = []
    for (let i = 0; i < realSec * 60; i++) {
      nowMs += 1000 / 60
      if (clock.playing) clock.t += clock.rate / 60
      const v = engine.frame(nowMs)
      if (v.tip && tips[tips.length - 1] !== v.tip.hint.text) tips.push(v.tip.hint.text)
    }
    return tips
  }
  return { clock, engine, segments, segment, run }
}

describe('TeachEngine', () => {
  it('starts on the requested segment at 0.5x, parked at its count-in', () => {
    const { clock, engine, segments, segment } = setup()
    const s = engine.getSnapshot()
    expect(s.segment).toBe(segment)
    expect(s.rate).toBe(0.5)
    expect(clock.rate).toBe(0.5)
    expect(clock.t).toBe(segments[segment].loopStart)
    expect(clock.region?.end).toBeGreaterThan(segments[segment].end)
    expect(s.pass).toEqual({ judged: 0, total: expect.any(Number), accuracy: null })
    expect(s.pass.total).toBeGreaterThanOrEqual(6)
  })

  it('teaches with the bot: tips, recorded passes, speed-ups and "nailed it"', async () => {
    const { engine, segment, segments, run } = setup()
    engine.useBot()
    await engine.play()
    const passSec = (s: (typeof segments)[number], rate: number) => (s.end - s.loopStart + 0.6) / rate
    const tips = run(passSec(segments[segment], 0.5) * 2)
    expect(engine.getSnapshot().history.length).toBe(2)
    expect(tips.some((t) => / (late|early)$/.test(t))).toBe(true) // the first pass is late
    expect(tips.length).toBeGreaterThan(2)

    // Keep looping at 0.5x until the speed-up is offered, then take it, etc.
    for (const rate of [0.5, 0.75, 1] as const) {
      if (engine.getSnapshot().rate !== rate) engine.selectRate(rate)
      for (let k = 0; k < 6; k++) {
        const s = engine.getSnapshot()
        if (suggestionFor(s.history, s.segment, rate)) break
        run(passSec(segments[segment], rate))
      }
      const sug = suggestionFor(engine.getSnapshot().history, segment, rate)
      expect(sug).not.toBeNull()
    }
    const s = engine.getSnapshot()
    expect(s.nailed.has(segment)).toBe(true)
    expect(s.history.every((h) => h.segment === segment)).toBe(true)
    expect(s.history[s.history.length - 1]).toMatchObject({ rate: 1 })
    expect(s.history[s.history.length - 1].accuracy).toBeGreaterThanOrEqual(80)
    expect(s.history[0].accuracy).toBeLessThan(80) // the demo bot starts sloppy
  })

  it('does not record passes while no pose source is live', async () => {
    const { engine, segments, segment, run } = setup()
    await engine.play()
    run((segments[segment].end - segments[segment].loopStart + 1) / 0.5 + 1)
    expect(engine.getSnapshot().history).toHaveLength(0)
    expect(engine.getSnapshot().source).toBeNull()
  })

  it('switching segment or speed goes back to the count-in; loop off stops after one pass', async () => {
    const { clock, engine, segments, segment, run } = setup()
    engine.useBot()
    await engine.play()
    run(1)
    const next = Math.min(segments.length - 1, segment + 1)
    engine.selectSegment(next)
    expect(clock.t).toBe(segments[next].loopStart)
    expect(engine.getSnapshot().playing).toBe(true)
    engine.selectRate(1)
    expect(clock.rate).toBe(1)
    engine.setLooping(false)
    run(segments[next].end - segments[next].loopStart + 2)
    const s = engine.getSnapshot()
    expect(s.playing).toBe(false)
    expect(clock.t).toBe(segments[next].loopStart)
    expect(s.history).toHaveLength(1)
    expect(s.history[0]).toMatchObject({ segment: next, rate: 1 })
  })
})
