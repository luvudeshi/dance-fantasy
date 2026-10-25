import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComboEvent } from '@shared/combo-event'
import type { Routine } from '@shared/routine'
import standingJson from '../game/__fixtures__/routine_synth120_normal.json'
import { BotPoseSource, type BotSkill } from '../game/botSource'
import { buildCheckpoints, ScoreKeeper, type CheckpointResult } from '../game/scoring'
import { buildMotionTrack } from '../routine/track'
import { ComboClipper, TAIL_MS } from './comboClipper'
import { comboEventFor } from './comboEvents'
import { MemoryClipStore } from './clipStore'
import { fakeRecorders, fakeStream, results } from './testUtil'
import { clipDuration, MAX_CLIP_PLAY_SEC } from './timeline'
import type { ClipMeta } from './types'

const MOVES = Array.from({ length: 40 }, (_, i) => ({ id: i === 2 ? 'star_pose' : `move${i}`, name: i === 2 ? 'Star Pose' : `Move ${i}` }))

function setup(opts: { stream?: MediaStream | null; maxClips?: number } = {}) {
  const store = new MemoryClipStore()
  const rec = fakeRecorders()
  let song = 0
  const kept: ClipMeta[] = []
  let n = 0
  const clipper = new ComboClipper({
    stream: opts.stream === undefined ? fakeStream() : opts.stream,
    moves: MOVES,
    playerId: 'local',
    playerName: 'You',
    latencySec: 0.12,
    songTime: () => song,
    store,
    createRecorder: rec.factory,
    mimeType: 'video/webm',
    onKeep: (c) => kept.push(c),
    maxClips: opts.maxClips,
    newId: () => `clip${n++}`,
  })
  /** Feeds results one by one, moving the song clock to each checkpoint time + 0.2 s. */
  const feed = (rs: CheckpointResult[]): void => {
    for (const r of rs) {
      song = r.checkpoint.time + 0.2
      clipper.push([r])
    }
  }
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0)
  }
  return { clipper, store, rec, kept, feed, flush, setSong: (t: number) => (song = t) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ComboClipper', () => {
  it('starts a recorder on the 3rd Good-or-better', () => {
    const { clipper, rec, feed } = setup()
    feed(results('PG'))
    expect(rec.made).toHaveLength(0)
    feed(results('P', { t0: 11 }))
    expect(rec.made).toHaveLength(1)
    expect(rec.made[0].state).toBe('recording')
    expect(clipper.recording).toBe(true)
  })

  it('discards a streak that breaks before 8', async () => {
    const { clipper, rec, store, kept, feed, flush } = setup()
    feed(results('PPPPPPPM'))
    expect(rec.made[0].state).toBe('inactive')
    await flush()
    await clipper.finish()
    expect(clipper.clips).toEqual([])
    expect(kept).toEqual([])
    expect(store.blobs.size).toBe(0)
  })

  it('keeps a streak of 8+ and stops 1 s after it ends', async () => {
    const { clipper, rec, store, kept, feed, flush } = setup()
    feed(results('PPPGGPPPPM'))
    const r = rec.made[0]
    expect(r.state).toBe('recording')
    await vi.advanceTimersByTimeAsync(TAIL_MS - 1)
    expect(r.state).toBe('recording')
    await vi.advanceTimersByTimeAsync(1)
    expect(r.state).toBe('inactive')
    await flush()
    expect(clipper.clips).toHaveLength(1)
    const c = clipper.clips[0]
    expect(c.comboLength).toBe(9)
    expect(c.judgments.map((j) => j.time)).toEqual(results('PPPPPPPPP').map((x) => x.checkpoint.time))
    expect(c.avgScore).toBeCloseTo((95 * 7 + 80 * 2) / 9)
    expect(c.startSongTime).toBeCloseTo(11 + 0.2) // the recorder starts at the 3rd hit
    expect(c.videoLatencySec).toBe(0.12)
    expect(c.hasVideo).toBe(true)
    expect(c.mirrorVideo).toBe(false)
    expect(store.blobs.has(c.id)).toBe(true)
    expect(kept).toEqual([c])
  })

  it('records the best move id and the judgments with their times', async () => {
    const { clipper, feed, flush } = setup()
    // moves of 4 checkpoints: move0 = 80s, move1 = 95s, move2 = 90s
    feed(results('GGGGPPPPPPPPM', { score: (i) => (i < 4 ? 80 : i < 8 ? 95 : 90) }))
    await vi.advanceTimersByTimeAsync(TAIL_MS)
    await flush()
    const c = clipper.clips[0]
    expect(c.bestMoveId).toBe('move1')
    expect(c.bestMoveName).toBe('Move 1')
    expect(c.judgments[0]).toEqual({ time: 10, judgment: 'good', score: 80, moveId: 'move0', moveIndex: 0 })
  })

  it('song end keeps a running 8+ streak at once and discards a shorter one', async () => {
    const a = setup()
    a.feed(results('PPPPPPPP'))
    await a.clipper.finish()
    expect(a.clipper.clips).toHaveLength(1)
    const b = setup()
    b.feed(results('PPPPP'))
    await b.clipper.finish()
    expect(b.clipper.clips).toHaveLength(0)
    expect(b.rec.made[0].state).toBe('inactive')
  })

  it('caps at 6 clips, a stronger clip replacing the weakest (and its stored video)', async () => {
    const { clipper, store, feed, flush } = setup()
    // Seven kept streaks: lengths 8, 9, 10, 11, 12, 13 then 14.
    let t = 0
    for (let len = 8; len <= 14; len++) {
      feed(results(`${'P'.repeat(len)}M`, { t0: t }))
      t += (len + 1) * 0.5 + 5
      await vi.advanceTimersByTimeAsync(TAIL_MS)
      await flush()
    }
    await clipper.finish()
    expect(clipper.clips.map((c) => c.comboLength).sort((x, y) => x - y)).toEqual([9, 10, 11, 12, 13, 14])
    expect(store.blobs.size).toBe(6)
    expect([...store.blobs.keys()].sort()).toEqual(clipper.clips.map((c) => c.id).sort())
  })

  it('a weaker 7th clip is not stored, but still reported as a kept combo', async () => {
    const { clipper, store, kept, feed, flush } = setup({ maxClips: 2 })
    let t = 0
    for (const len of [12, 12, 8]) {
      feed(results(`${'P'.repeat(len)}M`, { t0: t }))
      t += 20
      await vi.advanceTimersByTimeAsync(TAIL_MS)
      await flush()
    }
    expect(clipper.clips.map((c) => c.comboLength)).toEqual([12, 12])
    expect(store.blobs.size).toBe(2)
    expect(kept.map((c) => c.comboLength)).toEqual([12, 12, 8])
  })

  it('without a stream it keeps clip numbers but no video', async () => {
    const { clipper, rec, store, feed } = setup({ stream: null })
    feed(results('PPPPPPPPPP'))
    await clipper.finish()
    expect(rec.made).toHaveLength(0)
    expect(clipper.clips[0].hasVideo).toBe(false)
    expect(store.blobs.size).toBe(0)
  })

  it('round stats: longest streak, perfects, freeze-move scores', () => {
    const { clipper, feed } = setup()
    // checkpoints 8..11 are move 2 (star_pose)
    feed(results('PPPGMGGGPPGPO', { score: (i, j) => (i >= 8 && i < 12 ? 70 + i : j === 'perfect' ? 95 : 80) }))
    const s = clipper.stats()
    expect(s.longestCombo).toBe(7)
    expect(s.perfects).toBe(6)
    expect(s.freezes).toEqual([{ moveId: 'star_pose', moveName: 'Star Pose', avgScore: 79.5 }])
  })

  it('dispose stops every recorder and keeps nothing', async () => {
    const { clipper, rec, feed } = setup()
    feed(results('PPPPPPPPPM'))
    feed(results('PPPP', { t0: 30 }))
    clipper.dispose()
    expect(rec.made.every((r) => r.state === 'inactive')).toBe(true)
    await clipper.finish()
    expect(clipper.clips).toEqual([])
  })

  it('emits a ComboEvent with the numbers only', async () => {
    const { clipper, feed } = setup()
    feed(results('PPPPPPPP'))
    await clipper.finish()
    const e: ComboEvent = comboEventFor(clipper.clips[0], { roomId: null, songId: 'abc' }, new Date('2026-10-25T20:00:00Z'))
    expect(e).toEqual({
      version: 1,
      at: '2026-10-25T20:00:00.000Z',
      roomId: null,
      playerId: 'local',
      songId: 'abc',
      songTime: 10,
      start: expect.closeTo(11.2),
      end: expect.closeTo(13.7),
      comboLength: 8,
      avgScore: 95,
      bestMoveId: 'move0',
      clipId: 'clip0',
    })
    expect(JSON.stringify(e)).not.toMatch(/blob|video/i)
  })
})

describe('ComboClipper on a recorded round', () => {
  // A recorded score sequence: the autoplay bot dances a real generated routine through the
  // real ScoreKeeper, 60 frames per song second.
  async function playRound(skill: BotSkill) {
    const routine = standingJson as unknown as Routine
    const keeper = new ScoreKeeper(buildCheckpoints(routine, routine.mode))
    const bot = new BotPoseSource({ track: buildMotionTrack(routine), skill, seed: 1 })
    const env = setup()
    bot.onFrame((f) => env.clipper.push(keeper.addFrame(f)))
    void bot.start()
    for (let i = 0; i <= Math.ceil((routine.song.durationSec + 1) * 60); i++) {
      const t = i / 60
      env.setSong(t)
      bot.tick(t)
      env.clipper.push(keeper.advanceTo(t))
      if (i % 6 === 0) await vi.advanceTimersByTimeAsync(100)
    }
    env.clipper.push(keeper.advanceTo(Number.POSITIVE_INFINITY))
    await env.clipper.finish()
    return env
  }

  const valid = (c: ClipMeta): void => {
    expect(c.comboLength).toBeGreaterThanOrEqual(8)
    expect(c.comboLength).toBe(c.judgments.length)
    expect(c.endSongTime).toBeGreaterThan(c.startSongTime)
    expect(c.judgments.every((j, i) => i === 0 || j.time > c.judgments[i - 1].time)).toBe(true)
    expect(c.judgments.every((j) => j.judgment === 'perfect' || j.judgment === 'good')).toBe(true)
  }

  it('a sloppy dancer: short streaks discarded, long ones kept with their videos', async () => {
    const { clipper, rec, store } = await playRound('sloppy')
    const clips = clipper.clips
    expect(rec.made.length).toBeGreaterThan(clips.length) // some recordings were thrown away
    expect(clips.length).toBeGreaterThanOrEqual(2)
    expect(clips.length).toBeLessThanOrEqual(6)
    expect(rec.made.every((r) => r.state === 'inactive')).toBe(true)
    expect(store.blobs.size).toBe(clips.length)
    clips.forEach(valid)
    const stats = clipper.stats()
    expect(stats.longestCombo).toBe(Math.max(...clips.map((c) => c.comboLength)))
    expect(stats.freezes.length).toBeGreaterThan(0)
  })

  it('a good dancer: one long combo, played back within the reel budget', async () => {
    const { clipper } = await playRound('good')
    expect(clipper.clips.length).toBeGreaterThan(0)
    clipper.clips.forEach(valid)
    for (const c of clipper.clips) expect(clipDuration(c)).toBeLessThanOrEqual(MAX_CLIP_PLAY_SEC + 2 + 1e-9)
  })
})
