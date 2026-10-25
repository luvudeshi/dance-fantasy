import { describe, expect, it } from 'vitest'
import type { Section } from '@shared/routine'
import {
  beatPeriod,
  beatPulse,
  buildGameTimeline,
  COUNTDOWN_LEAD_SEC,
  countdownAt,
  countdownPlan,
  cueSlotSec,
  GO_HOLD_SEC,
  layoutCueStrip,
  moveCountdown,
  sectionAt,
  withLeadInBeats,
  type CueStripGeometry,
} from './cues'

// 120 BPM grid from 0 s: beat i at i * 0.5.
const BEATS = Array.from({ length: 64 }, (_, i) => i * 0.5)
const mv = (startBeat: number, lengthBeats: number) => ({
  startBeat,
  lengthBeats,
  startTime: BEATS[startBeat],
  endTime: BEATS[startBeat + lengthBeats],
})
// 2-4 s, 4-5 s, 5-5.5 s, 5.5-7.5 s, 7.5-11.5 s
const MOVES = [mv(4, 4), mv(8, 2), mv(10, 1), mv(11, 4), mv(15, 8)]

const GEO: CueStripGeometry = { hitX: 100, leftX: 20, rightX: 900, cardW: 80, gap: 20, slotSec: cueSlotSec(MOVES) }
const SPACING = GEO.cardW + GEO.gap
const SPEED = SPACING / GEO.slotSec

describe('beatPulse', () => {
  const beats = [1, 2]
  it('is 1 on the beat and decays to 0 over ~150 ms', () => {
    expect(beatPulse(beats, 0.5)).toBe(0)
    expect(beatPulse(beats, 1)).toBe(1)
    expect(beatPulse(beats, 1.075)).toBeCloseTo(0.25, 9)
    expect(beatPulse(beats, 1.15)).toBeCloseTo(0, 9)
    expect(beatPulse(beats, 1.6)).toBe(0)
    expect(beatPulse(beats, 2)).toBe(1)
    let prev = 1
    for (let t = 1.01; t < 1.15; t += 0.01) {
      const p = beatPulse(beats, t)
      expect(p).toBeLessThan(prev)
      prev = p
    }
  })

  it('honours a custom decay and an empty grid', () => {
    expect(beatPulse(beats, 1.15, 0.3)).toBeCloseTo(0.25, 9)
    expect(beatPulse([], 1)).toBe(0)
  })
})

describe('beat grid helpers', () => {
  it('beatPeriod uses bpm, else the median gap', () => {
    expect(beatPeriod({ beats: [0, 0.5], bpm: 120 })).toBe(0.5)
    expect(beatPeriod({ beats: [0, 0.4, 0.8, 1.3], bpm: 0 })).toBeCloseTo(0.4, 9)
    expect(beatPeriod({ beats: [], bpm: 0 })).toBe(0.5)
  })

  it('withLeadInBeats extrapolates the grid backwards', () => {
    expect(withLeadInBeats([0.2, 0.7], 0.5, -1)).toEqual([-0.8, -0.3, 0.2, 0.7])
    expect(withLeadInBeats([0.2, 0.7], 0.5, 0.5)).toEqual([0.2, 0.7])
    expect(withLeadInBeats([], 0.5, -1)).toEqual([])
  })
})

describe('count-in', () => {
  const beats = BEATS.map((b) => b + 0.2) // first beat at 0.2 s

  it('uses the three real beats before the first move when there is room', () => {
    const plan = countdownPlan({ beats, bpm: 120 }, { startBeat: 4, startTime: beats[4] })
    expect(plan.times).toEqual([0.7, 1.2, 1.7, 2.2].map((t) => expect.closeTo(t, 9)))
    expect(plan.preRollSec).toBe(0)
  })

  it('extrapolates beats before the song and asks for a pre-roll when the first move starts near 0', () => {
    const plan = countdownPlan({ beats, bpm: 120 }, { startBeat: 0, startTime: 0.2 })
    expect(plan.times).toEqual([-1.3, -0.8, -0.3, 0.2].map((t) => expect.closeTo(t, 9)))
    expect(plan.preRollSec).toBeCloseTo(COUNTDOWN_LEAD_SEC + 1.3, 9)
    const mixed = countdownPlan({ beats, bpm: 120 }, { startBeat: 1, startTime: beats[1] })
    expect(mixed.times).toEqual([-0.8, -0.3, 0.2, 0.7].map((t) => expect.closeTo(t, 9)))
  })

  it('counts 3, 2, 1 on the beats, then "Dance!" exactly at the first move', () => {
    const plan = countdownPlan({ beats, bpm: 120 }, { startBeat: 0, startTime: 0.2 })
    expect(countdownAt(plan, -1.31)).toBeNull()
    expect(countdownAt(plan, -1.3)).toEqual({ label: '3', phase: 0, step: 0 })
    expect(countdownAt(plan, -1.05)).toMatchObject({ label: '3', phase: expect.closeTo(0.5, 9) })
    expect(countdownAt(plan, -0.8)).toMatchObject({ label: '2', step: 1 })
    expect(countdownAt(plan, -0.3)).toMatchObject({ label: '1', step: 2 })
    expect(countdownAt(plan, 0.19)).toMatchObject({ label: '1' })
    expect(countdownAt(plan, 0.2)).toEqual({ label: 'Dance!', phase: 0, step: 3 })
    expect(countdownAt(plan, 0.2 + GO_HOLD_SEC)).toBeNull()
    expect(countdownAt({ times: [], preRollSec: 0 }, 0)).toBeNull()
  })

  it('handles a routine without moves', () => {
    expect(countdownPlan({ beats, bpm: 120 }, undefined)).toEqual({ times: [], preRollSec: 0 })
  })

  it('buildGameTimeline lines the beat pulse and count-in clicks up with the count-in', () => {
    const tl = buildGameTimeline({
      song: { title: 't', durationSec: 32, bpm: 120, beats, downbeats: [], sections: [] },
      moves: [{ ...mv(0, 4), startTime: 0.2, endTime: 2.2, id: 'a', name: 'A', intensity: 1, scoredJoints: [], keyframes: [] }],
    })
    for (const t of tl.countdown.times) expect(beatPulse(tl.pulseBeats, t)).toBeCloseTo(1, 9)
    expect(tl.countInClicks).toEqual([-1.3, -0.8, -0.3].map((t) => expect.closeTo(t, 9)))
    expect(tl.pulseBeats[0]).toBeLessThanOrEqual(-tl.countdown.preRollSec)
  })
})

describe('moveCountdown', () => {
  it('shows 3, 2, 1 on the beats before each move change', () => {
    expect(moveCountdown(BEATS, MOVES, 0)).toBe(0) // 4 beats out
    expect(moveCountdown(BEATS, MOVES, 0.5)).toBe(3)
    expect(moveCountdown(BEATS, MOVES, 1.2)).toBe(2)
    expect(moveCountdown(BEATS, MOVES, 1.5)).toBe(1)
    expect(moveCountdown(BEATS, MOVES, 2)).toBe(0) // move 0 starts; move 1 is 4 beats away
    expect(moveCountdown(BEATS, MOVES, 2.5)).toBe(3)
    expect(moveCountdown(BEATS, MOVES, 3.99)).toBe(1)
    expect(moveCountdown(BEATS, MOVES, 4)).toBe(2) // 2-beat move: its countdown starts at 2
    expect(moveCountdown(BEATS, MOVES, 5)).toBe(1) // 1-beat move
    expect(moveCountdown(BEATS, MOVES, 9)).toBe(0) // last move playing
    expect(moveCountdown(BEATS, [], 1)).toBe(0)
    // Before the first beat (count-in lead-in) the big 3-2-1 overlay owns the countdown.
    expect(moveCountdown([0.2, 0.7, 1.2], [{ startBeat: 0, startTime: 0.2, endTime: 1.2 }], -0.5)).toBe(0)
    expect(moveCountdown([0.2, 0.7, 1.2], [{ startBeat: 2, startTime: 1.2, endTime: 2 }], 0.1)).toBe(0)
  })
})

describe('sectionAt', () => {
  const sections: Section[] = [
    { start: 0, end: 4, label: 'verse', energy: 0.4 },
    { start: 4, end: 8, label: 'chorus', energy: 0.8 },
  ]
  it('finds the section, clamping before / after', () => {
    expect(sectionAt(sections, -1)?.label).toBe('verse')
    expect(sectionAt(sections, 3.99)?.label).toBe('verse')
    expect(sectionAt(sections, 4)?.label).toBe('chorus')
    expect(sectionAt(sections, 99)?.label).toBe('chorus')
    expect(sectionAt([], 1)).toBeNull()
  })
})

describe('cue strip layout', () => {
  it('slot = shortest gap between move starts', () => {
    expect(cueSlotSec(MOVES)).toBeCloseTo(0.5, 9)
    expect(cueSlotSec([{ startTime: 1, endTime: 3 }])).toBe(2)
    expect(cueSlotSec([])).toBe(2)
  })

  it('each card reaches the hit marker exactly at its move startTime, and is then active', () => {
    MOVES.forEach((m, i) => {
      const card = layoutCueStrip(MOVES, m.startTime, GEO).find((c) => c.index === i)
      expect(card).toBeDefined()
      expect(card?.x).toBeCloseTo(GEO.hitX, 9)
      expect(card?.active).toBe(true)
      expect(card?.alpha).toBe(1)
    })
  })

  it('approaches from the right at a constant speed (x = hitX + (startTime - t) * speed)', () => {
    for (const lead of [0.05, 0.25, 0.5, 1.5]) {
      const t = MOVES[0].startTime - lead
      const card = layoutCueStrip(MOVES, t, GEO).find((c) => c.index === 0)
      expect(card?.x).toBeCloseTo(GEO.hitX + lead * SPEED, 9)
      expect(card?.active).toBe(false)
    }
  })

  it('keeps cards ordered and never overlapping', () => {
    for (let t = -1; t < 13; t += 0.037) {
      const cards = layoutCueStrip(MOVES, t, GEO)
      for (let k = 1; k < cards.length; k++) {
        expect(cards[k].index).toBe(cards[k - 1].index + 1)
        expect(cards[k].x - cards[k - 1].x).toBeGreaterThanOrEqual(SPACING - 1e-9)
      }
      for (const c of cards) if (c.x < GEO.hitX) expect(c.alpha).toBeLessThan(1) // leaving: fades
      expect(cards.filter((c) => c.active).length).toBeLessThanOrEqual(1)
    }
  })

  it('shows every upcoming card already inside the strip before the routine starts', () => {
    // 1.9 s: move 0 at 120, 1 at 520, 2 at 720, 3 at 820 (left edge 780 < 900), 4 at 1220.
    expect(layoutCueStrip(MOVES, 1.9, GEO).map((c) => c.index)).toEqual([0, 1, 2, 3])
  })

  it('new cards only enter at the right edge, never pop in mid-strip', () => {
    const dt = 0.01
    let prev: Set<number> | null = null
    for (let t = -1; t < 13; t += dt) {
      const cards = layoutCueStrip(MOVES, t, GEO)
      for (const c of cards) {
        if (!prev || prev.has(c.index)) continue
        expect(c.x - GEO.cardW / 2).toBeGreaterThan(GEO.rightX - SPEED * dt - 1e-6)
      }
      prev = new Set(cards.map((c) => c.index))
    }
  })

  it('parks the current card at the marker, then the next card pushes it out (fading)', () => {
    // Move 0 is 2-4 s; move 1 arrives at 4 s, one slot (0.5 s) of travel per card.
    const parked = layoutCueStrip(MOVES, 3, GEO).find((c) => c.index === 0)
    expect(parked).toMatchObject({ x: GEO.hitX, active: true, alpha: 1, progress: expect.closeTo(0.5, 9) })
    const pushed = layoutCueStrip(MOVES, 3.75, GEO).find((c) => c.index === 0)
    expect(pushed?.x).toBeCloseTo(GEO.hitX - SPACING / 2, 9)
    expect(pushed?.alpha).toBeCloseTo(0.5, 9)
    expect(pushed?.active).toBe(true)
    expect(layoutCueStrip(MOVES, 4, GEO).some((c) => c.index === 0)).toBe(false)
  })

  it('pushes the last card out as the final move ends (like every other card)', () => {
    const last = MOVES.length - 1 // 7.5-11.5 s
    expect(layoutCueStrip(MOVES, 11, GEO).find((c) => c.index === last)?.x).toBeCloseTo(GEO.hitX, 9)
    const leaving = layoutCueStrip(MOVES, 11.25, GEO).find((c) => c.index === last)
    expect(leaving?.x).toBeCloseTo(GEO.hitX - SPACING / 2, 9)
    expect(leaving?.alpha).toBeCloseTo(0.5, 9)
    expect(layoutCueStrip(MOVES, 11.5, GEO)).toEqual([])
    expect(layoutCueStrip(MOVES, 20, GEO)).toEqual([])
  })

  it('culls cards beyond the strip and fades them in at the right edge', () => {
    const narrow = { ...GEO, rightX: 300 }
    expect(layoutCueStrip(MOVES, 0, narrow)).toEqual([]) // move 0 is still 2 s (400 px) out
    const entering = layoutCueStrip(MOVES, 1.05, narrow) // move 0 centre at 290: card spans 250-330
    expect(entering.map((c) => c.index)).toEqual([0])
    expect(entering[0].x).toBeCloseTo(290, 9)
    expect(entering[0].alpha).toBeCloseTo((300 - 250) / 80, 9)
    expect(layoutCueStrip(MOVES, 1.25, { ...GEO, leftX: 400, rightX: 900 })).toEqual(
      layoutCueStrip(MOVES, 1.25, GEO).filter((c) => c.x + GEO.cardW / 2 > 400),
    )
  })

  it('handles no moves', () => {
    expect(layoutCueStrip([], 1, GEO)).toEqual([])
  })
})
