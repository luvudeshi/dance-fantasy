// The combo cam's streak rules, as a pure state machine over judgments (no recorders, no time):
// a streak of 3 Good-or-better starts a recording; breaking before 8 discards it; reaching 8 or
// more keeps it (the clipper stops it 1 s after the streak ends).

import type { Judgment } from '../game/scoring'
import { isGoodOrBetter } from './types'

/** Good-or-better hits that start the recorder. */
export const START_STREAK = 3
/** Hits a streak needs for its clip to be kept. */
export const KEEP_STREAK = 8

export type StreakAction = { type: 'none' } | { type: 'start' } | { type: 'discard'; length: number } | { type: 'keep'; length: number }

export class StreakTracker {
  private length = 0
  private longestSeen = 0

  get current(): number {
    return this.length
  }

  get longest(): number {
    return this.longestSeen
  }

  push(judgment: Judgment, unseen = false): StreakAction {
    if (isGoodOrBetter(judgment) && !unseen) {
      this.length += 1
      this.longestSeen = Math.max(this.longestSeen, this.length)
      return this.length === START_STREAK ? { type: 'start' } : { type: 'none' }
    }
    return this.end()
  }

  /** The streak ends (a miss or the song's end). */
  end(): StreakAction {
    const length = this.length
    this.length = 0
    if (length >= KEEP_STREAK) return { type: 'keep', length }
    if (length >= START_STREAK) return { type: 'discard', length }
    return { type: 'none' }
  }
}
