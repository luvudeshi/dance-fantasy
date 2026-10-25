import { describe, expect, it } from 'vitest'
import type { Move, Routine } from '@shared/routine'
import { buildMotionTrack } from '../routine/track'
import routineJson from './__fixtures__/routine_synth120_normal.json'
import { BotPoseSource, type BotSkill } from './botSource'
import { buildCheckpoints, DEFAULT_SCORING } from './scoring'
import {
  addPass,
  barAt,
  beatInSegment,
  botPlan,
  buildSegments,
  COUNT_BEATS,
  countInAt,
  FrameBuffer,
  MAX_HISTORY,
  nextRate,
  passEnd,
  PassScorer,
  passStreak,
  segmentCheckpoints,
  segmentForMove,
  suggestionFor,
  teachScoring,
  type PassRecord,
  type TeachSegment,
} from './teach'

const routine = routineJson as unknown as Routine

/** A tiny routine on a 120 bpm grid (beat i at 0.5 + 0.5 i), downbeats every 4 beats. */
function gridRoutine(moves: Array<[startBeat: number, lengthBeats: number]>): Routine {
  const beats = Array.from({ length: 64 }, (_, i) => 0.5 + 0.5 * i)
  const ms: Move[] = moves.map(([b, n], i) => ({
    id: `m${i}`,
    name: `Move ${i}`,
    startBeat: b,
    lengthBeats: n,
    startTime: beats[b],
    endTime: beats[b] + 0.5 * n,
    intensity: 2,
    scoredJoints: ['l_wrist'],
    keyframes: [{ t: 0, pose: {} }],
  }))
  return {
    version: 1,
    song: {
      title: 'Grid',
      durationSec: 33,
      bpm: 120,
      beats,
      downbeats: beats.filter((_, i) => i % 4 === 0),
      sections: [
        { start: 0, end: 4.5, label: 'intro', energy: 0.3 },
        { start: 4.5, end: 33, label: 'chorus', energy: 0.9 },
      ],
    },
    difficulty: 'normal',
    mode: 'standing',
    seed: 1,
    moves: ms,
  }
}

describe('buildSegments', () => {
  const segs = buildSegments(routine)

  it('covers every move exactly once, in order, with ascending non-overlapping spans', () => {
    expect(segs.length).toBeGreaterThan(3)
    expect(segs.flatMap((s) => s.moveIndices)).toEqual(routine.moves.map((_, i) => i))
    segs.forEach((s, i) => {
      expect(s.index).toBe(i)
      expect(s.start).toBeCloseTo(routine.moves[s.moveIndices[0]].startTime)
      expect(s.end).toBeGreaterThan(s.start)
      if (i > 0) expect(s.start).toBeGreaterThanOrEqual(segs[i - 1].end - 1e-9)
    })
  })

  it('makes 8-counts on a regular routine, starting on bar lines', () => {
    const eight = segs.filter((s) => s.endBeat - s.startBeat === COUNT_BEATS)
    expect(eight.length / segs.length).toBeGreaterThan(0.7)
    const db = new Set(routine.song.downbeats.map((d) => d.toFixed(3)))
    expect(segs.filter((s) => db.has(s.start.toFixed(3))).length / segs.length).toBeGreaterThan(0.7)
  })

  it('gives each a "5 6 7 8" count-in before the start (never before 0 s) and a loop start before it', () => {
    for (const s of segs) {
      expect(s.countIn.length).toBeLessThanOrEqual(4)
      expect(s.countIn.map((c) => c.label)).toEqual(['5', '6', '7', '8'].slice(4 - s.countIn.length))
      for (const c of s.countIn) expect(c.time).toBeGreaterThanOrEqual(0)
      if (s.countIn.length > 0) expect(s.loopStart).toBeLessThanOrEqual(s.countIn[0].time)
      expect(s.loopStart).toBeGreaterThanOrEqual(0)
    }
    const later = segs[3]
    expect(later.countIn).toHaveLength(4)
    expect(later.countIn[3].time).toBeCloseTo(routine.song.beats[later.startBeat - 1])
  })

  it('labels with the section and bar numbers', () => {
    for (const s of segs) {
      expect(s.label).toMatch(/^(Intro|Verse|Chorus|Bridge|Outro) · bars? \d+(–\d+)?$/)
      expect(s.barEnd).toBeGreaterThanOrEqual(s.barStart)
      expect(s.moveNames.length).toBeGreaterThan(0)
    }
  })

  it('absorbs moves that do not start on a bar line, and keeps rests inside the 8-count', () => {
    // 4 + 2 + 2 beats, then a 2-beat move at beat 8 (bar line), 4 beats at 10 (off the bar line),
    // a rest, and a move at beat 20.
    const r = gridRoutine([
      [0, 4],
      [4, 2],
      [6, 2],
      [8, 2],
      [10, 4],
      [20, 4],
    ])
    const s = buildSegments(r)
    expect(s.map((x) => x.moveIndices)).toEqual([[0, 1, 2], [3, 4], [5]])
    expect(s[0].label).toBe('Intro · bars 1–2')
    expect(s[1].start).toBeCloseTo(4.5)
    expect(s[1].end).toBeCloseTo(8.5) // nominal 8-count end; the rest after move 4 is inside
    expect(s[1].label).toBe('Chorus · bars 3–4')
    expect(s[2].end).toBeCloseTo(r.moves[5].endTime)
    expect(s[0].countIn.map((c) => c.time)).toEqual([0]) // 4 beats before 0.5 s, clamped at 0 s
    expect(s[0].loopStart).toBe(0)
  })

  it('finds the segment of a move (0 when unknown)', () => {
    const r = gridRoutine([
      [0, 4],
      [4, 4],
      [8, 4],
      [12, 4],
    ])
    const s = buildSegments(r)
    expect(segmentForMove(s, 3)).toBe(1)
    expect(segmentForMove(s, 99)).toBe(0)
    expect(segmentForMove(s, null)).toBe(0)
  })
})

describe('count-in and beat counter', () => {
  const r = gridRoutine([
    [8, 4],
    [12, 4],
  ])
  const seg = buildSegments(r)[0]

  it('counts 5 6 7 8 into the 1', () => {
    const b = r.song.beats
    expect(countInAt(seg, b[3] + 0.4)).toBeNull()
    expect(countInAt(seg, b[4])?.label).toBe('5')
    expect(countInAt(seg, b[7] + 0.25)).toEqual({ label: '8', phase: 0.5 })
    expect(countInAt(seg, b[8])).toBeNull()
  })

  it('numbers the beats of the 8-count', () => {
    const b = r.song.beats
    expect(beatInSegment(b, seg, b[7])).toBe(0)
    expect(beatInSegment(b, seg, b[8])).toBe(1)
    expect(beatInSegment(b, seg, b[15] + 0.2)).toBe(8)
    expect(beatInSegment(b, seg, seg.end)).toBe(0)
  })

  it('finds bars', () => {
    expect(barAt([0.5, 2.5, 4.5], 0.1)).toBe(1)
    expect(barAt([0.5, 2.5, 4.5], 2.5)).toBe(2)
  })
})

describe('scoring at speed', () => {
  it('widens the window and the loop tail by the rate (real-time quantities)', () => {
    expect(teachScoring(DEFAULT_SCORING, 0.5).windowSec).toBeCloseTo(DEFAULT_SCORING.windowSec * 0.5)
    expect(passEnd({ end: 10 }, 0.5, 0.15, 0.12)).toBeCloseTo(10 + (0.15 + 0.12 + 0.15) * 0.5)
  })

  const segs = buildSegments(routine)
  const all = buildCheckpoints(routine, routine.mode)
  const track = buildMotionTrack(routine)
  const seg = segs.find((s) => segmentCheckpoints(all, s).length >= 6) as TeachSegment

  /** One pass of a bot at `rate`: the song clock advances rate/60 per 60 Hz frame. */
  function pass(skill: BotSkill, rate: 0.5 | 0.75 | 1, lagRealSec = 0): number | null {
    const scorer = new PassScorer(segmentCheckpoints(all, seg), rate)
    const bot = new BotPoseSource({ track, skill, seed: 3, lagSec: lagRealSec * rate })
    bot.onFrame((f) => scorer.addFrame(f))
    void bot.start()
    const end = passEnd(seg, rate, DEFAULT_SCORING.windowSec, 0)
    for (let t = seg.loopStart; t <= end; t += rate / 60) {
      bot.tick(t)
      scorer.advance(t)
    }
    scorer.close()
    expect(scorer.judged).toBe(scorer.total)
    return scorer.accuracy()
  }

  it('scores only the segment: a perfect dancer aces it at every speed, standing still fails', () => {
    expect(segmentCheckpoints(all, seg).every((cp) => cp.time >= seg.start - 0.02 && cp.time <= seg.end + 0.02)).toBe(true)
    for (const rate of [0.5, 0.75, 1] as const) expect(pass('perfect', rate)).toBeGreaterThan(90)
    expect(pass('idle', 0.5)).toBeLessThan(40)
  })

  it('a dancer 100 ms late (real time) still lands inside the real-time window at 0.5x', () => {
    expect(pass('perfect', 0.5, 0.1)).toBeGreaterThan(80)
  })

  it('ignores frames without a song time (from before a loop restart)', () => {
    const scorer = new PassScorer(segmentCheckpoints(all, seg), 1)
    expect(scorer.addFrame({ songTime: Number.NaN, pose: {}, visibility: {}, valid: true })).toEqual([])
    expect(scorer.accuracy()).toBeNull()
  })
})

describe('progression', () => {
  const rec = (segment: number, rate: 0.5 | 0.75 | 1, accuracy: number): PassRecord => ({ segment, rate, accuracy })

  it('counts consecutive good passes of this segment at this speed', () => {
    const h = [rec(0, 0.5, 90), rec(1, 0.5, 20), rec(0, 0.5, 85), rec(0, 0.5, 81)]
    expect(passStreak(h, 0, 0.5)).toBe(3) // other segments don't break it
    expect(passStreak([...h, rec(0, 0.5, 79)], 0, 0.5)).toBe(0)
    expect(passStreak([...h, rec(0, 0.75, 95)], 0, 0.5)).toBe(0)
  })

  it('suggests the next speed after two good passes, and "nailed" at 1x', () => {
    expect(suggestionFor([rec(2, 0.5, 90)], 2, 0.5)).toBeNull()
    expect(suggestionFor([rec(2, 0.5, 90), rec(2, 0.5, 80)], 2, 0.5)).toEqual({ kind: 'speed-up', next: 0.75 })
    expect(suggestionFor([rec(2, 0.75, 90), rec(2, 0.75, 99)], 2, 0.75)).toEqual({ kind: 'speed-up', next: 1 })
    expect(suggestionFor([rec(2, 1, 90), rec(2, 1, 99)], 2, 1)).toEqual({ kind: 'nailed' })
    expect(nextRate(1)).toBeNull()
  })

  it('keeps a bounded history', () => {
    let h: PassRecord[] = []
    for (let i = 0; i < MAX_HISTORY + 5; i++) h = addPass(h, rec(0, 1, i))
    expect(h).toHaveLength(MAX_HISTORY)
    expect(h[h.length - 1].accuracy).toBe(MAX_HISTORY + 4)
  })

  it('the demo bot improves every pass', () => {
    const plans = [0, 1, 2, 3, 4].map(botPlan)
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].noiseDeg).toBeLessThanOrEqual(plans[i - 1].noiseDeg)
      expect(plans[i].lagSec).toBeLessThanOrEqual(plans[i - 1].lagSec)
    }
    expect(plans[0].lagSec).toBeGreaterThan(0.08) // the first pass earns a "late" tip
    expect(plans[4].noiseDeg).toBeLessThan(10)
  })
})

describe('FrameBuffer', () => {
  it('finds the frame nearest a time, skipping invalid / timeless frames', () => {
    const fb = new FrameBuffer(3)
    const f = (t: number, valid = true) => ({ songTime: t, pose: {}, visibility: {}, valid })
    fb.push(f(1))
    fb.push(f(1.1, false))
    fb.push(f(Number.NaN))
    fb.push(f(1.2))
    fb.push(f(1.3))
    fb.push(f(1.4))
    expect(fb.nearest(1.12)?.songTime).toBe(1.2)
    expect(fb.nearest(1)?.songTime).toBe(1.2) // 1.0 was evicted (max 3); 1.2 is within 0.25 s
    expect(fb.nearest(5)).toBeNull()
    fb.clear()
    expect(fb.nearest(1.3)).toBeNull()
  })
})
