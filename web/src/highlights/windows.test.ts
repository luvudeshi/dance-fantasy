import { describe, expect, it } from 'vitest'
import type { Judgment } from '../game/scoring'
import { bitrateFor, HIGHLIGHT_DEFAULTS, pickHighlights, pickMimeType, recordingSize, TimeMap, type JudgedBeat } from './windows'

/** One beat every 0.5 s from t0; 'x' = miss, anything else = perfect; move index = beat / 4. */
function round(pattern: string, t0 = 10): JudgedBeat[] {
  return [...pattern].map((c, i) => ({
    checkpoint: { time: t0 + i * 0.5, moveIndex: Math.floor(i / 4) },
    judgment: (c === 'x' ? 'miss' : 'perfect') as Judgment,
  }))
}

describe('pickHighlights', () => {
  it('has nothing for an all-miss round or a best streak below minBestCombo', () => {
    expect(pickHighlights(round('xxxxxxxx'))).toEqual([])
    expect(pickHighlights(round('ooxooxoo'))).toEqual([])
  })

  it('keeps a short best streak as the only highlight', () => {
    const [w, ...rest] = pickHighlights(round('xoooxx'))
    expect(rest).toEqual([])
    expect(w.combo).toBe(3)
    expect(w.best).toBe(true)
    // peak at beat 3 (t = 11.5): 4 s lead, 1.5 s tail
    expect(w.start).toBeCloseTo(7.5)
    expect(w.end).toBeCloseTo(13)
  })

  it('marks a streak of >= 8 at its peak, with the moves inside the window', () => {
    const ws = pickHighlights(round('xx' + 'o'.repeat(10) + 'xxxx'))
    expect(ws).toHaveLength(1)
    const [w] = ws
    expect(w.combo).toBe(10)
    expect(w.best).toBe(true)
    // peak = beat 11 at t = 15.5, merged with the 8x milestone at t = 14.5
    expect(w.end).toBeCloseTo(17)
    expect(w.start).toBeCloseTo(10.5)
    expect(w.moveIndices).toEqual([0, 1, 2, 3])
  })

  it('splits one long streak into milestones and merges neighbours up to maxClipSec', () => {
    // 64 perfect beats (32 s): milestones 8..64 every 4 s, so each merges with the next until 12 s
    const ws = pickHighlights(round('o'.repeat(64), 0))
    expect(ws.length).toBeGreaterThan(1)
    expect(ws.length).toBeLessThanOrEqual(HIGHLIGHT_DEFAULTS.maxClips)
    for (const w of ws) expect(w.end - w.start).toBeLessThanOrEqual(HIGHLIGHT_DEFAULTS.maxClipSec + 1e-9)
    expect(ws.filter((w) => w.best)).toHaveLength(1)
    expect(Math.max(...ws.map((w) => w.combo))).toBe(64)
    // song order, no overlaps
    for (let i = 1; i < ws.length; i++) expect(ws[i].start).toBeGreaterThanOrEqual(ws[i - 1].end)
  })

  it('caps the reel at maxClips, keeping the best streak and the biggest combos', () => {
    // six separate streaks of 8..13 hits, far apart
    const pattern = [8, 9, 10, 11, 12, 13].map((n) => 'o'.repeat(n) + 'x'.repeat(20)).join('')
    const ws = pickHighlights(round(pattern, 0))
    expect(ws).toHaveLength(5)
    expect(ws.map((w) => w.combo)).toEqual([9, 10, 11, 12, 13])
    expect(ws[4].best).toBe(true)
  })

  it('ignores input order and clamps the lead-in at song start', () => {
    const beats = round('oooo', 0).reverse()
    const [w] = pickHighlights(beats)
    expect(w.start).toBe(0)
    expect(w.combo).toBe(4)
  })
})

describe('TimeMap', () => {
  it('is null when empty and extrapolates past both ends', () => {
    const m = new TimeMap()
    expect(m.recTimeAt(3)).toBeNull()
    m.push(2, 1)
    m.push(4, 3)
    expect(m.recTimeAt(0)).toBe(0) // 1 - 2, clamped
    expect(m.recTimeAt(1.5)).toBeCloseTo(0.5)
    expect(m.recTimeAt(10)).toBeCloseTo(9)
  })

  it('interpolates and skips a pause (no samples while paused)', () => {
    const m = new TimeMap()
    for (let i = 0; i <= 10; i++) m.push(i, i) // song 0..10 at rec 0..10
    for (let i = 10; i <= 20; i++) m.push(i + 0.1, i + 30.1) // 30 s pause, then on
    expect(m.recTimeAt(5.5)).toBeCloseTo(5.5)
    expect(m.recTimeAt(15.1)).toBeCloseTo(45.1)
    expect(m.size).toBe(22)
  })

  it('ignores non-finite samples', () => {
    const m = new TimeMap()
    m.push(Number.NaN, 1)
    m.push(1, Number.POSITIVE_INFINITY)
    expect(m.size).toBe(0)
  })
})

describe('recording settings', () => {
  it('picks the first supported type, or null', () => {
    expect(pickMimeType((t) => t.startsWith('video/mp4'))).toBe('video/mp4;codecs=avc1.42E01E')
    expect(pickMimeType(() => true)).toBe('video/webm;codecs=vp8')
    expect(pickMimeType(() => false)).toBeNull()
  })

  it('keeps long songs under the byte budget', () => {
    const max = 60 * 1024 * 1024
    expect(bitrateFor(120, max)).toBe(1_500_000)
    const long = bitrateFor(600, max)
    expect(((600 + 30) * long) / 8).toBeLessThan(max)
    expect(bitrateFor(10_000, max)).toBe(300_000)
    expect(bitrateFor(Number.NaN, max)).toBe(1_500_000)
  })

  it('sizes the recording by aspect, even pixels', () => {
    expect(recordingSize(16 / 9)).toEqual({ width: 960, height: 540 })
    expect(recordingSize(1440 / 900)).toEqual({ width: 960, height: 600 })
    expect(recordingSize(390 / 844)).toEqual({ width: 444, height: 960 })
    expect(recordingSize(0)).toEqual({ width: 960, height: 540 })
  })
})
