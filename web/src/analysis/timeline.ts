// Pure view math and musical lookups for the analysis timeline (no DOM, unit-tested).

import type { Analysis, AnalysisSection } from '@shared/analysis'
import { beatIndexAt } from '../audio/clock'

export { beatIndexAt }

export const MIN_ZOOM = 1
export const MAX_ZOOM = 8

// --- view: zoom + horizontal scroll ----------------------------------------------------

/** What the timeline shows: zoom 1 fits the whole song in `widthPx`. */
export interface TimelineView {
  /** Song length in seconds. */
  durationSec: number
  /** Visible width in CSS pixels. */
  widthPx: number
  /** MIN_ZOOM..MAX_ZOOM. */
  zoom: number
  /** Song time at the left edge, seconds. */
  scrollSec: number
}

export const clampZoom = (zoom: number): number =>
  Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : MIN_ZOOM

/** Pixels per second (0 for an empty song or zero-width view). */
export function pxPerSec(v: TimelineView): number {
  return v.durationSec > 0 && v.widthPx > 0 ? (v.widthPx * clampZoom(v.zoom)) / v.durationSec : 0
}

/** Seconds visible at once. */
export function visibleSec(v: TimelineView): number {
  return Math.max(0, v.durationSec) / clampZoom(v.zoom)
}

export function timeToX(v: TimelineView, t: number): number {
  return (t - v.scrollSec) * pxPerSec(v)
}

export function xToTime(v: TimelineView, x: number): number {
  const pps = pxPerSec(v)
  return pps > 0 ? v.scrollSec + x / pps : v.scrollSec
}

/** Largest valid scrollSec (the song's end at the right edge). */
export function maxScrollSec(v: TimelineView): number {
  return Math.max(0, Math.max(0, v.durationSec) - visibleSec(v))
}

export function clampScroll(v: TimelineView, scrollSec: number): number {
  return Number.isFinite(scrollSec) ? Math.min(maxScrollSec(v), Math.max(0, scrollSec)) : 0
}

/**
 * scrollSec that keeps the playhead `t` in view while playing: once it passes `lead`
 * (fraction of the width) the view scrolls along with it; if it is left of the view (a seek
 * back), it lands at `back`. Otherwise the scroll is unchanged, so the user may look ahead.
 */
export function followScroll(v: TimelineView, t: number, lead = 0.7, back = 0.1): number {
  const span = visibleSec(v)
  if (t > v.scrollSec + lead * span) return clampScroll(v, t - lead * span)
  if (t < v.scrollSec) return clampScroll(v, t - back * span)
  return clampScroll(v, v.scrollSec)
}

/** The view at a new zoom, with `anchorSec` staying at the same x (clamped to the song). */
export function zoomAround(v: TimelineView, zoom: number, anchorSec: number): TimelineView {
  const anchorX = timeToX(v, anchorSec)
  const next = { ...v, zoom: clampZoom(zoom) }
  const pps = pxPerSec(next)
  const scrollSec = pps > 0 ? anchorSec - anchorX / pps : 0
  return { ...next, scrollSec: clampScroll(next, scrollSec) }
}

/** Grid step (seconds) from a fixed ladder so labels are at least `minPx` apart. */
export function niceTimeStep(pps: number, minPx = 70): number {
  const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  return steps.find((s) => s * pps >= minPx) ?? 600
}

// --- musical lookups --------------------------------------------------------------------

export interface BarBeat {
  /** 1-based from the first downbeat; pickup beats before it are bar 0. */
  bar: number
  /** 1..beatsPerBar. */
  beat: number
}

type BeatGrid = Pick<Analysis, 'beats' | 'downbeatPhase' | 'beatsPerBar'>

/** Bar/beat of beat index `i` (downbeats = beats[phase::beatsPerBar]). */
export function barBeatOfIndex(i: number, downbeatPhase: number, beatsPerBar = 4): BarBeat {
  const rel = i - downbeatPhase
  return {
    bar: Math.floor(rel / beatsPerBar) + 1,
    beat: (((rel % beatsPerBar) + beatsPerBar) % beatsPerBar) + 1,
  }
}

export function isDownbeatIndex(i: number, downbeatPhase: number, beatsPerBar = 4): boolean {
  return i >= downbeatPhase && (i - downbeatPhase) % beatsPerBar === 0
}

/** Bar and beat playing at song time `t`; null before the first beat. */
export function barBeatAt(analysis: BeatGrid, t: number): BarBeat | null {
  const i = beatIndexAt(analysis.beats, t)
  return i < 0 ? null : barBeatOfIndex(i, analysis.downbeatPhase, analysis.beatsPerBar)
}

/**
 * Index of the section containing `t` (start <= t < end; the last section also owns its
 * end), or -1 outside the sections. Binary search; sections are contiguous and ordered.
 */
export function sectionIndexAt(sections: readonly AnalysisSection[], t: number): number {
  let lo = 0
  let hi = sections.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sections[mid].start <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (found < 0) return -1
  const s = sections[found]
  const isLast = found === sections.length - 1
  return t < s.end || (isLast && t === s.end) ? found : -1
}

export function sectionAt(sections: readonly AnalysisSection[], t: number): AnalysisSection | null {
  const i = sectionIndexAt(sections, t)
  return i < 0 ? null : sections[i]
}

// --- colors ---------------------------------------------------------------------------

/** A section group's index: A = 0, B = 1, ...; other labels get a stable hash. */
function groupIndex(group: string): number {
  const g = group.trim().toUpperCase()
  if (/^[A-Z]$/.test(g)) return g.charCodeAt(0) - 65
  let k = 0
  for (const ch of g) k = (k * 31 + (ch.codePointAt(0) ?? 0)) % 997 // off-contract: stable hash
  return k
}

/** Body Double's sticker palette (raspberry, blue, sage, gold, rose, deep blue, glass, light gold), A first. */
const GROUP_COLORS = ['#c04f66', '#a3c3d8', '#a8bc8b', '#dbb35e', '#e6939f', '#56789a', '#d2e3ec', '#f2db94'] as const

/** Stable `#rrggbb` per group letter from the storybook palette (the first 8 groups all differ). */
export function groupColor(group: string): string {
  return GROUP_COLORS[groupIndex(group) % GROUP_COLORS.length] ?? GROUP_COLORS[0]
}

/** `#rrggbb` + alpha (0..1) -> `#rrggbbaa`. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
  return `${hex.slice(0, 7)}${a.toString(16).padStart(2, '0')}`
}

// --- formatting -------------------------------------------------------------------------

/** m:ss.s */
export function formatTime(sec: number): string {
  const tenths = Math.round(Math.max(0, Number.isFinite(sec) ? sec : 0) * 10)
  const m = Math.floor(tenths / 600)
  const rest = (tenths - m * 600) / 10
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`
}
