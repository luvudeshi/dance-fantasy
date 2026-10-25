// Overlay timing math for the highlight reel (pure). A clip plays at 1x over its whole song
// range, then replays its best second at 0.5x. Everything is keyed on song time, so the
// combo counter, Perfect/Good pops and the song audio line up with the video.

import { byStrength } from './clips'
import type { ClipJudgment, ClipMeta } from './types'

export const SLOWMO_RATE = 0.5
export const BEST_WINDOW_SEC = 1
/** A judgment pop's lifetime (song seconds). */
export const POP_SEC = 0.6
/** The best second starts this long before its first hit, so the hit's pop is seen growing. */
export const BEST_LEAD_SEC = 0.25
/** A reel should stay short and punchy on a projector. */
export const MAX_REEL_SEC = 60
/** A longer clip plays only its last this-many seconds (the combo counter at its peak). */
export const MAX_CLIP_PLAY_SEC = 12

type TimedClip = Pick<ClipMeta, 'startSongTime' | 'endSongTime' | 'videoLatencySec'>

/** Song time shown by video time `v` (s): the recorder starts `latency` behind the pose it shows. */
export const songAtVideo = (c: TimedClip, v: number): number => c.startSongTime - c.videoLatencySec + v
export const videoAtSong = (c: TimedClip, s: number): number => s - c.startSongTime + c.videoLatencySec

/** Song time range the clip's video covers. */
export function clipSongRange(c: TimedClip): { from: number; to: number } {
  const from = songAtVideo(c, 0)
  return { from, to: from + Math.max(0, c.endSongTime - c.startSongTime) }
}

/** The part of the clip the reel plays: all of it, or its last MAX_CLIP_PLAY_SEC. */
export function playRange(c: TimedClip, maxSec = MAX_CLIP_PLAY_SEC): { from: number; to: number } {
  const { from, to } = clipSongRange(c)
  return { from: Math.max(from, to - maxSec), to }
}

/**
 * Start (song time) of the 1 s window with the highest total score, inside the played range.
 * Candidates start BEST_LEAD_SEC before each judgment; ties keep the earliest.
 */
export function bestSecondStart(c: TimedClip & Pick<ClipMeta, 'judgments'>, windowSec = BEST_WINDOW_SEC): number {
  const { from, to } = playRange(c)
  const latest = Math.max(from, to - windowSec)
  let best = from
  let bestSum = -1
  for (const j of c.judgments) {
    if (j.time + windowSec < from) continue
    const start = Math.min(Math.max(from, j.time - BEST_LEAD_SEC), latest)
    const sum = c.judgments.filter((k) => k.time >= start && k.time < start + windowSec).reduce((s, k) => s + k.score, 0)
    if (sum > bestSum) {
      bestSum = sum
      best = start
    }
  }
  return best
}

export interface Segment {
  kind: 'play' | 'slowmo'
  /** Song time range. */
  from: number
  to: number
  rate: number
  /** Wall duration, s. */
  duration: number
}

export function clipSegments(c: TimedClip & Pick<ClipMeta, 'judgments'>): Segment[] {
  const { from, to } = playRange(c)
  const out: Segment[] = [{ kind: 'play', from, to, rate: 1, duration: to - from }]
  if (c.judgments.length > 0 && to - from > 0) {
    const s = bestSecondStart(c)
    const e = Math.min(to, s + BEST_WINDOW_SEC)
    out.push({ kind: 'slowmo', from: s, to: e, rate: SLOWMO_RATE, duration: (e - s) / SLOWMO_RATE })
  }
  return out
}

export const clipDuration = (c: TimedClip & Pick<ClipMeta, 'judgments'>): number => clipSegments(c).reduce((s, g) => s + g.duration, 0)

/** Where `elapsed` wall seconds into a clip land: segment index + song time (null past the end). */
export function locate(segments: readonly Segment[], elapsed: number): { index: number; songTime: number } | null {
  let t = Math.max(0, elapsed)
  for (let i = 0; i < segments.length; i++) {
    const g = segments[i]
    if (t < g.duration) return { index: i, songTime: g.from + t * g.rate }
    t -= g.duration
  }
  return null
}

/** Reel order (best first), trimmed to `maxSec` by dropping the weakest clips (always keeps one). */
export function reelOrder<T extends ClipMeta>(clips: readonly T[], maxSec = MAX_REEL_SEC): T[] {
  const ordered = byStrength(clips)
  let total = ordered.reduce((s, c) => s + clipDuration(c), 0)
  while (ordered.length > 1 && total > maxSec) total -= clipDuration(ordered.pop() as T)
  return ordered
}

export interface Pop {
  judgment: ClipJudgment['judgment']
  /** 0..1 through its lifetime. */
  progress: number
  /** Overshoot scale (1.4 -> 1) and fade (1 -> 0 over the last 40%). */
  scale: number
  alpha: number
}

export interface OverlayState {
  /** Combo count at this song time (judgments so far in the streak; 0 before the first). */
  combo: number
  /** Combo bump animation, 0..1 (1 right at a new hit). */
  bump: number
  pops: Pop[]
}

export function popAt(progress: number): Pick<Pop, 'scale' | 'alpha'> {
  const p = Math.min(Math.max(progress, 0), 1)
  const scale = p < 0.2 ? 1.4 - 2 * p : 1
  const alpha = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4
  return { scale, alpha }
}

/** Overlay at song time `s`. Judgment times are checkpoint (beat) times. */
export function overlayAt(judgments: readonly ClipJudgment[], s: number): OverlayState {
  let combo = 0
  let lastHit = Number.NEGATIVE_INFINITY
  const pops: Pop[] = []
  for (const j of judgments) {
    if (j.time > s) break
    combo += 1
    lastHit = j.time
    const progress = (s - j.time) / POP_SEC
    if (progress < 1) pops.push({ judgment: j.judgment, progress, ...popAt(progress) })
  }
  const since = s - lastHit
  const bump = since >= 0 && since < 0.25 ? 1 - since / 0.25 : 0
  return { combo, bump, pops }
}
