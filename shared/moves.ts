// Move library served by GET /api/moves. Matches server/app/moves/types.py (CompiledMove).

import type { JointName, Pose2D, Vec2 } from './skeleton'
import type { Difficulty } from './routine'

export type BodyPart = 'arms' | 'legs' | 'torso' | 'head'

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
}

export interface MoveLibraryResponse {
  /** Content hash of the move definitions. */
  version: string
  moves: LibraryMove[]
}

export interface ChoreographRequest {
  /** Analysis id (sha256) from POST /api/analyze or GET /api/songs/{file}/analysis. */
  analysisId: string
  difficulty?: Difficulty
  mode?: 'standing' | 'seated'
  seed?: number
  /** Optional signature dances (GET /api/signature/moves ids), each on the first downbeat of every matching section. */
  pinnedMoves?: PinnedMoveRequest[]
}

export interface PinnedMoveRequest {
  moveId: string
  placement: 'chorus' | 'drop' | 'finale'
}
