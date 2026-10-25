// Where the player's pose comes from during a game: the webcam (MediaPipe, in the browser) or a
// bot that replays the routine with noise (tests, demos, no-camera fallback).
// STAGE 4 INTERFACE: types are stable; implementations live in webcamSource.ts / botSource.ts.

import type { JointName, Pose2D, Vec2 } from '@shared/skeleton'

/** One player pose sample, already in the body frame (shared/README.md). */
export interface PlayerFrame {
  /** Song time (s) at which the player actually made this pose: capture time mapped onto the
   *  audio clock, minus the calibrated camera/model latency. Scoring compares this to beat times. */
  songTime: number
  pose: Pose2D
  /** MediaPipe visibility per joint, 0..1 (bots report 1). */
  visibility: Partial<Record<JointName, number>>
  /** false when no person / torso too small; pose may be empty then. */
  valid: boolean
  /** Raw video pixel coordinates for drawing the webcam skeleton overlay (webcam only). */
  image?: Partial<Record<JointName, Vec2>>
  /** Capture time on the song clock BEFORE latency correction (= songTime + latencySec). Webcam only. */
  rawSongTime?: number
  /** Capture time as a performance.now() timestamp (ms). Webcam only; calibration timing uses it
   *  because the song clock stands still while no song plays. */
  captureMs?: number
  /** Size (px) of the video the `image` coordinates refer to. Webcam only. */
  videoWidth?: number
  videoHeight?: number
}

/** Maps a performance.now() timestamp (ms) to song time (s) on the game's audio clock. */
export type SongTimeAt = (perfMs: number) => number

export interface PoseSource {
  readonly kind: 'webcam' | 'bot'
  /** Starts producing frames (webcam: opens camera + loads the model). */
  start(): Promise<void>
  stop(): void
  /** Subscribe to frames; returns an unsubscribe function. */
  onFrame(cb: (frame: PlayerFrame) => void): () => void
  /** Most recent frame, if any. */
  latest(): PlayerFrame | null
  /** The <video> element showing the camera (webcam only), for the picture-in-picture. */
  readonly video?: HTMLVideoElement
}
