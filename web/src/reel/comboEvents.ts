// ComboEvent sink: every kept combo is reported here as numbers (no video). The default sink
// only keeps the round's events in memory; the backend can register a sink that stores them.

import { COMBO_EVENT_VERSION, type ComboEvent } from '@shared/combo-event'
import type { ClipMeta } from './types'

export type ComboEventSink = (e: ComboEvent) => void

export function comboEventFor(
  clip: ClipMeta,
  ctx: { roomId: string | null; songId: string | null },
  now: Date = new Date(),
): ComboEvent {
  return {
    version: COMBO_EVENT_VERSION,
    at: now.toISOString(),
    roomId: ctx.roomId,
    playerId: clip.playerId,
    songId: ctx.songId,
    songTime: clip.judgments[0]?.time ?? clip.startSongTime,
    start: clip.startSongTime,
    end: clip.endSongTime,
    comboLength: clip.comboLength,
    avgScore: Math.round(clip.avgScore * 10) / 10,
    bestMoveId: clip.bestMoveId,
    clipId: clip.id,
  }
}

const recent: ComboEvent[] = []
const keepRecent: ComboEventSink = (e) => {
  recent.push(e)
  if (recent.length > 100) recent.shift()
}
let sink: ComboEventSink = keepRecent

export function emitComboEvent(e: ComboEvent): void {
  try {
    sink(e)
  } catch (err) {
    console.warn('Combo event sink failed', err)
  }
}

/** Replace where combo events go; null restores the in-memory default. */
export function setComboEventSink(fn: ComboEventSink | null): void {
  sink = fn ?? keepRecent
}

/** Events the default sink kept (newest last). */
export const recentComboEvents = (): readonly ComboEvent[] => recent
