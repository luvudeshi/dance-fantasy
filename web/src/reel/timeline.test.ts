import { describe, expect, it } from 'vitest'
import {
  BEST_LEAD_SEC,
  bestSecondStart,
  clipDuration,
  clipSegments,
  clipSongRange,
  locate,
  MAX_CLIP_PLAY_SEC,
  overlayAt,
  popAt,
  POP_SEC,
  reelOrder,
  songAtVideo,
  videoAtSong,
} from './timeline'
import type { ClipJudgment, ClipMeta } from './types'

function clip(over: Partial<ClipMeta> & { scores?: number[]; t0?: number }): ClipMeta {
  const t0 = over.t0 ?? 20
  const judgments: ClipJudgment[] = (over.scores ?? [90, 90, 90, 90, 90, 90, 90, 90]).map((score, i) => ({
    time: t0 + i * 0.5,
    judgment: score >= 90 ? 'perfect' : 'good',
    score,
    moveId: 'm',
    moveIndex: 0,
  }))
  return {
    id: 'c',
    playerId: 'local',
    playerName: 'You',
    startSongTime: t0 + 1.2,
    endSongTime: t0 + 5,
    videoLatencySec: 0.1,
    comboLength: judgments.length,
    avgScore: 90,
    bestMoveId: 'm',
    bestMoveName: 'M',
    judgments,
    mimeType: 'video/webm',
    hasVideo: true,
    mirrorVideo: true,
    ...over,
  }
}

describe('video <-> song time', () => {
  const c = clip({})
  it('the video shows poses latency behind the recorder start', () => {
    expect(songAtVideo(c, 0)).toBeCloseTo(21.1)
    expect(videoAtSong(c, songAtVideo(c, 2.5))).toBeCloseTo(2.5)
    expect(clipSongRange(c)).toEqual({ from: expect.closeTo(21.1), to: expect.closeTo(24.9) })
  })
})

describe('best second', () => {
  it('is the 1 s window with the highest total score', () => {
    // hits at 20.0 .. 23.5; 22.0 and 22.5 are the strongest pair.
    const c = clip({ scores: [80, 80, 80, 80, 100, 100, 80, 80] })
    expect(bestSecondStart(c)).toBeCloseTo(22 - BEST_LEAD_SEC)
  })

  it('stays inside the clip', () => {
    const c = clip({ scores: [80, 80, 80, 80, 80, 80, 100, 100] }) // best hits at 23.0, 23.5
    const { to } = clipSongRange(c)
    expect(bestSecondStart(c) + 1).toBeLessThanOrEqual(to + 1e-9)
    const early = clip({ scores: [100, 100, 80, 80, 80, 80, 80, 80] }) // before the video starts
    expect(bestSecondStart(early)).toBeCloseTo(clipSongRange(early).from)
  })
})

describe('segments', () => {
  const c = clip({ scores: [80, 80, 80, 80, 100, 100, 80, 80] })
  const segs = clipSegments(c)

  it('plays the clip at 1x, then its best second at 0.5x', () => {
    expect(segs.map((s) => [s.kind, s.rate])).toEqual([
      ['play', 1],
      ['slowmo', 0.5],
    ])
    expect(segs[0].duration).toBeCloseTo(3.8)
    expect(segs[1].from).toBeCloseTo(21.75)
    expect(segs[1].duration).toBeCloseTo(2)
    expect(clipDuration(c)).toBeCloseTo(5.8)
  })

  it('locate maps wall time into song time', () => {
    expect(locate(segs, 0)).toEqual({ index: 0, songTime: expect.closeTo(21.1) })
    expect(locate(segs, 1)?.songTime).toBeCloseTo(22.1)
    // 1 s into the slow-mo is half a song second.
    expect(locate(segs, 3.8 + 1)).toEqual({ index: 1, songTime: expect.closeTo(22.25) })
    expect(locate(segs, 6)).toBeNull()
  })
})

describe('long clips', () => {
  it('play only their last MAX_CLIP_PLAY_SEC, best second inside it', () => {
    const scores = Array.from({ length: 60 }, (_, i) => (i === 10 || i === 55 ? 100 : 80)) // 30 s of hits
    const c = clip({ scores, endSongTime: 20 + 31 })
    const segs = clipSegments(c)
    expect(segs[0].to - segs[0].from).toBeCloseTo(MAX_CLIP_PLAY_SEC)
    expect(segs[0].to).toBeCloseTo(clipSongRange(c).to)
    expect(segs[1].from).toBeGreaterThanOrEqual(segs[0].from)
    expect(segs[1].from).toBeCloseTo(20 + 55 * 0.5 - BEST_LEAD_SEC - 0.5) // 54 + 55 beat the rest
  })
})

describe('overlay', () => {
  const c = clip({})
  it('the combo counter climbs with the judgments', () => {
    expect(overlayAt(c.judgments, 19.9).combo).toBe(0)
    expect(overlayAt(c.judgments, 21.1).combo).toBe(3) // the video starts after the 3rd hit
    expect(overlayAt(c.judgments, 22.0).combo).toBe(5)
    expect(overlayAt(c.judgments, 99).combo).toBe(8)
  })

  it('a hit bumps the counter and pops for POP_SEC', () => {
    const at = overlayAt(c.judgments, 22.0)
    expect(at.bump).toBe(1)
    expect(at.pops.map((p) => p.progress)).toEqual([expect.closeTo(0.5 / POP_SEC), expect.closeTo(0)])
    expect(overlayAt(c.judgments, 22.3).bump).toBe(0)
    expect(overlayAt(c.judgments, 23.5 + POP_SEC).pops).toEqual([])
    expect(overlayAt(c.judgments, 22).pops[0].judgment).toBe('perfect')
  })

  it('pops overshoot then fade', () => {
    expect(popAt(0)).toEqual({ scale: 1.4, alpha: 1 })
    expect(popAt(0.1).scale).toBeCloseTo(1.2)
    expect(popAt(0.5)).toEqual({ scale: 1, alpha: 1 })
    expect(popAt(0.8).alpha).toBeCloseTo(0.5)
    expect(popAt(1).alpha).toBeCloseTo(0)
  })
})

describe('reel order', () => {
  it('best first, trimmed to the time budget, always at least one clip', () => {
    const a = clip({ id: 'a', comboLength: 8, avgScore: 80 })
    const b = clip({ id: 'b', comboLength: 20, avgScore: 90 })
    const c = clip({ id: 'c', comboLength: 12, avgScore: 85 })
    expect(reelOrder([a, b, c]).map((x) => x.id)).toEqual(['b', 'c', 'a'])
    const d = clipDuration(a)
    expect(reelOrder([a, b, c], d * 2 + 0.01).map((x) => x.id)).toEqual(['b', 'c'])
    expect(reelOrder([a, b, c], 1).map((x) => x.id)).toEqual(['b'])
  })
})
