// "Moves from": which moves a routine is choreographed from (shared/moves.ts MoveSource):
// our classic angle-based library, real-dancer clips derived from AIST++, or a mix. The lobby
// remembers the choice on this device; generated routines say what they used in meta.

import type { LibraryMove, MoveSource, MoveSourcesResponse } from '@shared/moves'
import type { Routine } from '@shared/routine'
import { defaultStorage, readJson, writeJson, type StorageLike } from '../lib/storage'

export type { MoveSource }

export const MOVE_SOURCE_KEY = 'midnight-ball.move-source.v1'
/**
 * The lobby's default. Mix passed QA on the real clip file (smooth capped transitions, fair bot scores);
 * flip to 'classic' here to change it. The API's own default (requests without moveSource) stays classic.
 */
export const DEFAULT_MOVE_SOURCE: MoveSource = 'mix'

/** The in-app credit line whenever real-dancer moves are in use. */
export const AIST_CREDIT = 'Real-dancer moves: AIST++ (CC BY 4.0) · AIST Dance Video Database'
/** The short credit on a real-dancer move's card (the full one, with the source take, is in its detail view). */
export const AIST_CARD_CREDIT = 'AIST++ (CC BY 4.0) · AIST Dance Video Database'

export const MOVE_SOURCES: readonly { value: MoveSource; label: string; hint: string }[] = [
  { value: 'classic', label: 'Classic', hint: 'Our storybook move library: clean, readable, easy to follow.' },
  { value: 'aist', label: 'Real dancers', hint: 'Moves captured from real dancers (pop, lock, house, ballet jazz…), ending on a storybook bow or wave. Seated routines borrow some classic moves.' },
  { value: 'mix', label: 'Mix', hint: 'Classic moves and real-dancer moves in one routine.' },
]

export const isMoveSource = (v: unknown): v is MoveSource => v === 'classic' || v === 'aist' || v === 'mix'

export const moveSourceLabel = (s: MoveSource): string => MOVE_SOURCES.find((o) => o.value === s)?.label ?? s

export function loadMoveSource(storage: StorageLike | null = defaultStorage()): MoveSource {
  const v = readJson(MOVE_SOURCE_KEY, storage)
  return isMoveSource(v) ? v : DEFAULT_MOVE_SOURCE
}

export function saveMoveSource(source: MoveSource, storage: StorageLike | null = defaultStorage()): void {
  writeJson(MOVE_SOURCE_KEY, source, storage)
}

/** What a generated routine was made from (meta.moveSource; older routines are classic). */
export function routineMoveSource(r: Pick<Routine, 'meta'>): MoveSource {
  const v = r.meta?.moveSource
  return isMoveSource(v) ? v : 'classic'
}

/** How many of a routine's moves are real-dancer clips (meta.aistMoves; 0 when absent). */
export function routineAistMoves(r: Pick<Routine, 'meta'>): number {
  const v = r.meta?.aistMoves
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** " · real dancers" / " · mix" for setup lines; nothing for classic (keeps old labels unchanged). */
export function moveSourceSuffix(s: MoveSource | undefined): string {
  return !s || s === 'classic' ? '' : ` · ${moveSourceLabel(s).toLowerCase()}`
}

/** A library move's source (older servers send none: library). */
export const librarySourceOf = (m: Pick<LibraryMove, 'source'>): 'library' | 'aist' => m.source ?? 'library'

/** Whether the server has any real-dancer clips (null = unknown, e.g. offline or an older server). */
export function hasRealDancers(s: MoveSourcesResponse | null): boolean | null {
  return s ? s.aist.moves > 0 : null
}

/** " · Moves from: Real dancers (24 of 40 moves) · <credit>" for the results line ('' for classic routines). */
export function movesFromDetail(r: Pick<Routine, 'meta' | 'moves'>): string {
  const source = routineMoveSource(r)
  const aist = routineAistMoves(r)
  if (source === 'classic' && aist === 0) return ''
  const credit = aist > 0 ? ` · ${AIST_CREDIT}` : ''
  return ` · Moves from: ${moveSourceLabel(source)} (${aist} of ${r.moves.length} moves by real dancers)${credit}`
}
