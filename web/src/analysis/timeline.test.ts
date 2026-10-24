import type { AnalysisSection } from '@shared/analysis'
import { describe, expect, it } from 'vitest'
import {
  barBeatAt,
  barBeatOfIndex,
  beatIndexAt,
  clampScroll,
  followScroll,
  formatTime,
  groupColor,
  groupHue,
  isDownbeatIndex,
  maxScrollSec,
  niceTimeStep,
  pxPerSec,
  sectionAt,
  sectionIndexAt,
  timeToX,
  visibleSec,
  withAlpha,
  xToTime,
  zoomAround,
  type TimelineView,
} from './timeline'

const view = (o: Partial<TimelineView> = {}): TimelineView => ({ durationSec: 100, widthPx: 1000, zoom: 1, scrollSec: 0, ...o })

describe('view math', () => {
  it('maps time <-> x with zoom and scroll', () => {
    const v = view({ zoom: 4, scrollSec: 20 })
    expect(pxPerSec(v)).toBe(40)
    expect(visibleSec(v)).toBe(25)
    expect(timeToX(v, 20)).toBe(0)
    expect(timeToX(v, 45)).toBe(1000)
    expect(xToTime(v, 500)).toBe(32.5)
    for (const t of [0, 7.3, 20, 44.9, 100]) expect(xToTime(v, timeToX(v, t))).toBeCloseTo(t, 9)
  })

  it('fits the whole song at zoom 1 and clamps zoom to 1..8', () => {
    expect(timeToX(view(), 100)).toBe(1000)
    expect(pxPerSec(view({ zoom: 0.2 }))).toBe(10)
    expect(pxPerSec(view({ zoom: 50 }))).toBe(80)
  })

  it('degrades safely for empty songs / zero width', () => {
    expect(pxPerSec(view({ durationSec: 0 }))).toBe(0)
    expect(xToTime(view({ widthPx: 0, scrollSec: 3 }), 50)).toBe(3)
    expect(maxScrollSec(view({ durationSec: 0 }))).toBe(0)
  })

  it('clamps scroll to the song', () => {
    const v = view({ zoom: 4 })
    expect(maxScrollSec(v)).toBe(75)
    expect(clampScroll(v, -5)).toBe(0)
    expect(clampScroll(v, 80)).toBe(75)
    expect(clampScroll(v, Number.NaN)).toBe(0)
    expect(clampScroll(view(), 10)).toBe(0)
  })

  it('follows the playhead past the lead line and after seeking back', () => {
    const v = view({ zoom: 4, scrollSec: 20 }) // shows 20..45
    expect(followScroll(v, 30)).toBe(20) // inside: untouched
    expect(followScroll(v, 40)).toBeCloseTo(40 - 0.7 * 25, 9) // past 70%: scroll along
    expect(followScroll(v, 5)).toBeCloseTo(5 - 2.5, 9) // seek back: land at 10%
    expect(followScroll(v, 99)).toBe(75) // clamped at the end
    expect(followScroll(v, 0.5)).toBe(0)
  })

  it('zooms around an anchor time', () => {
    const v = view({ zoom: 2, scrollSec: 10 }) // 20 px/s, shows 10..60
    const z = zoomAround(v, 4, 30)
    expect(z.zoom).toBe(4)
    expect(timeToX(z, 30)).toBeCloseTo(timeToX(v, 30), 9)
    expect(z.scrollSec).toBeCloseTo(20, 9)
    // Zooming back out to 1 always shows the whole song.
    expect(zoomAround(z, 1, 30).scrollSec).toBe(0)
    expect(zoomAround(view({ zoom: 1 }), 8, 99).scrollSec).toBeCloseTo(99 - 990 / 80, 9)
    // Never scrolls past the song.
    expect(zoomAround(view({ zoom: 1 }), 8, 150).scrollSec).toBe(87.5)
  })

  it('picks a grid step that keeps labels apart', () => {
    expect(niceTimeStep(10)).toBe(10)
    expect(niceTimeStep(100)).toBe(1)
    expect(niceTimeStep(1000)).toBe(0.25)
    expect(niceTimeStep(0.01)).toBe(600)
  })
})

describe('beatIndexAt', () => {
  it('binary-searches the last beat at or before t', () => {
    const beats = Array.from({ length: 1000 }, (_, i) => 0.25 + i * 0.5)
    expect(beatIndexAt(beats, 0)).toBe(-1)
    expect(beatIndexAt(beats, 0.25)).toBe(0)
    expect(beatIndexAt(beats, 0.74)).toBe(0)
    expect(beatIndexAt(beats, 250.25)).toBe(500)
    expect(beatIndexAt(beats, 1e6)).toBe(999)
    expect(beatIndexAt([], 3)).toBe(-1)
  })
})

describe('bars and beats', () => {
  // 120 BPM, first beat at 0.5 s, first downbeat is beats[3] (3 pickup beats).
  const grid = { beats: Array.from({ length: 40 }, (_, i) => 0.5 + i * 0.5), downbeatPhase: 3, beatsPerBar: 4 as const }

  it('numbers bars from the first downbeat with pickup beats in bar 0', () => {
    expect(barBeatAt(grid, 0.2)).toBeNull()
    expect(barBeatAt(grid, 0.5)).toEqual({ bar: 0, beat: 2 })
    expect(barBeatAt(grid, 1.4)).toEqual({ bar: 0, beat: 3 })
    expect(barBeatAt(grid, 1.5)).toEqual({ bar: 0, beat: 4 })
    expect(barBeatAt(grid, 2.0)).toEqual({ bar: 1, beat: 1 }) // beats[3]
    expect(barBeatAt(grid, 3.6)).toEqual({ bar: 1, beat: 4 })
    expect(barBeatAt(grid, 4.0)).toEqual({ bar: 2, beat: 1 })
    expect(barBeatAt(grid, 999)).toEqual({ bar: 10, beat: 1 }) // beats[39]: rel 36
  })

  it('agrees with downbeats = beats[phase::4]', () => {
    for (const phase of [0, 1, 2, 3]) {
      const downbeats = grid.beats.filter((_, i) => i >= phase && (i - phase) % 4 === 0)
      downbeats.forEach((t, k) => {
        expect(barBeatAt({ ...grid, downbeatPhase: phase }, t)).toEqual({ bar: k + 1, beat: 1 })
      })
      grid.beats.forEach((_, i) => {
        expect(isDownbeatIndex(i, phase)).toBe(barBeatOfIndex(i, phase).beat === 1 && i >= phase)
      })
    }
    expect(barBeatAt({ ...grid, downbeatPhase: 0 }, 0.5)).toEqual({ bar: 1, beat: 1 })
  })
})

describe('sectionAt', () => {
  const sec = (start: number, end: number, group: string): AnalysisSection => ({
    start,
    end,
    group,
    label: 'verse',
    energy: 0.5,
    startBeat: 0,
    endBeat: 0,
    bars: 0,
  })
  const sections = [sec(0, 8, 'A'), sec(8, 24, 'B'), sec(24, 40, 'C')]

  it('finds the section containing t (end exclusive, except the song end)', () => {
    expect(sectionIndexAt(sections, 0)).toBe(0)
    expect(sectionIndexAt(sections, 7.99)).toBe(0)
    expect(sectionIndexAt(sections, 8)).toBe(1)
    expect(sectionIndexAt(sections, 39.9)).toBe(2)
    expect(sectionIndexAt(sections, 40)).toBe(2)
    expect(sectionIndexAt(sections, 40.01)).toBe(-1)
    expect(sectionIndexAt(sections, -1)).toBe(-1)
    expect(sectionIndexAt([], 1)).toBe(-1)
    expect(sectionAt(sections, 30)?.group).toBe('C')
    expect(sectionAt(sections, 50)).toBeNull()
  })
})

/** WCAG relative luminance of #rrggbb. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('groupColor', () => {
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))

  it('is stable and distinct for A..Z', () => {
    const colors = letters.map(groupColor)
    expect(new Set(colors).size).toBe(26)
    expect(letters.map(groupColor)).toEqual(colors)
    expect(groupColor('b')).toBe(groupColor('B'))
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('keeps the first groups far apart in hue', () => {
    const hues = letters.slice(0, 8).map(groupHue)
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const d = Math.abs(hues[i] - hues[j]) % 360
        expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(30)
      }
    }
  })

  it('is readable on the dark background (WCAG contrast >= 4.5)', () => {
    const bg = luminance('#070a18')
    for (const c of letters.map(groupColor)) {
      expect((luminance(c) + 0.05) / (bg + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('handles off-contract groups and alpha', () => {
    expect(groupColor('??')).toMatch(/^#[0-9a-f]{6}$/)
    expect(groupColor('??')).toBe(groupColor('??'))
    expect(withAlpha('#a0b0c0', 0.5)).toBe('#a0b0c080')
    expect(withAlpha('#a0b0c0', 2)).toBe('#a0b0c0ff')
  })
})

describe('formatTime', () => {
  it('formats m:ss.s', () => {
    expect(formatTime(0)).toBe('0:00.0')
    expect(formatTime(7.34)).toBe('0:07.3')
    expect(formatTime(59.96)).toBe('1:00.0')
    expect(formatTime(201.5)).toBe('3:21.5')
    expect(formatTime(-3)).toBe('0:00.0')
  })
})
