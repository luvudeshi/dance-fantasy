// Pure clip bookkeeping: metadata from a streak's judgments, clip strength and the 6-clip cap.

import type { ClipJudgment, ClipMeta } from './types'

export const MAX_CLIPS = 6

export function averageScore(js: readonly Pick<ClipJudgment, 'score'>[]): number {
  return js.length === 0 ? 0 : js.reduce((s, j) => s + j.score, 0) / js.length
}

/** The move with the highest mean score in the streak (ties: more checkpoints, then earliest). */
export function bestMove(js: readonly ClipJudgment[]): { moveId: string; moveIndex: number } | null {
  const by = new Map<number, { moveId: string; sum: number; n: number; first: number }>()
  js.forEach((j, i) => {
    const m = by.get(j.moveIndex) ?? { moveId: j.moveId, sum: 0, n: 0, first: i }
    m.sum += j.score
    m.n += 1
    by.set(j.moveIndex, m)
  })
  let best: { moveId: string; moveIndex: number; avg: number; n: number; first: number } | null = null
  for (const [moveIndex, m] of by) {
    const avg = m.sum / m.n
    if (!best || avg > best.avg || (avg === best.avg && (m.n > best.n || (m.n === best.n && m.first < best.first)))) {
      best = { moveId: m.moveId, moveIndex, avg, n: m.n, first: m.first }
    }
  }
  return best && { moveId: best.moveId, moveIndex: best.moveIndex }
}

/** How good a clip is: length weighted by quality (a 16-combo at 75 beats an 8-combo at 100). */
export const clipStrength = (c: Pick<ClipMeta, 'comboLength' | 'avgScore'>): number => c.comboLength * c.avgScore

/** Strongest first; ties keep the earlier clip first. */
export function byStrength<T extends Pick<ClipMeta, 'comboLength' | 'avgScore' | 'startSongTime'>>(clips: readonly T[]): T[] {
  return [...clips].sort((a, b) => clipStrength(b) - clipStrength(a) || a.startSongTime - b.startSongTime)
}

/**
 * Adds `clip` under the cap: below `cap` it just joins; at the cap it replaces the weakest clip
 * if it is stronger, else it is the one dropped. Returns the new list and the dropped clip.
 */
export function addWithCap<T extends Pick<ClipMeta, 'id' | 'comboLength' | 'avgScore' | 'startSongTime'>>(
  clips: readonly T[],
  clip: T,
  cap = MAX_CLIPS,
): { clips: T[]; dropped: T | null } {
  if (clips.length < cap) return { clips: [...clips, clip], dropped: null }
  const weakest = byStrength(clips)[clips.length - 1]
  if (!weakest || clipStrength(clip) <= clipStrength(weakest)) return { clips: [...clips], dropped: clip }
  return { clips: [...clips.filter((c) => c !== weakest), clip], dropped: weakest }
}

/** Freeze moves hold a pose on purpose (assets/moves/freezes.json); mirrored ids end in _L / _R. */
export const FREEZE_MOVE_IDS: readonly string[] = ['superhero', 'star_pose', 'vogue_frame']

export function isFreezeMove(id: string): boolean {
  const base = id.replace(/_(L|R)$/, '')
  return FREEZE_MOVE_IDS.includes(base)
}
