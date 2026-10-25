// Pure helpers over the move library and routines for the gallery and analysis pages.

import type { LibraryMove } from '@shared/moves'
import type { Difficulty, Routine } from '@shared/routine'

export interface MoveFilters {
  /** '' = any. */
  style: string
  difficulty: Difficulty | ''
  /** 0 = any, else exact 1..5. */
  intensity: number
  seatedOnly: boolean
  /** Case-insensitive substring of name, id, baseId or a style. */
  search: string
}

export const NO_FILTERS: MoveFilters = { style: '', difficulty: '', intensity: 0, seatedOnly: false, search: '' }

export function filterMoves(moves: readonly LibraryMove[], f: MoveFilters): LibraryMove[] {
  const q = f.search.trim().toLowerCase()
  return moves.filter(
    (m) =>
      (!f.style || m.styles.includes(f.style)) &&
      (!f.difficulty || m.difficulty === f.difficulty) &&
      (!f.intensity || m.intensity === f.intensity) &&
      (!f.seatedOnly || m.upperBodyOnly) &&
      (!q || [m.name, m.id, m.baseId, ...m.styles].some((s) => s.toLowerCase().includes(q))),
  )
}

/** Sorted distinct styles. */
export function allStyles(moves: readonly LibraryMove[]): string[] {
  return [...new Set(moves.flatMap((m) => m.styles))].sort()
}

export interface LibraryStats {
  moves: number
  /** Distinct baseIds (mirror pairs count once). */
  base: number
  seated: number
  byDifficulty: Record<Difficulty, number>
}

export function libraryStats(moves: readonly LibraryMove[]): LibraryStats {
  const byDifficulty: Record<Difficulty, number> = { easy: 0, normal: 0, hard: 0 }
  for (const m of moves) byDifficulty[m.difficulty] = (byDifficulty[m.difficulty] ?? 0) + 1
  return {
    moves: moves.length,
    base: new Set(moves.map((m) => m.baseId)).size,
    seated: moves.filter((m) => m.upperBodyOnly).length,
    byDifficulty,
  }
}

/** Summary of a generated routine for the analysis page. */
export function routineSummary(r: Routine): { routineId: string | null; moves: number; distinct: number } {
  const id = r.meta?.routineId
  return {
    routineId: typeof id === 'string' ? id : null,
    moves: r.moves.length,
    distinct: new Set(r.moves.map((m) => m.id)).size,
  }
}

const INTENSITY_COLORS = ['#d2e3ec', '#a3c3d8', '#dbb35e', '#c04f66', '#963248'] as const // Body Double palette, cool -> hot

/** Colour for intensity 1..5 (cool -> hot); clamped. */
export function intensityColor(intensity: number): string {
  const i = Math.min(5, Math.max(1, Math.round(Number.isFinite(intensity) ? intensity : 1)))
  return INTENSITY_COLORS[i - 1]
}
