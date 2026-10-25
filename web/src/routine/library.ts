// Pure helpers over the move library and routines for the gallery and analysis pages.

import type { LibraryMove } from '@shared/moves'
import type { Difficulty, Routine } from '@shared/routine'
import { JOINTS, MIRROR } from '@shared/skeleton'
import { mirrorPose } from './pose'

/**
 * A move as GET /api/moves lists it. The mirrored twins `<id>_m` of real-dancer clips are left out
 * by default (the payload would be twice the size); their base clips say `hasMirror: true` instead.
 * Never assume a twin is listed: build it with mirrorTwin.
 */
export type ListedMove = LibraryMove & { hasMirror?: boolean }

/** Suffix of a real-dancer clip's mirrored twin (server/app/moves/clips.py MIRROR_SUFFIX). */
export const MIRROR_SUFFIX = '_m'

/** The mirrored twin of a clip, exactly as the server compiles it (clips.py mirror_clip). */
export function mirrorTwin(m: LibraryMove): LibraryMove {
  const twin: LibraryMove = {
    ...m,
    id: m.id + MIRROR_SUFFIX,
    name: `${m.name} (mirrored)`,
    scoredJoints: JOINTS.filter((j) => m.scoredJoints.includes(MIRROR[j])),
    keyframes: m.keyframes.map((k) => ({ t: k.t, pose: mirrorPose(k.pose), root: [k.root[0] === 0 ? 0 : -k.root[0], k.root[1]] })),
    side: m.side === 'L' ? 'R' : m.side === 'R' ? 'L' : 'both',
    mirrorOf: m.id,
  }
  delete (twin as ListedMove).hasMirror
  return twin
}

/** Mirrored twins of hasMirror clips that the listing left out. */
export function unlistedTwins(moves: readonly ListedMove[]): LibraryMove[] {
  const ids = new Set(moves.map((m) => m.id))
  return moves.filter((m) => m.hasMirror && !ids.has(m.id + MIRROR_SUFFIX)).map(mirrorTwin)
}

/** The listing with every unlisted twin right after its clip (the full library, as `?mirrors=1` lists it). */
export function withMirrorTwins(moves: readonly ListedMove[]): LibraryMove[] {
  const ids = new Set(moves.map((m) => m.id))
  return moves.flatMap((m) => (m.hasMirror && !ids.has(m.id + MIRROR_SUFFIX) ? [m, mirrorTwin(m)] : [m]))
}

export interface MoveFilters {
  /** '' = any. */
  style: string
  difficulty: Difficulty | ''
  /** 0 = any, else exact 1..5. */
  intensity: number
  seatedOnly: boolean
  /** Case-insensitive substring of name, id, baseId or a style. */
  search: string
  /** '' = any; 'library' = classic moves, 'aist' = real-dancer clips. */
  source: '' | 'library' | 'aist'
}

export const NO_FILTERS: MoveFilters = { style: '', difficulty: '', intensity: 0, seatedOnly: false, search: '', source: '' }

export function filterMoves(moves: readonly LibraryMove[], f: MoveFilters): LibraryMove[] {
  const q = f.search.trim().toLowerCase()
  return moves.filter(
    (m) =>
      (!f.style || m.styles.includes(f.style)) &&
      (!f.difficulty || m.difficulty === f.difficulty) &&
      (!f.intensity || m.intensity === f.intensity) &&
      (!f.seatedOnly || m.upperBodyOnly) &&
      (!f.source || (m.source ?? 'library') === f.source) &&
      (!q || [m.name, m.id, m.baseId, ...m.styles].some((s) => s.toLowerCase().includes(q))),
  )
}

/** Sorted distinct styles. */
export function allStyles(moves: readonly LibraryMove[]): string[] {
  return [...new Set(moves.flatMap((m) => m.styles))].sort()
}

export interface LibraryStats {
  /** Every playable move, incl. the mirrored twins the listing left out. */
  moves: number
  /** Distinct baseIds (mirror pairs count once). */
  base: number
  seated: number
  byDifficulty: Record<Difficulty, number>
}

export function libraryStats(listed: readonly ListedMove[]): LibraryStats {
  const moves = withMirrorTwins(listed)
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

const INTENSITY_COLORS = ['#7dd3fc', '#818cf8', '#c084fc', '#f472b6', '#fb7185'] as const

/** Colour for intensity 1..5 (cool -> hot); clamped. */
export function intensityColor(intensity: number): string {
  const i = Math.min(5, Math.max(1, Math.round(Number.isFinite(intensity) ? intensity : 1)))
  return INTENSITY_COLORS[i - 1]
}
