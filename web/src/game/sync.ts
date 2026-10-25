// A/V sync meter for the play screen. Visuals are drawn at clock.songTime() (ctx.currentTime
// minus reported output latency). At every beat crossing we compare that with an independent
// estimate from AudioContext.getOutputTimestamp(), extrapolated to the frame's rAF
// timestamp: drift = drawn - estimate (ms, + = visuals ahead of the speakers). Also counts
// long frames (> 33 ms between rAF callbacks). Pure apart from the timestamps fed in.

import type { OutputTimestampLike } from './clock'

export const LONG_FRAME_MS = 33
/** Larger |drift| is a bogus timestamp (seen right after start/resume on some platforms), not drift. */
export const MAX_PLAUSIBLE_DRIFT_MS = 1000

export interface SyncStats {
  /** Beat crossings with a drift sample. */
  beats: number
  /** Largest |drift|, ms. */
  maxDriftMs: number
  /** Signed mean drift, ms (+ = visuals ahead of the audio). */
  meanDriftMs: number
  /** 95th percentile of |drift|, ms. */
  p95DriftMs: number
  lastDriftMs: number | null
  /** Implausible samples ignored (|drift| > MAX_PLAUSIBLE_DRIFT_MS). */
  rejected: number
  /** Frame intervals measured (continuous frames only). */
  frames: number
  /** Frame intervals > LONG_FRAME_MS. */
  longFrames: number
  maxFrameMs: number
}

/**
 * Song time audible at `frameMs` (a rAF / performance.now() timestamp) according to an output
 * timestamp, relative to the song's start context time. Null when the timestamp is missing or
 * not yet valid (zeros right after the context starts).
 */
export function estimateSongTime(ts: OutputTimestampLike | null, frameMs: number, startAt: number | null): number | null {
  if (!ts || startAt === null) return null
  const { contextTime, performanceTime } = ts
  if (contextTime === undefined || performanceTime === undefined) return null
  if (!(contextTime > 0) || !(performanceTime > 0) || !Number.isFinite(contextTime) || !Number.isFinite(performanceTime)) return null
  return contextTime + (frameMs - performanceTime) / 1000 - startAt
}

/** Index of the last beat b with prevT < b <= t (the newest beat crossed this frame), else -1. */
export function crossedBeat(beats: readonly number[], prevT: number, t: number): number {
  if (!(t > prevT)) return -1
  let lo = 0
  let hi = beats.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (beats[mid] <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found >= 0 && beats[found] > prevT ? found : -1
}

/** Nearest-rank percentile (p in 0..100) of an ascending array; 0 when empty. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

/** Aggregates drift samples and frame intervals. */
export class DriftMeter {
  private drifts: number[] = []
  private sum = 0
  private max = 0
  private last: number | null = null
  private rejectedCount = 0
  private frameCount = 0
  private longCount = 0
  private maxFrame = 0

  addDrift(ms: number): void {
    if (!Number.isFinite(ms) || Math.abs(ms) > MAX_PLAUSIBLE_DRIFT_MS) {
      this.rejectedCount++
      return
    }
    this.drifts.push(ms)
    this.sum += ms
    this.max = Math.max(this.max, Math.abs(ms))
    this.last = ms
  }

  addFrame(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) return
    this.frameCount++
    if (intervalMs > LONG_FRAME_MS) this.longCount++
    this.maxFrame = Math.max(this.maxFrame, intervalMs)
  }

  stats(): SyncStats {
    const n = this.drifts.length
    const abs = this.drifts.map(Math.abs).sort((a, b) => a - b)
    return {
      beats: n,
      maxDriftMs: this.max,
      meanDriftMs: n > 0 ? this.sum / n : 0,
      p95DriftMs: percentile(abs, 95),
      lastDriftMs: this.last,
      rejected: this.rejectedCount,
      frames: this.frameCount,
      longFrames: this.longCount,
      maxFrameMs: this.maxFrame,
    }
  }

  reset(): void {
    this.drifts = []
    this.sum = 0
    this.max = 0
    this.last = null
    this.rejectedCount = 0
    this.frameCount = 0
    this.longCount = 0
    this.maxFrame = 0
  }
}

/** One-line summary logged at the end of a song. */
export function syncSummary(s: SyncStats): string {
  return `sync: beats=${s.beats} maxDrift=${s.maxDriftMs.toFixed(1)} ms p95=${s.p95DriftMs.toFixed(1)} ms longFrames=${s.longFrames}`
}

/**
 * Per-frame driver: feed it every animation frame. A frame that follows a break (hidden tab,
 * restart) only re-arms the meter, so returning to the tab is neither a long frame nor a burst
 * of stale beat crossings.
 */
export class SyncMonitor {
  readonly meter = new DriftMeter()
  private prevT: number | null = null
  private prevFrameMs: number | null = null
  private readonly beats: readonly number[]

  constructor(beats: readonly number[]) {
    this.beats = beats
  }

  /**
   * `drawT`: the song time this frame was drawn at. `estimate(frameMs)`: independent song-time
   * estimate (only called on beat crossings). Returns the drift sampled this frame, if any.
   */
  frame(frameMs: number, drawT: number, estimate: (frameMs: number) => number | null): number | null {
    const prevT = this.prevT
    const prevFrame = this.prevFrameMs
    this.prevT = drawT
    this.prevFrameMs = frameMs
    if (prevT === null || prevFrame === null) return null
    this.meter.addFrame(frameMs - prevFrame)
    if (crossedBeat(this.beats, prevT, drawT) < 0) return null
    const est = estimate(frameMs)
    if (est === null) return null
    const drift = (drawT - est) * 1000
    this.meter.addDrift(drift)
    return drift
  }

  /** Next frame starts a new continuous stretch (call on visibility changes, restarts). */
  breakContinuity(): void {
    this.prevT = null
    this.prevFrameMs = null
  }

  stats(): SyncStats {
    return this.meter.stats()
  }

  reset(): void {
    this.meter.reset()
    this.breakContinuity()
  }

  summary(): string {
    return syncSummary(this.stats())
  }
}

/** Automation hook: window.__midnightSync.stats() / .reset() while the play screen is mounted. */
export interface MidnightSyncHook {
  stats(): SyncStats
  reset(): void
}

declare global {
  interface Window {
    __midnightSync?: MidnightSyncHook
  }
}
