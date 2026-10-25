// "Your routines": the routines generated on this device (Analysis tab or Play), most recent
// first, in localStorage. An entry is a recipe, not the routine: the server keeps routines by
// id, and the same analysis + difficulty + mode + seed always rebuilds the same one.

import type { Analysis } from '@shared/analysis'
import type { Difficulty, Mode, Routine } from '@shared/routine'
import { isRoutineId } from '../lib/hashRoute'
import { defaultStorage, readJson, writeJson, type StorageLike } from '../lib/storage'
import type { RoutineRecipe } from './session'

export const SHELF_KEY = 'midnight-ball.routines.v1'
export const SHELF_MAX = 20

export interface ShelfEntry {
  routineId: string
  analysisId: string
  title: string
  artist?: string
  difficulty: Difficulty
  mode: Mode
  seed: number
  moves: number
  durationSec: number
  /** Date.now() when generated / last played. */
  createdAt: number
  from: 'analysis' | 'play'
  /** Library song file, so a cleared analysis can be recomputed. */
  songFile?: string
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parseEntry(v: unknown): ShelfEntry | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const { difficulty, mode, from } = r
  if (
    !isRoutineId(r.routineId) ||
    !isStr(r.analysisId) ||
    !isStr(r.title) ||
    (difficulty !== 'easy' && difficulty !== 'normal' && difficulty !== 'hard') ||
    (mode !== 'standing' && mode !== 'seated') ||
    !isNum(r.seed) ||
    !isNum(r.moves) ||
    !isNum(r.durationSec) ||
    !isNum(r.createdAt) ||
    (from !== 'analysis' && from !== 'play')
  ) {
    return null
  }
  const e: ShelfEntry = {
    routineId: r.routineId,
    analysisId: r.analysisId,
    title: r.title,
    difficulty,
    mode,
    seed: r.seed,
    moves: r.moves,
    durationSec: r.durationSec,
    createdAt: r.createdAt,
    from,
  }
  if (isStr(r.artist)) e.artist = r.artist
  if (isStr(r.songFile)) e.songFile = r.songFile
  return e
}

/** Valid entries from untrusted JSON (bad entries dropped; anything else -> empty). */
export function parseShelf(v: unknown): ShelfEntry[] {
  if (!Array.isArray(v)) return []
  return v.map(parseEntry).filter((e): e is ShelfEntry => e !== null).slice(0, SHELF_MAX)
}

/**
 * `entry` goes to the front; an older copy of the same routine is replaced (keeping "from
 * Analysis" if either was), and the list is capped at `max`.
 */
export function addToShelf(list: readonly ShelfEntry[], entry: ShelfEntry, max = SHELF_MAX): ShelfEntry[] {
  const old = list.find((e) => e.routineId === entry.routineId)
  const merged: ShelfEntry = old?.from === 'analysis' ? { ...entry, from: 'analysis' } : entry
  return [merged, ...list.filter((e) => e.routineId !== entry.routineId)].slice(0, max)
}

export function removeFromShelf(list: readonly ShelfEntry[], routineId: string): ShelfEntry[] {
  return list.filter((e) => e.routineId !== routineId)
}

/** The shelf entry for a generated routine (null when it has no server routineId). */
export function shelfEntryFor(
  routine: Routine,
  analysis: Pick<Analysis, 'id' | 'title' | 'artist' | 'source' | 'durationSec'>,
  from: ShelfEntry['from'],
  now = Date.now(),
): ShelfEntry | null {
  const id = routine.meta?.routineId
  if (!isRoutineId(id)) return null
  const e: ShelfEntry = {
    routineId: id,
    analysisId: analysis.id,
    title: analysis.title,
    difficulty: routine.difficulty,
    mode: routine.mode,
    seed: routine.seed,
    moves: routine.moves.length,
    durationSec: analysis.durationSec,
    createdAt: now,
    from,
  }
  if (analysis.artist) e.artist = analysis.artist
  if (analysis.source.kind === 'library' && analysis.source.file) e.songFile = analysis.source.file
  return e
}

export const recipeOf = (e: ShelfEntry): RoutineRecipe => ({
  analysisId: e.analysisId,
  difficulty: e.difficulty,
  mode: e.mode,
  seed: e.seed,
  ...(e.songFile ? { songFile: e.songFile } : {}),
})

export function loadShelf(storage: StorageLike | null = defaultStorage()): ShelfEntry[] {
  return parseShelf(readJson(SHELF_KEY, storage))
}

/** Adds `entry` to the stored shelf; returns the new list. */
export function rememberRoutine(entry: ShelfEntry, storage: StorageLike | null = defaultStorage()): ShelfEntry[] {
  const list = addToShelf(loadShelf(storage), entry)
  writeJson(SHELF_KEY, list, storage)
  return list
}

export function forgetRoutine(routineId: string, storage: StorageLike | null = defaultStorage()): ShelfEntry[] {
  const list = removeFromShelf(loadShelf(storage), routineId)
  writeJson(SHELF_KEY, list, storage)
  return list
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function relativeTime(thenMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, (nowMs - thenMs) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}
