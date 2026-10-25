import { describe, expect, it } from 'vitest'
import { isMoveLibrary, isRoutine } from '../api'
import { DEMO_LIBRARY, demoRoutine, mulberry32 } from './demo'
import { allStyles, filterMoves, intensityColor, libraryStats, mirrorTwin, NO_FILTERS, routineSummary, unlistedTwins, withMirrorTwins, type ListedMove } from './library'
import { mirrorPose } from './pose'

const MOVES = DEMO_LIBRARY.moves

describe('demo fixtures', () => {
  it('match the API contract', () => {
    expect(isMoveLibrary(DEMO_LIBRARY)).toBe(true)
    const ids = MOVES.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    const left = MOVES.find((m) => m.id === 'arm_raise_L')
    expect(left?.mirrorOf).toBe('arm_raise_R')
    expect(left?.scoredJoints).toEqual(['l_elbow', 'l_wrist'])
    expect(left?.keyframes[1].pose.l_wrist).toEqual([-0.6, -2.1])
  })

  it('builds deterministic, contract-valid demo routines', () => {
    const beats = Array.from({ length: 40 }, (_, i) => i * 0.5)
    const song = { id: 'x'.repeat(64), title: 'T', durationSec: 20, bpm: 120, beats, downbeats: beats.filter((_, i) => i % 4 === 0), sections: [] }
    const a = demoRoutine(song, DEMO_LIBRARY, { difficulty: 'easy', mode: 'seated', seed: 5 })
    expect(isRoutine(a)).toBe(true)
    expect(a).toEqual(demoRoutine(song, DEMO_LIBRARY, { difficulty: 'easy', mode: 'seated', seed: 5 }))
    expect(a.moves.every((m) => MOVES.find((l) => l.id === m.id)?.upperBodyOnly)).toBe(true)
    for (let i = 1; i < a.moves.length; i++) expect(a.moves[i].startTime).toBe(a.moves[i - 1].endTime)
    for (const m of a.moves) expect(m.startTime).toBe(beats[m.startBeat])
    const r = mulberry32(1)
    expect(r()).not.toBe(r())
  })
})

describe('library helpers', () => {
  it('filters by style, difficulty, intensity, seated and text', () => {
    expect(filterMoves(MOVES, NO_FILTERS)).toHaveLength(MOVES.length)
    expect(filterMoves(MOVES, { ...NO_FILTERS, style: 'disco' }).map((m) => m.baseId)).toEqual(['disco_point', 'disco_point'])
    expect(filterMoves(MOVES, { ...NO_FILTERS, difficulty: 'hard' }).map((m) => m.id)).toEqual(['star_jump'])
    expect(filterMoves(MOVES, { ...NO_FILTERS, intensity: 1 }).every((m) => m.intensity === 1)).toBe(true)
    expect(filterMoves(MOVES, { ...NO_FILTERS, seatedOnly: true }).every((m) => m.upperBodyOnly)).toBe(true)
    expect(filterMoves(MOVES, { ...NO_FILTERS, search: '  WAVE ' }).map((m) => m.id)).toEqual(['royal_wave_R', 'royal_wave_L'])
    expect(filterMoves(MOVES, { ...NO_FILTERS, search: 'latin' }).map((m) => m.baseId)).toEqual(['step_touch', 'step_touch'])
  })

  it('counts and lists styles', () => {
    expect(allStyles(MOVES)).toEqual(['disco', 'hiphop', 'latin', 'pop', 'storybook'])
    const s = libraryStats(MOVES)
    expect(s).toMatchObject({ moves: 10, base: 6, seated: 6 })
    expect(s.byDifficulty.easy + s.byDifficulty.normal + s.byDifficulty.hard).toBe(10)
  })

  it('summarizes a routine', () => {
    const r = {
      version: 1 as const,
      song: { title: 't', durationSec: 1, bpm: 1, beats: [], downbeats: [], sections: [] },
      difficulty: 'easy' as const,
      mode: 'standing' as const,
      seed: 1,
      moves: [],
      meta: { routineId: 'abc' },
    }
    expect(routineSummary(r)).toEqual({ routineId: 'abc', moves: 0, distinct: 0 })
    expect(routineSummary({ ...r, meta: undefined })).toEqual({ routineId: null, moves: 0, distinct: 0 })
  })

  it('colours intensities 1..5 and clamps', () => {
    const cs = [1, 2, 3, 4, 5].map(intensityColor)
    expect(new Set(cs).size).toBe(5)
    expect(intensityColor(0)).toBe(cs[0])
    expect(intensityColor(9)).toBe(cs[4])
    expect(intensityColor(Number.NaN)).toBe(cs[0])
  })
})

describe('source filter', () => {
  it('splits classic moves from real-dancer clips (moves without a source are classic)', () => {
    const clip = { ...MOVES[0], id: 'aist_po_002', baseId: 'aist_po_002', source: 'aist' as const, credit: 'AIST++' }
    const all = [...MOVES, clip]
    expect(filterMoves(all, { ...NO_FILTERS, source: 'aist' })).toEqual([clip])
    expect(filterMoves(all, { ...NO_FILTERS, source: 'library' })).toEqual(MOVES)
    expect(filterMoves(all, NO_FILTERS)).toHaveLength(MOVES.length + 1)
  })
})

describe('mirrored twins of real-dancer clips (GET /api/moves lists only the base clip)', () => {
  const base = MOVES.find((m) => m.id === 'arm_raise_R')
  if (!base) throw new Error('fixture')
  const clip: ListedMove = {
    ...base,
    id: 'aist_po_002',
    baseId: 'aist_po_002',
    name: 'Pop Arm Wave',
    side: 'both',
    mirrorOf: null,
    source: 'aist',
    credit: 'AIST++',
    hasMirror: true,
    keyframes: base.keyframes.map((k, i) => ({ ...k, root: [0.25 * i, -0.1] as [number, number] })),
  }

  it('builds the twin like the server does (L/R swapped, x and root x negated)', () => {
    const twin = mirrorTwin(clip)
    expect(twin).toMatchObject({ id: 'aist_po_002_m', baseId: 'aist_po_002', name: 'Pop Arm Wave (mirrored)', mirrorOf: 'aist_po_002', source: 'aist' })
    expect('hasMirror' in twin).toBe(false)
    expect(twin.scoredJoints).toEqual(['l_elbow', 'l_wrist'])
    twin.keyframes.forEach((k, i) => {
      expect(k.pose).toEqual(mirrorPose(clip.keyframes[i].pose))
      expect(k.root).toEqual([i === 0 ? 0 : -0.25 * i, -0.1])
    })
    expect(mirrorTwin({ ...base, side: 'L' }).side).toBe('R')
  })

  it('adds only twins that are not listed, and counts them in the stats', () => {
    expect(unlistedTwins([clip]).map((m) => m.id)).toEqual(['aist_po_002_m'])
    expect(unlistedTwins([clip, mirrorTwin(clip)])).toEqual([])
    expect(withMirrorTwins([clip, MOVES[0]]).map((m) => m.id)).toEqual(['aist_po_002', 'aist_po_002_m', MOVES[0].id])
    expect(libraryStats([...MOVES, clip])).toMatchObject({ moves: MOVES.length + 2, base: 7 })
    // A server that still lists every twin: nothing is added twice.
    expect(libraryStats([...MOVES, clip, mirrorTwin(clip)]).moves).toBe(MOVES.length + 2)
  })
})
