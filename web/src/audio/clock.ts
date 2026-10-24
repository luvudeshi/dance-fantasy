// Audio-clock helpers. All musical timing comes from the AudioContext clock, never from
// setTimeout/setInterval or Date: schedule audio at `startAt + t`, and derive visuals
// each animation frame from songTime().

/**
 * Context time of the sample that is audible right now. ctx.currentTime is the time of
 * the next block to be *rendered*; the speakers lag behind it by the output latency
 * (a few ms wired, 100-300 ms on Bluetooth). getOutputTimestamp() reports exactly that
 * lag; when unavailable or implausible, fall back to currentTime - (base + output latency).
 */
export function audibleContextTime(ctx: AudioContext, nowMs: number = performance.now()): number {
  const current = ctx.currentTime
  if (typeof ctx.getOutputTimestamp === 'function') {
    const { contextTime, performanceTime } = ctx.getOutputTimestamp()
    if (
      contextTime !== undefined &&
      performanceTime !== undefined &&
      contextTime > 0 &&
      performanceTime > 0 &&
      Number.isFinite(contextTime) &&
      Number.isFinite(performanceTime)
    ) {
      const t = contextTime + (nowMs - performanceTime) / 1000
      // Guard against bogus timestamps (seen on some platforms right after start/resume).
      if (t <= current + 0.02 && t >= current - 1) return t
    }
  }
  return current - outputLatencySec(ctx)
}

/** Best estimate of how far the speakers lag ctx.currentTime (seconds, >= 0). */
export function outputLatencySec(ctx: AudioContext): number {
  const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0
  const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0
  return Math.max(0, base + out)
}

/** A song started with `source.start(startAt)` on `ctx`. */
export interface SongClock {
  ctx: AudioContext
  /** Context time at which song time 0 was scheduled. */
  startAt: number
  /** true: what you hear (latency compensated); false: raw ctx.currentTime - startAt. */
  compensateLatency: boolean
}

/** Current song position in seconds (negative before the song starts). */
export function songTime(clock: SongClock, nowMs?: number): number {
  const t = clock.compensateLatency ? audibleContextTime(clock.ctx, nowMs) : clock.ctx.currentTime
  return t - clock.startAt
}

/** Index of the last beat at or before `t` (-1 before the first beat). Binary search. */
export function beatIndexAt(beats: readonly number[], t: number): number {
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
  return found
}
