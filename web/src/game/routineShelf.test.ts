import { describe, expect, it } from 'vitest'
import type { Routine } from '@shared/routine'
import routineExample from '@shared/examples/routine.example.json'
import {
  addToShelf,
  forgetRoutine,
  loadShelf,
  parseShelf,
  recipeOf,
  relativeTime,
  rememberRoutine,
  SHELF_KEY,
  SHELF_MAX,
  shelfEntryFor,
  type ShelfEntry,
} from './routineShelf'

const ROUTINE = routineExample as unknown as Routine

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init))
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

const hex = (n: number): string => n.toString(16).padStart(16, '0')

const entry = (n: number, over: Partial<ShelfEntry> = {}): ShelfEntry => ({
  routineId: hex(n),
  analysisId: 'a'.repeat(64),
  title: `Song ${n}`,
  difficulty: 'normal',
  mode: 'standing',
  seed: n,
  moves: 10,
  durationSec: 60,
  createdAt: 1000 + n,
  from: 'play',
  ...over,
})

describe('routine shelf', () => {
  it('most recent first, deduped by routineId, capped', () => {
    let list: ShelfEntry[] = []
    for (let i = 0; i < SHELF_MAX + 5; i++) list = addToShelf(list, entry(i))
    expect(list).toHaveLength(SHELF_MAX)
    expect(list[0].routineId).toBe(hex(SHELF_MAX + 4))
    list = addToShelf(list, entry(10, { createdAt: 99999 }))
    expect(list).toHaveLength(SHELF_MAX)
    expect(list[0]).toMatchObject({ routineId: hex(10), createdAt: 99999 })
    expect(list.filter((e) => e.routineId === hex(10))).toHaveLength(1)
  })

  it('keeps "from Analysis" when an Analysis routine is played', () => {
    const list = addToShelf([entry(1, { from: 'analysis' })], entry(1, { from: 'play', createdAt: 5 }))
    expect(list).toEqual([entry(1, { from: 'analysis', createdAt: 5 })])
  })

  it('persists, drops corrupt data and bad entries', () => {
    const s = memoryStorage()
    expect(loadShelf(s)).toEqual([])
    rememberRoutine(entry(1), s)
    rememberRoutine(entry(2, { from: 'analysis', songFile: 'a.wav', artist: 'X' }), s)
    expect(loadShelf(s).map((e) => e.routineId)).toEqual([hex(2), hex(1)])
    expect(loadShelf(s)[0]).toMatchObject({ songFile: 'a.wav', artist: 'X', from: 'analysis' })
    expect(forgetRoutine(hex(2), s).map((e) => e.routineId)).toEqual([hex(1)])
    expect(loadShelf(s)).toHaveLength(1)

    expect(loadShelf(memoryStorage({ [SHELF_KEY]: '{not json' }))).toEqual([])
    expect(loadShelf(memoryStorage({ [SHELF_KEY]: '{"a":1}' }))).toEqual([])
    expect(parseShelf([entry(3), { ...entry(4), routineId: 'nope' }, { ...entry(5), mode: 'flying' }, null])).toEqual([entry(3)])
    const throwing = {
      getItem: (): string | null => {
        throw new Error('denied')
      },
      setItem: (): void => {
        throw new Error('denied')
      },
    }
    expect(loadShelf(throwing)).toEqual([])
    expect(rememberRoutine(entry(1), throwing)).toEqual([entry(1)])
  })

  it('builds an entry + recipe from a generated routine', () => {
    const routine: Routine = { ...ROUTINE, difficulty: 'hard', mode: 'seated', seed: 42, meta: { routineId: hex(7) } }
    const analysis = { id: 'b'.repeat(64), title: 'Waltz', durationSec: 90, source: { kind: 'library' as const, file: 'waltz.mp3' } }
    const e = shelfEntryFor(routine, analysis, 'analysis', 123)
    expect(e).toEqual({
      routineId: hex(7),
      analysisId: 'b'.repeat(64),
      title: 'Waltz',
      difficulty: 'hard',
      mode: 'seated',
      seed: 42,
      moves: ROUTINE.moves.length,
      durationSec: 90,
      createdAt: 123,
      from: 'analysis',
      songFile: 'waltz.mp3',
    })
    expect(e && recipeOf(e)).toEqual({ analysisId: 'b'.repeat(64), difficulty: 'hard', mode: 'seated', seed: 42, songFile: 'waltz.mp3' })
    // Real-dancer routines keep their move source, so the recipe rebuilds the same routine.
    const aist = shelfEntryFor({ ...routine, meta: { routineId: hex(7), moveSource: 'aist' } }, analysis, 'play', 123)
    expect(aist?.moveSource).toBe('aist')
    expect(aist && recipeOf(aist)).toMatchObject({ seed: 42, moveSource: 'aist' })
    expect(parseShelf([aist])).toEqual([aist])
    expect(parseShelf([{ ...aist, moveSource: 'robots' }])[0]).not.toHaveProperty('moveSource')
    // Offline demo routines have no server id: nothing to shelve.
    expect(shelfEntryFor({ ...routine, meta: {} }, analysis, 'play')).toBeNull()
  })

  it('relative times', () => {
    const now = 10_000_000
    expect(relativeTime(now - 5_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 d ago')
  })
})
