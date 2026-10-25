// Pure highlight maths (no DOM): which stretches of a round make the reel, and where they sit in
// the recording. Song time in, recording time out.
//
// pickHighlights: every combo milestone (8, 16, 24, ...) and every streak's peak at >= minCombo is
// a candidate moment, plus the round's best streak even below minCombo. Best streak first, then by
// combo; each moment becomes [time - leadSec, time + tailSec], merged into an overlapping pick when
// the result stays <= maxClipSec (else dropped), up to maxClips, returned in song order.

import type { Judgment } from '../game/scoring'

/** The parts of a CheckpointResult the reel needs. */
export interface JudgedBeat {
  checkpoint: { time: number; moveIndex: number }
  judgment: Judgment
}

export interface HighlightWindow {
  /** Song time (s). */
  start: number
  end: number
  /** Highest combo reached inside the window. */
  combo: number
  /** Holds the round's best streak peak. */
  best: boolean
  /** Distinct move indices danced inside the window, in order. */
  moveIndices: number[]
}

export interface HighlightOptions {
  minCombo: number
  /** Milestones every this many hits of a streak (>= minCombo). */
  milestone: number
  maxClips: number
  leadSec: number
  tailSec: number
  maxClipSec: number
  /** The best streak is a highlight even below minCombo, from this many hits. */
  minBestCombo: number
}

export const HIGHLIGHT_DEFAULTS: HighlightOptions = {
  minCombo: 8,
  milestone: 8,
  maxClips: 5,
  leadSec: 4,
  tailSec: 1.5,
  maxClipSec: 12,
  minBestCombo: 3,
}

interface Moment {
  time: number
  combo: number
  best: boolean
}

export function pickHighlights(results: readonly JudgedBeat[], options: Partial<HighlightOptions> = {}): HighlightWindow[] {
  const o = { ...HIGHLIGHT_DEFAULTS, ...options }
  const beats = [...results].sort((a, b) => a.checkpoint.time - b.checkpoint.time)
  const moments: Moment[] = []
  let combo = 0
  let peak: Moment | null = null
  let best: Moment | null = null
  const closeStreak = (): void => {
    if (peak && (!best || peak.combo > best.combo)) best = peak
    if (peak && peak.combo >= o.minCombo && peak.combo % o.milestone !== 0) moments.push(peak)
    peak = null
  }
  for (const r of beats) {
    if (r.judgment === 'miss') {
      closeStreak()
      combo = 0
      continue
    }
    combo++
    peak = { time: r.checkpoint.time, combo, best: false }
    if (combo >= o.minCombo && combo % o.milestone === 0) moments.push(peak)
  }
  closeStreak()
  const top = best as Moment | null
  if (top && top.combo >= o.minBestCombo) {
    const same = moments.find((m) => m.time === top.time)
    if (same) same.best = true
    else moments.push({ ...top, best: true })
  }

  moments.sort((a, b) => Number(b.best) - Number(a.best) || b.combo - a.combo || a.time - b.time)
  const picks: HighlightWindow[] = []
  for (const m of moments) {
    const start = Math.max(0, m.time - o.leadSec)
    const end = m.time + o.tailSec
    const hit = picks.find((p) => start <= p.end && end >= p.start)
    if (hit) {
      const s = Math.min(hit.start, start)
      const e = Math.max(hit.end, end)
      if (e - s > o.maxClipSec) continue
      hit.start = s
      hit.end = e
      hit.combo = Math.max(hit.combo, m.combo)
      hit.best ||= m.best
    } else if (picks.length < o.maxClips) {
      picks.push({ start, end, combo: m.combo, best: m.best, moveIndices: [] })
    }
  }
  picks.sort((a, b) => a.start - b.start)
  for (const p of picks) {
    for (const r of beats) {
      const t = r.checkpoint.time
      if (t >= p.start && t <= p.end && !p.moveIndices.includes(r.checkpoint.moveIndex)) p.moveIndices.push(r.checkpoint.moveIndex)
    }
  }
  return picks
}

/**
 * Song time -> recording time, from (songTime, recTime) samples taken while the song plays.
 * ponytail: linear scan from the end is fine (one lookup per clip, a few thousand samples).
 */
export class TimeMap {
  private readonly song: number[] = []
  private readonly rec: number[] = []

  push(songTime: number, recTime: number): void {
    if (!Number.isFinite(songTime) || !Number.isFinite(recTime)) return
    this.song.push(songTime)
    this.rec.push(recTime)
  }

  get size(): number {
    return this.song.length
  }

  /** Recording time (s) of song time t; extrapolates past either end; null with no samples. */
  recTimeAt(t: number): number | null {
    const n = this.song.length
    if (n === 0) return null
    let i = n - 1
    while (i > 0 && this.song[i] > t) i--
    const s0 = this.song[i]
    const r0 = this.rec[i]
    if (t <= s0 || i === n - 1) return Math.max(0, r0 + (t - s0))
    const s1 = this.song[i + 1]
    const r1 = this.rec[i + 1]
    return s1 > s0 ? r0 + ((t - s0) / (s1 - s0)) * (r1 - r0) : r0
  }
}

/** First MediaRecorder type the browser can record: WebM (Chrome, Firefox) before MP4 (Safari). */
export const RECORDING_TYPES = [
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
] as const

export function pickMimeType(isSupported: (type: string) => boolean): string | null {
  return RECORDING_TYPES.find((t) => isSupported(t)) ?? null
}

/** Video bitrate (bits/s) that keeps a recording of durationSec (plus slack) under maxBytes. */
export function bitrateFor(durationSec: number, maxBytes: number, maxBps = 1_500_000, minBps = 300_000): number {
  const secs = (Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 180) + 30
  return Math.round(Math.min(maxBps, Math.max(minBps, (maxBytes * 8 * 0.85) / secs)))
}

/** Recording size (px) for a source aspect ratio: long side `long`, even numbers. */
export function recordingSize(aspect: number, long = 960): { width: number; height: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2)
  return a >= 1 ? { width: even(long), height: even(long / a) } : { width: even(long * a), height: even(long) }
}
