// One scored party round: tracked camera frames -> one score keeper per dancer (each judged on its
// own, with its own combo) -> per-player HUD state. Mirrors game/run.ts GameRun, minus the
// single-player HUD: tick(songTime) every animation frame, finish() at the end of the song.
//
// Scorer adapter: keepers come from `makeKeeper` (classic ScoreKeeper by default). Scoring v2 drops in
// with game/createScoreKeeper.ts: makeKeeper: (cps, config) => createScoreKeeper(cps, config, game.track).

import type { Routine } from '@shared/routine'
import { scoringHorizon, type KeeperLike } from '../game/run'
import { JUDGMENT_STYLE } from '../game/hud'
import { ScoreKeeper, type Checkpoint, type CheckpointResult, type Judgment, type ResultsSummary, type ScoringConfig } from '../game/scoring'
import type { PlayerFrame } from '../game/poseSource'
import { colorOf, displayName, type PartyColor, type PartyPlayer } from './players'
import type { PartyTracker, TrackedFrame } from './tracker'

export type MakeKeeper = (checkpoints: readonly Checkpoint[], config: ScoringConfig) => KeeperLike

export const classicKeeper: MakeKeeper = (checkpoints, config) => new ScoreKeeper(checkpoints, config)

/** Seconds past the last checkpoint / song end at which every window has surely closed (as GameRun). */
const FINISH_PAD_SEC = 5
/** A judgment callout stays up this long (ms). */
export const CALLOUT_MS = 900
/** A dancer counts as "in the mirror" while tracked within this long (ms). */
export const SEEN_MS = 600

export interface Callout {
  /** Increases with every new judgment of this player (React key: restarts the animation). */
  id: number
  judgment: Judgment
  label: string
  /** 0..1 through CALLOUT_MS. */
  age: number
}

export interface PartyPlayerView {
  player: PartyPlayer
  name: string
  color: PartyColor
  score: number
  combo: number
  maxCombo: number
  callout: Callout | null
  /** Tracked recently. */
  seen: boolean
  /** Latest tracked frame (raw image points for the skeleton), null when not seen. */
  frame: PlayerFrame | null
}

export interface PartyStanding {
  player: PartyPlayer
  summary: ResultsSummary
  results: CheckpointResult[]
}

export interface PartyRunOptions {
  tracker: PartyTracker
  players: readonly PartyPlayer[]
  checkpoints: readonly Checkpoint[]
  config: ScoringConfig
  makeKeeper?: MakeKeeper
  /** false while paused / stopped: frames are not scored then (tracking goes on). */
  isPlaying: () => boolean
  now?: () => number
}

interface PerPlayer {
  keeper: KeeperLike
  last: { judgment: Judgment; at: number; id: number } | null
  frame: PlayerFrame | null
  seenAt: number
}

export class PartyRun {
  readonly players: readonly PartyPlayer[]
  private readonly per: PerPlayer[]
  private readonly isPlaying: () => boolean
  private readonly now: () => number
  private unsubscribe: (() => void) | null
  private lastFrameTime = Number.NEGATIVE_INFINITY
  private done = false
  private seq = 0

  constructor(o: PartyRunOptions) {
    const make = o.makeKeeper ?? classicKeeper
    this.players = o.players
    this.isPlaying = o.isPlaying
    this.now = o.now ?? (() => performance.now())
    this.per = o.players.map(() => ({ keeper: make(o.checkpoints, o.config), last: null, frame: null, seenAt: Number.NEGATIVE_INFINITY }))
    this.unsubscribe = o.tracker.onTracked((t) => this.onTracked(t))
  }

  get finished(): boolean {
    return this.done
  }

  keeper(slot: number): KeeperLike | undefined {
    return this.per[slot]?.keeper
  }

  private note(slot: number, results: readonly CheckpointResult[]): void {
    const last = results.at(-1)
    if (!last) return
    this.per[slot].last = { judgment: last.judgment, at: this.now(), id: ++this.seq }
  }

  private onTracked(t: TrackedFrame): void {
    if (this.done) return
    const now = this.now()
    t.players.forEach((f, i) => {
      const p = this.per[i]
      if (!p) return
      p.frame = f
      if (f) p.seenAt = now
    })
    if (!this.isPlaying()) return
    if (Number.isFinite(t.songTime)) this.lastFrameTime = Math.max(this.lastFrameTime, t.songTime)
    t.players.forEach((f, i) => {
      if (f && this.per[i]) this.note(i, this.per[i].keeper.addFrame(f))
    })
  }

  /** Every animation frame: closes windows up to the newest delivered frame (game/run.ts scoringHorizon). */
  tick(songTime: number): void {
    if (this.done) return
    const h = scoringHorizon(songTime, this.lastFrameTime)
    this.per.forEach((p, i) => this.note(i, p.keeper.advanceTo(h)))
  }

  view(nowMs: number = this.now()): PartyPlayerView[] {
    return this.players.map((player, i) => {
      const p = this.per[i]
      const s = p.keeper.state
      const age = p.last ? (nowMs - p.last.at) / CALLOUT_MS : 1
      const seen = nowMs - p.seenAt <= SEEN_MS
      return {
        player,
        name: displayName(player),
        color: colorOf(player),
        score: s.score,
        combo: s.combo,
        maxCombo: s.maxCombo,
        callout: p.last && age < 1 ? { id: p.last.id, judgment: p.last.judgment, label: JUDGMENT_STYLE[p.last.judgment].label, age: Math.max(0, age) } : null,
        seen,
        frame: seen ? p.frame : null,
      }
    })
  }

  /** Closes every remaining window; per-player summaries in slot order. Idempotent. */
  finish(routine: Pick<Routine, 'moves'>, endTime: number): PartyStanding[] {
    if (!this.done) {
      for (const p of this.per) {
        const cps = p.keeper.checkpoints
        const lastCp = cps.length > 0 ? cps[cps.length - 1].time : 0
        p.keeper.advanceTo(Math.max(endTime, lastCp) + FINISH_PAD_SEC)
      }
      this.done = true
      this.dispose()
    }
    return this.players.map((player, i) => ({ player, summary: this.per[i].keeper.summary(routine), results: this.per[i].keeper.results() }))
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
