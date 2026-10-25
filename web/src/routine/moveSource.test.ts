import { describe, expect, it } from 'vitest'
import type { MoveSourcesResponse } from '@shared/moves'
import type { Routine } from '@shared/routine'
import routineExample from '@shared/examples/routine.example.json'
import type { StorageLike } from '../lib/storage'
import {
  AIST_CREDIT,
  DEFAULT_MOVE_SOURCE,
  hasRealDancers,
  isMoveSource,
  librarySourceOf,
  loadMoveSource,
  MOVE_SOURCE_KEY,
  MOVE_SOURCES,
  moveSourceLabel,
  moveSourceSuffix,
  movesFromDetail,
  routineAistMoves,
  routineMoveSource,
  saveMoveSource,
} from './moveSource'

const ROUTINE = routineExample as unknown as Routine

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

const sources = (aist: number): MoveSourcesResponse => ({
  version: 'v',
  attribution: aist ? 'credit' : null,
  clipsError: null,
  library: { moves: 82, baseMoves: 50 },
  aist: { moves: aist, baseMoves: aist / 2 },
})

describe('move source', () => {
  it('offers Classic / Real dancers / Mix, mix by default', () => {
    expect(MOVE_SOURCES.map((m) => [m.value, m.label])).toEqual([
      ['classic', 'Classic'],
      ['aist', 'Real dancers'],
      ['mix', 'Mix'],
    ])
    expect(DEFAULT_MOVE_SOURCE).toBe('mix')
    expect(moveSourceLabel('aist')).toBe('Real dancers')
    expect(isMoveSource('mix')).toBe(true)
    expect(isMoveSource('robots')).toBe(false)
  })

  it('is remembered on this device (bad or missing values fall back to the default)', () => {
    const storage = memoryStorage()
    expect(loadMoveSource(storage)).toBe(DEFAULT_MOVE_SOURCE)
    saveMoveSource('aist', storage)
    expect(storage.data.get(MOVE_SOURCE_KEY)).toBe('"aist"')
    expect(loadMoveSource(storage)).toBe('aist')
    storage.data.set(MOVE_SOURCE_KEY, '"robots"')
    expect(loadMoveSource(storage)).toBe(DEFAULT_MOVE_SOURCE)
    storage.data.set(MOVE_SOURCE_KEY, '{broken')
    expect(loadMoveSource(storage)).toBe(DEFAULT_MOVE_SOURCE)
    expect(loadMoveSource(null)).toBe(DEFAULT_MOVE_SOURCE)
    saveMoveSource('classic', storage)
    expect(loadMoveSource(storage)).toBe('classic') // an explicit Classic is remembered
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => saveMoveSource('mix', throwing)).not.toThrow()
    expect(loadMoveSource(throwing)).toBe(DEFAULT_MOVE_SOURCE)
  })

  it('reads what a routine was made from (older routines are classic)', () => {
    expect(routineMoveSource(ROUTINE)).toBe('classic')
    expect(routineAistMoves(ROUTINE)).toBe(0)
    const aist = { ...ROUTINE, meta: { moveSource: 'aist', aistMoves: 2 } }
    expect(routineMoveSource(aist)).toBe('aist')
    expect(routineAistMoves(aist)).toBe(2)
    expect(routineMoveSource({ ...ROUTINE, meta: { moveSource: 'disco' } })).toBe('classic')
    expect(routineAistMoves({ ...ROUTINE, meta: { aistMoves: 'many' } })).toBe(0)
  })

  it('labels setups and results', () => {
    expect(moveSourceSuffix(undefined)).toBe('')
    expect(moveSourceSuffix('classic')).toBe('')
    expect(moveSourceSuffix('aist')).toBe(' · real dancers')
    expect(moveSourceSuffix('mix')).toBe(' · mix')
    expect(movesFromDetail(ROUTINE)).toBe('')
    const n = ROUTINE.moves.length
    expect(movesFromDetail({ ...ROUTINE, meta: { moveSource: 'mix', aistMoves: 1 } })).toBe(
      ` · Moves from: Mix (1 of ${n} moves by real dancers) · ${AIST_CREDIT}`,
    )
    // Asked for real dancers but the server had none: say so, without a credit.
    expect(movesFromDetail({ ...ROUTINE, meta: { moveSource: 'aist', aistMoves: 0 } })).toBe(
      ` · Moves from: Real dancers (0 of ${n} moves by real dancers)`,
    )
    expect(AIST_CREDIT).toBe('Real-dancer moves: AIST++ (CC BY 4.0) · AIST Dance Video Database')
  })

  it('knows whether the server has real-dancer moves', () => {
    expect(hasRealDancers(null)).toBeNull()
    expect(hasRealDancers(sources(0))).toBe(false)
    expect(hasRealDancers(sources(400))).toBe(true)
    expect(librarySourceOf({})).toBe('library')
    expect(librarySourceOf({ source: 'aist' })).toBe('aist')
  })
})
