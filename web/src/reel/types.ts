// Data the combo cam keeps per clip. A clip is numbers + an optional video blob (kept in
// IndexedDB, never uploaded). Clips carry their player, so one reel can mix several players'
// clips once rooms exist (v1: one local player).

import type { Judgment } from '../game/scoring'

export type GoodJudgment = Extract<Judgment, 'perfect' | 'good'>

export const isGoodOrBetter = (j: Judgment): j is GoodJudgment => j === 'perfect' || j === 'good'

export interface ClipJudgment {
  /** Checkpoint (beat) song time, s. */
  time: number
  judgment: GoodJudgment
  /** 0..100 */
  score: number
  moveId: string
  moveIndex: number
}

export interface ClipMeta {
  id: string
  playerId: string
  playerName: string
  /** Song time (s) audible when the recorder started / stopped. */
  startSongTime: number
  endSongTime: number
  /** Camera + model latency (s): video time v shows the pose made at startSongTime + v - latency. */
  videoLatencySec: number
  comboLength: number
  /** Mean judgment score, 0..100. */
  avgScore: number
  bestMoveId: string
  bestMoveName: string
  /** The streak's judgments, ascending by time. */
  judgments: ClipJudgment[]
  /** '' when the clip has no video (no camera). */
  mimeType: string
  hasVideo: boolean
  /** Show the video mirrored (a selfie camera); false for a captured stage canvas. */
  mirrorVideo: boolean
}

/** Per-player numbers over the whole round, for the awards. */
export interface PlayerRoundStats {
  playerId: string
  playerName: string
  /** Longest Good-or-better streak. */
  longestCombo: number
  perfects: number
  /** Mean score of each freeze-move instance (by moveIndex) the player was judged on. */
  freezes: { moveId: string; moveName: string; avgScore: number }[]
}
