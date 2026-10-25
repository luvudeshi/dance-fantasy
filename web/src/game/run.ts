// One scored play-through: pose frames -> ScoreKeeper -> HUD events. The play stage calls
// tick(songTime) every animation frame (bot first, then advanceTo) and finish() at the end.
//
// Fairness: webcam frames arrive late (their songTime is the moment the player made the pose,
// i.e. capture time minus the calibrated latency, and detection takes a while on top), so a
// checkpoint's window must only close once frames up to its end have been delivered. tick()
// therefore advances the scorer to the newest delivered frame's song time, not to the audible
// "now"; only when frames stop coming (FRAME_STALL_SEC) does it close windows on the clock alone,
// so a player who walked off still gets misses and the game never stalls.

import type { Routine } from '@shared/routine'
import { Hud } from './hud'
import type { PlayerFrame, PoseSource } from './poseSource'
import type { CheckpointResult, ResultsSummary, ScoreKeeper } from './scoring'

export type KeeperLike = Pick<ScoreKeeper, 'addFrame' | 'advanceTo' | 'state' | 'results' | 'summary' | 'checkpoints'>

/** A source that is driven by the game loop (BotPoseSource). */
export interface Tickable {
  tick(songTime: number): void
}

export interface GameRunOptions {
  keeper: KeeperLike
  source: PoseSource
  /** Bot sources are ticked every frame before scoring. */
  bot?: Tickable | null
  /** false while paused / stopped: frames are not scored then. */
  isPlaying: () => boolean
  now?: () => number
  /** Every batch of finalized checkpoints (SFX), with the combo before the batch. */
  onResults?: (results: readonly CheckpointResult[], comboBefore: number) => void
}

/** Seconds past the last checkpoint / song end at which every window has surely closed. */
const FINISH_PAD_SEC = 5

/** Without any frame for this long (song time), windows close on the clock alone. */
export const FRAME_STALL_SEC = 0.75

/**
 * Song time the scorer may safely advance to: the newest delivered frame, but never past the
 * clock, and never more than FRAME_STALL_SEC behind it.
 */
export function scoringHorizon(songTime: number, lastFrameTime: number, stallSec = FRAME_STALL_SEC): number {
  return Math.min(songTime, Math.max(lastFrameTime, songTime - stallSec))
}

export class GameRun {
  readonly keeper: KeeperLike
  readonly source: PoseSource
  readonly hud: Hud
  private readonly bot: Tickable | null
  private readonly isPlaying: () => boolean
  private readonly now: () => number
  private unsubscribe: (() => void) | null
  private done = false
  private lastFrameTime = Number.NEGATIVE_INFINITY
  private combo = 0
  private readonly onResults: GameRunOptions['onResults']

  constructor(o: GameRunOptions) {
    this.keeper = o.keeper
    this.source = o.source
    this.bot = o.bot ?? null
    this.isPlaying = o.isPlaying
    this.now = o.now ?? (() => performance.now())
    this.onResults = o.onResults
    this.hud = new Hud({ autoplay: o.source.kind === 'bot' })
    this.hud.watch(this.now())
    this.unsubscribe = o.source.onFrame((f) => this.onFrame(f))
  }

  get finished(): boolean {
    return this.done
  }

  /** HUD (+ the onResults hook unless `quiet`: the end-of-song sweep makes no sound). */
  private emit(results: CheckpointResult[], quiet = false): void {
    if (results.length === 0) return
    const state = this.keeper.state
    this.hud.push(results, state, this.now())
    const before = this.combo
    this.combo = state.combo
    if (!quiet) this.onResults?.(results, before)
  }

  private onFrame(frame: PlayerFrame): void {
    if (this.done) return
    this.hud.noteFrame(frame.valid, this.now())
    if (!this.isPlaying()) return
    if (Number.isFinite(frame.songTime)) this.lastFrameTime = Math.max(this.lastFrameTime, frame.songTime)
    this.emit(this.keeper.addFrame(frame))
  }

  /** Every animation frame while the game is on stage. */
  tick(songTime: number): void {
    if (this.done) return
    if (this.isPlaying()) this.bot?.tick(songTime)
    this.emit(this.keeper.advanceTo(scoringHorizon(songTime, this.lastFrameTime)))
  }

  /** Closes every remaining checkpoint window and returns the summary. Idempotent. */
  finish(routine: Pick<Routine, 'moves'>, endTime: number): ResultsSummary {
    if (!this.done) {
      const cps = this.keeper.checkpoints
      const lastCp = cps.length > 0 ? cps[cps.length - 1].time : 0
      this.emit(this.keeper.advanceTo(Math.max(endTime, lastCp) + FINISH_PAD_SEC), true)
      this.done = true
      this.dispose()
    }
    return this.keeper.summary(routine)
  }

  /** Stops listening to the source (does not stop the source itself). */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
