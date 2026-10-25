// One-line storybook captions per clip. getCaption is the seam for a generated caption (the
// backend will swap in a model call); for now it picks a canned line from the clip's numbers,
// deterministically, so the same clip always gets the same line.

import { isFreezeMove } from './clips'
import type { ClipMeta } from './types'

export type CaptionMeta = Pick<ClipMeta, 'id' | 'playerName' | 'comboLength' | 'avgScore' | 'bestMoveId' | 'bestMoveName' | 'judgments'>

export type CaptionFn = (clip: CaptionMeta) => Promise<string>

const FLAWLESS = 'And lo, the dancer did not miss a single beat'

const LONG = [
  'The orchestra played faster, and still the dancer kept pace',
  'Twelve chimes, and not one step out of place',
  'The whole court held its breath for this one',
]

const FREEZE = [
  'Frozen like a statue in the royal garden, yet twice as graceful',
  'Even the palace guards stood still to watch',
]

const GENERAL = [
  'The candles flickered, and the slippers flew',
  'Word of this dance reached the farthest tower',
  'A step so bold the king spilled his tea',
  'Somewhere, a fairy godmother wiped away a tear',
  'The mirror on the wall had nothing to add',
  'The pumpkin coach can wait a little longer',
]

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

const pick = (lines: readonly string[], key: string): string => lines[hash(key) % lines.length]

/** The canned line for a clip (pure). */
export function cannedCaption(clip: CaptionMeta): string {
  if (clip.judgments.length > 0 && clip.judgments.every((j) => j.judgment === 'perfect')) return FLAWLESS
  if (isFreezeMove(clip.bestMoveId)) return pick(FREEZE, clip.id)
  if (clip.comboLength >= 16) return pick(LONG, clip.id)
  return pick(GENERAL, clip.id)
}

let captionFn: CaptionFn = (clip) => Promise.resolve(cannedCaption(clip))

/** A clip's caption. Never rejects: falls back to the canned line. */
export async function getCaption(clip: CaptionMeta): Promise<string> {
  try {
    const line = await captionFn(clip)
    return line.trim() || cannedCaption(clip)
  } catch {
    return cannedCaption(clip)
  }
}

/** Swap the caption source (e.g. a server call); null restores the canned lines. */
export function setCaptionSource(fn: CaptionFn | null): void {
  captionFn = fn ?? ((clip) => Promise.resolve(cannedCaption(clip)))
}
