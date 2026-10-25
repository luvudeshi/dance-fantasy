import { describe, expect, it } from 'vitest'
import type { Routine } from '@shared/routine'
import { buildMotionTrack } from '../routine/track'
import { BotPoseSource } from './botSource'
import type { PlayerFrame, PoseSource } from './poseSource'
import { FRAME_STALL_SEC, GameRun, scoringHorizon, type KeeperLike } from './run'
import { buildCheckpoints, ScoreKeeper, type CheckpointResult, type ScoreState } from './scoring'
import routineJson from './__fixtures__/routine_synth120_normal.json'

class FakeSource implements PoseSource {
  readonly kind = 'webcam' as const
  private cbs = new Set<(f: PlayerFrame) => void>()
  start(): Promise<void> {
    return Promise.resolve()
  }
  stop(): void {}
  onFrame(cb: (f: PlayerFrame) => void): () => void {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }
  latest(): PlayerFrame | null {
    return null
  }
  emit(f: PlayerFrame): void {
    for (const cb of this.cbs) cb(f)
  }
  get listeners(): number {
    return this.cbs.size
  }
}

const frame = (songTime: number, valid = true): PlayerFrame => ({ songTime, pose: {}, visibility: {}, valid })

/** Records calls; finalizes one fake 'good' checkpoint per whole second passed. */
class FakeKeeper implements KeeperLike {
  readonly checkpoints = [{ index: 0, moveIndex: 0, time: 1, target: {}, limbs: [] }, { index: 1, moveIndex: 0, time: 2, target: {}, limbs: [] }]
  frames: number[] = []
  advanced: number[] = []
  private judged = 0
  addFrame(f: PlayerFrame): CheckpointResult[] {
    this.frames.push(f.songTime)
    return this.advanceTo(f.songTime)
  }
  advanceTo(t: number): CheckpointResult[] {
    this.advanced.push(t)
    const out: CheckpointResult[] = []
    while (this.judged < this.checkpoints.length && t > this.checkpoints[this.judged].time + 0.15) {
      out.push({ checkpoint: this.checkpoints[this.judged], score: 75, judgment: 'good', offsetSec: 0, perLimb: {} })
      this.judged++
    }
    return out
  }
  get state(): ScoreState {
    return { score: this.judged * 70, combo: this.judged, maxCombo: this.judged, counts: { perfect: 0, good: this.judged, ok: 0, miss: 0 }, stars: 0, judged: this.judged, total: 2 }
  }
  results(): CheckpointResult[] {
    return []
  }
  summary(): ReturnType<ScoreKeeper['summary']> {
    return { state: this.state, accuracy: 75, perMove: [], hardestMove: null, bestMove: null }
  }
}

describe('GameRun', () => {
  it('scores frames only while playing, but always tracks visibility', () => {
    const src = new FakeSource()
    const keeper = new FakeKeeper()
    let playing = false
    let now = 0
    const run = new GameRun({ keeper, source: src, isPlaying: () => playing, now: () => now })
    src.emit(frame(0.5))
    expect(keeper.frames).toEqual([])
    playing = true
    now = 2000
    src.emit(frame(0.6, false))
    src.emit(frame(1.2))
    expect(keeper.frames).toEqual([0.6, 1.2])
    expect(run.hud.view(2000).pops.map((p) => p.label)).toEqual(['GOOD'])
    // The last valid frame was at now = 2000: no toast.
    expect(run.hud.view(2500).toast).toBeNull()
  })

  it('ticks the bot before advancing the scorer, and stops after finish()', () => {
    const order: string[] = []
    const src = new FakeSource()
    const keeper = new FakeKeeper()
    const origAdvance = keeper.advanceTo.bind(keeper)
    keeper.advanceTo = (t: number) => {
      order.push(`advance ${t}`)
      return origAdvance(t)
    }
    // Like BotPoseSource: tick(t) delivers the frame for t synchronously.
    const bot = {
      tick: (t: number) => {
        order.push(`bot ${t}`)
        src.emit(frame(t))
      },
    }
    const run = new GameRun({ keeper, source: src, bot, isPlaying: () => true, now: () => 0 })
    run.tick(0.5)
    // The bot's frame (scored via addFrame) comes first, then the per-frame advance to t.
    expect(order).toEqual(['bot 0.5', 'advance 0.5', 'advance 0.5'])
    const summary = run.finish({ moves: [] }, 80)
    expect(summary.state.judged).toBe(2) // finish closed every window
    expect(keeper.advanced.at(-1)).toBeGreaterThan(80)
    expect(run.finished).toBe(true)
    expect(src.listeners).toBe(0)
    order.length = 0
    run.tick(1)
    src.emit(frame(3))
    expect(order).toEqual([])
    expect(run.finish({ moves: [] }, 80).state.judged).toBe(2) // idempotent
  })

  it('closes windows only as far as webcam frames have arrived (late frames still count)', () => {
    const src = new FakeSource()
    const keeper = new FakeKeeper()
    const run = new GameRun({ keeper, source: src, isPlaying: () => true, now: () => 0 })
    // Frames lag 0.3 s behind the audible clock (latency + detection).
    src.emit(frame(0.9))
    run.tick(1.2)
    expect(keeper.advanced.at(-1)).toBe(0.9)
    expect(keeper.state.judged).toBe(0) // checkpoint at 1 s still open
    src.emit(frame(1.1))
    run.tick(1.4)
    expect(keeper.advanced.at(-1)).toBe(1.1)
    src.emit(frame(1.2))
    run.tick(1.5)
    expect(keeper.state.judged).toBe(1) // closed by the frame past 1 + 0.15
    // Camera stalls: the clock alone closes windows FRAME_STALL_SEC later.
    run.tick(3)
    expect(keeper.advanced.at(-1)).toBeCloseTo(3 - FRAME_STALL_SEC, 9)
  })

  it('scoringHorizon never passes the clock', () => {
    expect(scoringHorizon(2, 5)).toBe(2)
    expect(scoringHorizon(2, Number.NEGATIVE_INFINITY)).toBe(2 - FRAME_STALL_SEC)
    expect(scoringHorizon(2, 1.8)).toBe(1.8)
  })

  it('does not tick the bot while paused', () => {
    const ticks: number[] = []
    const run = new GameRun({ keeper: new FakeKeeper(), source: new FakeSource(), bot: { tick: (t) => ticks.push(t) }, isPlaying: () => false })
    run.tick(3)
    expect(ticks).toEqual([])
  })
})

describe('GameRun + BotPoseSource + ScoreKeeper (fixture routine)', () => {
  const routine = routineJson as unknown as Routine

  it('judges every checkpoint once, in order, and a good bot mostly scores', async () => {
    const track = buildMotionTrack(routine)
    const bot = new BotPoseSource({ track, skill: 'good', seed: 7 })
    await bot.start()
    const keeper = new ScoreKeeper(buildCheckpoints(routine, routine.mode))
    const run = new GameRun({ keeper, source: bot, bot, isPlaying: () => true, now: () => 0 })
    const end = routine.song.durationSec
    for (let t = -1; t <= end; t += 1 / 60) {
      run.tick(t)
      // Bot frames are delivered up to now, so nothing waits on the stall fallback.
      const w = keeper.config.windowSec
      const judged = keeper.state.judged
      expect(judged).toBeGreaterThanOrEqual(keeper.checkpoints.filter((c) => c.time + w < t - 2 / 30).length)
      expect(judged).toBeLessThanOrEqual(keeper.checkpoints.filter((c) => c.time + w < t).length)
    }
    const summary = run.finish(routine, end)
    const results = keeper.results()
    expect(results.length).toBe(keeper.checkpoints.length)
    expect(results.length).toBeGreaterThan(10)
    for (let i = 1; i < results.length; i++) expect(results[i].checkpoint.time).toBeGreaterThanOrEqual(results[i - 1].checkpoint.time)
    const { counts } = summary.state
    expect(counts.perfect + counts.good + counts.ok + counts.miss).toBe(results.length)
    expect(counts.miss).toBeLessThan(results.length / 2)
    expect(run.hud.autoplay).toBe(true)
  })
})
