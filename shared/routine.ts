// routine.json types for the web app. Hand-written to match shared/routine.schema.json
// and server/app/routine.py. Change all three together.

import type { JointName, Pose2D } from './skeleton'

export const ROUTINE_VERSION = 1 as const

export type Difficulty = 'easy' | 'normal' | 'hard'
export type Mode = 'standing' | 'seated'

export interface Section {
  /** Seconds. */
  start: number
  /** Seconds. */
  end: number
  /** intro | verse | chorus | bridge | outro, or another short label. */
  label: string
  /** Relative energy, 0..1. */
  energy: number
}

export interface Song {
  /** Optional content hash of the audio file (sha256 hex). */
  id?: string
  title: string
  artist?: string
  durationSec: number
  bpm: number
  /** Beat times in seconds, ascending. */
  beats: number[]
  /** Bar-start times in seconds (subset of beats), ascending. */
  downbeats: number[]
  sections: Section[]
}

export interface Keyframe {
  /** Normalized time within the move, 0..1. */
  t: number
  pose: Pose2D
}

export interface Move {
  /** Move-library id, e.g. "arm_wave_L". */
  id: string
  /** Display name. */
  name: string
  /** Index into song.beats. */
  startBeat: number
  lengthBeats: number
  /** Seconds; equals song.beats[startBeat]. */
  startTime: number
  /** Seconds; > startTime. */
  endTime: number
  /** 1..5 */
  intensity: number
  /** A limb is scored when its distal joint is listed. */
  scoredJoints: JointName[]
  /** Ascending by t. */
  keyframes: Keyframe[]
}

export interface Routine {
  version: typeof ROUTINE_VERSION
  song: Song
  difficulty: Difficulty
  mode: Mode
  seed: number
  /** Playback order, non-overlapping. */
  moves: Move[]
  /** Free-form extras (generator name, createdAt, ...). */
  meta?: Record<string, unknown>
}
