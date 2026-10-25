// The teach-mode engine (no React, no DOM): which 8-count and speed, the loop on the TeachClock,
// one PassScorer per pass, tips, red limb tints, pass history and progression. The page owns the
// camera and the canvas; it calls frame() every animation frame and renders getSnapshot()
// (useSyncExternalStore). Tested end-to-end with a fake clock and the demo bot.

import type { Routine } from '@shared/routine'
import type { LimbName } from '@shared/skeleton'
import type { MotionTrack } from '../routine/track'
import { BotPoseSource } from './botSource'
import { HintFeed, hintFor, pickHint, wrongLimbs, type TeachHint } from './hints'
import { JUDGMENT_STYLE } from './hud'
import type { LoopAction, TeachRate } from './mediaClock'
import type { PlayerFrame, PoseSource } from './poseSource'
import { judge, type Checkpoint, type CheckpointResult, type ScoringConfig } from './scoring'
import {
  addPass,
  botPlan,
  FrameBuffer,
  passEnd,
  PassScorer,
  segmentCheckpoints,
  suggestionFor,
  type PassRecord,
  type TeachSegment,
} from './teach'

/** What the engine needs from TeachClock (a fake in tests). */
export interface TeachClockLike {
  readonly playing: boolean
  setRate(rate: TeachRate): void
  setLoop(start: number, end: number, preRollSec?: number): void
  setLooping(on: boolean): void
  seek(t: number): void
  play(): Promise<void>
  pause(): void
  update(): LoopAction
  songTime(): number
}

export type TeachSourceKind = 'webcam' | 'bot'

/** A webcam-like source: frames + a latency the engine keeps at calibration x rate. */
export type LatencySource = Pick<PoseSource, 'onFrame' | 'latest'> & { setLatency(sec: number): void }

export interface TeachEngineDeps {
  clock: TeachClockLike
  routine: Pick<Routine, 'moves' | 'song' | 'seed'>
  track: MotionTrack
  segments: readonly TeachSegment[]
  checkpoints: readonly Checkpoint[]
  base: ScoringConfig
  /** Calibrated camera latency (s, real time). */
  calLatencySec: number
  initialSegment?: number
  initialRate?: TeachRate
  now?: () => number
}

export interface PassProgress {
  judged: number
  total: number
  /** 0..100, null before the first judged beat. */
  accuracy: number | null
}

/** Immutable snapshot for React (replaced on every change). */
export interface TeachState {
  segment: number
  rate: TeachRate
  looping: boolean
  playing: boolean
  source: TeachSourceKind | null
  pass: PassProgress
  history: readonly PassRecord[]
  /** Segments danced well twice in a row at 1x. */
  nailed: ReadonlySet<number>
  /** Played at least once (hides the "press play" prompt). */
  started: boolean
}

/** Per-frame drawing info. */
export interface TeachView {
  t: number
  segment: TeachSegment
  /** Limb -> red tint strength 0..1. */
  wrong: Map<LimbName, number>
  tip: { hint: TeachHint; alpha: number } | null
  /** PIP border colour of the last judgment (null = neutral). */
  tint: string | null
  frame: PlayerFrame | null
}

/** Red limb tint / PIP tint duration (wall ms). */
export const TEACH_TINT_MS = 900

interface Pass {
  scorer: PassScorer
  segment: number
  rate: TeachRate
  /** Counts toward history / progression (a source was live when it started). */
  counted: boolean
}

interface AttachedSource {
  kind: TeachSourceKind
  off: () => void
  latest: () => PlayerFrame | null
  setLatency?: (sec: number) => void
  /** The object attached (to detach only that one). */
  ref: unknown
}

export class TeachEngine {
  private readonly deps: TeachEngineDeps
  private readonly now: () => number
  private state: TeachState
  private readonly listeners = new Set<() => void>()
  private pass: Pass | null = null
  private source: AttachedSource | null = null
  private bot: { bot: BotPoseSource; off: () => void } | null = null
  private readonly frames = new FrameBuffer()
  private readonly feed = new HintFeed()
  private readonly wrongUntil = new Map<LimbName, number>()
  private tint: { color: string; until: number } | null = null
  private readonly passCount = new Map<number, number>()

  constructor(deps: TeachEngineDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => performance.now())
    const n = deps.segments.length
    this.state = {
      segment: Math.min(Math.max(0, deps.initialSegment ?? 0), Math.max(0, n - 1)),
      rate: deps.initialRate ?? 0.5,
      looping: true,
      playing: false,
      source: null,
      pass: { judged: 0, total: 0, accuracy: null },
      history: [],
      nailed: new Set(),
      started: false,
    }
    this.arm()
    const seg = this.segmentNow()
    if (seg) deps.clock.seek(seg.loopStart)
    this.state = { ...this.state, pass: this.idleProgress() }
  }

  // --- store -------------------------------------------------------------------------------

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  readonly getSnapshot = (): TeachState => this.state

  private set(patch: Partial<TeachState>): void {
    this.state = { ...this.state, ...patch }
    for (const cb of [...this.listeners]) cb()
  }

  // --- actions -----------------------------------------------------------------------------

  selectSegment(i: number): void {
    const n = this.deps.segments.length
    if (n === 0) return
    const seg = Math.min(Math.max(0, Math.round(i)), n - 1)
    if (seg === this.state.segment && this.pass) return
    this.set({ segment: seg })
    this.restart()
  }

  selectRate(rate: TeachRate): void {
    if (rate === this.state.rate && this.pass) return
    this.set({ rate })
    this.restart()
  }

  setLooping(on: boolean): void {
    this.set({ looping: on })
    this.deps.clock.setLooping(on)
  }

  async play(): Promise<void> {
    const { clock } = this.deps
    if (clock.playing) return
    if (!this.pass) {
      const seg = this.segmentNow()
      if (!seg) return
      this.arm()
      clock.seek(seg.loopStart)
      this.startPass()
    }
    this.set({ playing: true, started: true })
    try {
      await clock.play()
    } catch (err) {
      this.set({ playing: false })
      throw err
    }
  }

  pause(): void {
    this.deps.clock.pause()
    this.set({ playing: false })
  }

  togglePlay(): Promise<void> {
    if (this.deps.clock.playing) {
      this.pause()
      return Promise.resolve()
    }
    return this.play()
  }

  /** The webcam is live: its frames are scored from the next pass on. */
  attachWebcam(src: LatencySource): void {
    this.detach()
    const off = src.onFrame((f) => this.onFrame(f))
    this.source = { kind: 'webcam', off, latest: () => src.latest(), setLatency: (s) => src.setLatency(s), ref: src }
    this.arm()
    this.set({ source: 'webcam' })
  }

  /** Detaches `src` if it is the attached webcam. */
  detachWebcam(src: LatencySource): void {
    if (this.source?.ref === src) this.detach()
  }

  /** "Teach me with the bot": a demo dancer that improves every pass (no camera needed). */
  useBot(): void {
    this.detach()
    this.source = { kind: 'bot', off: () => undefined, latest: () => this.bot?.bot.latest() ?? null, ref: 'bot' }
    this.arm()
    this.set({ source: 'bot' })
    if (this.pass) this.restart()
  }

  dispose(): void {
    this.detach()
    this.pass = null
    this.deps.clock.pause()
    this.listeners.clear()
  }

  // --- frame loop ----------------------------------------------------------------------------

  /** Every animation frame: loop jump, bot, scoring, fades. */
  frame(nowMs: number = this.now()): TeachView {
    const { clock } = this.deps
    const action = clock.update()
    if (action === 'wrap') {
      this.finishPass()
      this.startPass()
    } else if (action === 'stop') {
      this.finishPass()
    }
    if (this.state.playing !== clock.playing) this.set({ playing: clock.playing })
    const t = clock.songTime()
    if (clock.playing) this.bot?.bot.tick(t)
    const pass = this.pass
    if (pass) this.onResults(pass.scorer.advance(t), pass.rate, nowMs)

    const wrong = new Map<LimbName, number>()
    for (const [limb, until] of this.wrongUntil) {
      const a = (until - nowMs) / TEACH_TINT_MS
      if (a <= 0) this.wrongUntil.delete(limb)
      else wrong.set(limb, Math.min(1, a))
    }
    const tint = this.tint && this.tint.until > nowMs ? this.tint.color : null
    return {
      t,
      segment: this.deps.segments[this.state.segment],
      wrong,
      tip: this.feed.current(nowMs),
      tint,
      frame: this.source?.latest() ?? null,
    }
  }

  // --- internals ---------------------------------------------------------------------------

  private segmentNow(): TeachSegment | undefined {
    return this.deps.segments[this.state.segment]
  }

  /** Loop region, rate and webcam latency for the current segment + speed. */
  private arm(): void {
    const { clock, base, calLatencySec } = this.deps
    const seg = this.segmentNow()
    const rate = this.state.rate
    clock.setRate(rate)
    clock.setLooping(this.state.looping)
    if (seg) clock.setLoop(seg.loopStart, passEnd(seg, rate, base.windowSec, this.source?.kind === 'webcam' ? calLatencySec : 0))
    this.source?.setLatency?.(calLatencySec * rate)
  }

  /** New segment / speed: back to the count-in, a fresh pass (keeps playing if it was). */
  private restart(): void {
    this.pass = null
    this.arm()
    const seg = this.segmentNow()
    if (seg) this.deps.clock.seek(seg.loopStart)
    this.feed.clear()
    this.wrongUntil.clear()
    if (this.deps.clock.playing) this.startPass()
    else this.set({ pass: this.idleProgress() })
  }

  /** Progress shown before a pass starts: nothing judged yet, the segment's beat count. */
  private idleProgress(): PassProgress {
    const seg = this.segmentNow()
    return { judged: 0, total: seg ? segmentCheckpoints(this.deps.checkpoints, seg).length : 0, accuracy: null }
  }

  private startPass(): void {
    const seg = this.segmentNow()
    if (!seg) return
    const scorer = new PassScorer(segmentCheckpoints(this.deps.checkpoints, seg), this.state.rate, this.deps.base)
    this.pass = { scorer, segment: this.state.segment, rate: this.state.rate, counted: this.source !== null }
    this.frames.clear()
    if (this.source?.kind === 'bot') this.spawnBot()
    this.set({ pass: { judged: 0, total: scorer.total, accuracy: null } })
  }

  private finishPass(): void {
    const p = this.pass
    this.pass = null
    if (!p) return
    p.scorer.close()
    const accuracy = p.scorer.accuracy()
    if (!p.counted || accuracy === null) return
    this.passCount.set(p.segment, (this.passCount.get(p.segment) ?? 0) + 1)
    const history = addPass(this.state.history, { segment: p.segment, rate: p.rate, accuracy })
    const nailed = suggestionFor(history, p.segment, p.rate)?.kind === 'nailed' ? new Set([...this.state.nailed, p.segment]) : this.state.nailed
    this.set({ history, nailed, pass: { judged: p.scorer.judged, total: p.scorer.total, accuracy } })
  }

  private spawnBot(): void {
    this.killBot()
    const n = this.passCount.get(this.state.segment) ?? 0
    const plan = botPlan(n)
    const bot = new BotPoseSource({
      track: this.deps.track,
      skill: 'sloppy',
      noiseDeg: plan.noiseDeg,
      lagSec: plan.lagSec * this.state.rate,
      seed: (this.deps.routine.seed * 31 + n) | 0,
    })
    void bot.start()
    this.bot = { bot, off: bot.onFrame((f) => this.onFrame(f)) }
  }

  private killBot(): void {
    if (!this.bot) return
    this.bot.off()
    this.bot.bot.stop()
    this.bot = null
  }

  private detach(): void {
    const s = this.source
    this.source = null
    this.killBot()
    if (s) {
      s.off()
      if (this.pass) this.pass.counted = false
      this.set({ source: null })
    }
  }

  private onFrame(f: PlayerFrame): void {
    this.frames.push(f)
    const p = this.pass
    if (!p || !this.deps.clock.playing) return
    this.onResults(p.scorer.addFrame(f), p.rate, this.now())
  }

  private onResults(results: readonly CheckpointResult[], rate: number, nowMs: number): void {
    const p = this.pass
    if (results.length === 0 || !p) return
    const { base } = this.deps
    const hints: TeachHint[] = []
    for (const r of results) {
      const player = this.frames.nearest(r.checkpoint.time + (r.offsetSec ?? 0))?.pose ?? null
      hints.push(hintFor(r, player, rate, base))
      for (const limb of wrongLimbs(r, base.thresholds.ok)) this.wrongUntil.set(limb, nowMs + TEACH_TINT_MS)
      this.tint = { color: JUDGMENT_STYLE[judge(r.score, base)].color, until: nowMs + TEACH_TINT_MS }
    }
    const hint = pickHint(hints)
    if (hint && this.source) this.feed.push(hint, nowMs)
    this.set({ pass: { judged: p.scorer.judged, total: p.scorer.total, accuracy: p.scorer.accuracy() } })
  }
}
