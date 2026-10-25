// "Before the ball": just play, watch the whole dance first (no camera, no score), or a
// practice run (camera + judgments, no score). The lobby choice is remembered on this device.

import { defaultStorage, readJson, writeJson, type StorageLike } from '../lib/storage'

export type Rehearsal = 'none' | 'watch' | 'practice'

export const REHEARSAL_KEY = 'midnight-ball.rehearsal.v1'

export const REHEARSALS: readonly { value: Rehearsal; label: string; hint: string }[] = [
  { value: 'none', label: 'Just play', hint: 'Straight onto the floor.' },
  { value: 'watch', label: 'Watch first', hint: 'See the whole dance with the music first (no camera).' },
  { value: 'practice', label: 'Practice run', hint: 'A full run with the camera and hints, no score.' },
]

const isRehearsal = (v: unknown): v is Rehearsal => v === 'none' || v === 'watch' || v === 'practice'

export function loadRehearsal(storage: StorageLike | null = defaultStorage()): Rehearsal {
  const v = readJson(REHEARSAL_KEY, storage)
  return isRehearsal(v) ? v : 'none'
}

export function saveRehearsal(r: Rehearsal, storage: StorageLike | null = defaultStorage()): void {
  writeJson(REHEARSAL_KEY, r, storage)
}

/** The bot can't practice for you: with autoplay a practice run becomes a preview. */
export function effectiveRehearsal(choice: Rehearsal, autoplay: boolean): Rehearsal {
  return autoplay && choice === 'practice' ? 'watch' : choice
}

/** A second ← within this long after a bar start goes one bar further back. */
const BACK_GRACE_SEC = 0.6
/** → never lands on the bar we are (almost) on. */
const FORWARD_EPS_SEC = 0.05

/**
 * Song time to seek to one bar back (-1) or forward (+1) from `t`: the previous / next
 * downbeat (going back, the song start counts as one). null when there is nowhere to go.
 */
export function barSeekTarget(downbeats: readonly number[], t: number, dir: -1 | 1): number | null {
  if (dir > 0) return downbeats.find((d) => d > t + FORWARD_EPS_SEC) ?? null
  if (t <= 0) return null
  const starts = downbeats.length > 0 && downbeats[0] <= 0 ? downbeats : [0, ...downbeats]
  let target = 0
  for (const d of starts) {
    if (d < t - BACK_GRACE_SEC) target = d
    else break
  }
  return target
}
