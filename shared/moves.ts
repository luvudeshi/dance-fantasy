// Move library served by GET /api/moves. Matches server/app/moves/types.py (CompiledMove).

import type { JointName, Pose2D, Vec2 } from './skeleton'
import type { Difficulty } from './routine'

export type BodyPart = 'arms' | 'legs' | 'torso' | 'head'

/** Where a library move comes from: our angle-based moves, or a real-dancer clip (AIST++). */
export type LibraryMoveSource = 'library' | 'aist'

/** Which moves a routine is choreographed from: classic library moves, real-dancer clips, or both. */
export type MoveSource = 'classic' | 'aist' | 'mix'

export interface MoveKeyframe {
  /** 0..1 within the move. */
  t: number
  /** All 17 joints, body frame. */
  pose: Pose2D
  /** Rendering only: mid-hip offset from neutral standing, body units, +y down. */
  root: Vec2
}

export interface LibraryMove {
  /** Unique, e.g. "arm_wave_L". */
  id: string
  /** Shared by a mirror pair, e.g. "arm_wave". */
  baseId: string
  name: string
  /** 1, 2, 4 or 8. */
  lengthBeats: number
  /** 1..5 */
  intensity: number
  difficulty: Difficulty
  bodyParts: BodyPart[]
  /** Usable in seated mode. */
  upperBodyOnly: boolean
  styles: string[]
  scoredJoints: JointName[]
  keyframes: MoveKeyframe[]
  startAnchor: string
  endAnchor: string
  side: 'L' | 'R' | 'both'
  mirrorOf: string | null
  /** Absent from older servers (= 'library'). Real-dancer clips have startAnchor/endAnchor "free". */
  source?: LibraryMoveSource
  /** Attribution line for real-dancer clips; null for library moves. */
  credit?: string | null
  /**
   * Real-dancer clips only: the clip has a mirrored twin `<id>_m`, which GET /api/moves leaves out unless
   * asked with `?mirrors=1`. The twin is this move with id `<id>_m`, name `<name> (mirrored)`,
   * `mirrorOf: <id>`, side L <-> R, scoredJoints and every pose's joints swapped l_ <-> r_ with x negated,
   * root x negated (shared/README.md). Absent on every other move.
   */
  hasMirror?: boolean
}

export interface MoveLibraryResponse {
  /** Content hash of the move definitions (and the real-dancer clip file, when present). */
  version: string
  /**
   * In library order: the classic moves (with their L/R variants), then the real-dancer clips. Query
   * `?source=classic|aist` keeps one source; `?mirrors=1` adds the clips' mirrored twins (see hasMirror).
   */
  moves: LibraryMove[]
  /** Data credit for the real-dancer clips; null when the library has none. */
  attribution?: string | null
}

/** GET /api/moves/sources: how many moves each source offers (cheap; for the "Moves from" choice). */
export interface MoveSourcesResponse {
  version: string
  attribution: string | null
  /** Why the real-dancer clip file was skipped (invalid), if it was. */
  clipsError: string | null
  library: { moves: number; baseMoves: number }
  aist: { moves: number; baseMoves: number }
}

export interface ChoreographRequest {
  /** Analysis id (sha256) from POST /api/analyze or GET /api/songs/{file}/analysis. */
  analysisId: string
  difficulty?: Difficulty
  mode?: 'standing' | 'seated'
  seed?: number
  /** Default 'classic'. */
  moveSource?: MoveSource
}
