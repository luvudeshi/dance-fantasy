// Teach-mode playback clock: the song on an <audio> element so it can play at 0.5x / 0.75x / 1x
// with the pitch preserved (the browser's own time-stretcher: preservesPitch). GameClock (the
// AudioContext clock) can't do that: an AudioBufferSourceNode's playbackRate changes pitch.
//
// Song time comes from media.currentTime, which browsers only refresh coarsely, so between
// refreshes it is extrapolated with performance.now() x rate (MediaTimeSmoother, pure and
// unit-tested): monotonic within a play segment, snapping on seeks / loop restarts.
//
// Latency: Chrome and Firefox already report currentTime as the AUDIBLE position (their audio
// clocks subtract the output delay), so the element isn't routed through an AudioContext and
// `outputLatencySec` defaults to 0. When set, it is subtracted as latency x rate (a real-time
// delay covers that much song time at the current rate).

import { fetchAudio } from '../api'
import type { SongTimeAt } from './poseSource'

export const TEACH_RATES = [0.5, 0.75, 1] as const
export type TeachRate = (typeof TEACH_RATES)[number]

export const isTeachRate = (v: unknown): v is TeachRate => TEACH_RATES.some((r) => r === v)

/** A refreshed currentTime this far (song s) from the extrapolation is a jump (seek / stall): snap. */
export const SMOOTH_SNAP_SEC = 0.25
/** Fraction of a small disagreement corrected at each refresh (the rest is absorbed over time). */
export const SMOOTH_GAIN = 0.15

/**
 * Smoothed media time (pure). Call reset() whenever the play state, rate or position changes
 * discontinuously (play, pause, seek, rate change); sample() every animation frame with the raw
 * currentTime. While running, the result never goes backwards except on a snap.
 */
export class MediaTimeSmoother {
  private anchorT = 0
  private anchorMs = 0
  private rate = 1
  private running = false
  private lastRaw = Number.NaN
  private lastOut = Number.NEGATIVE_INFINITY

  reset(mediaTime: number, nowMs: number, rate: number, running: boolean): void {
    this.anchorT = mediaTime
    this.anchorMs = nowMs
    this.rate = rate > 0 && Number.isFinite(rate) ? rate : 1
    this.running = running
    this.lastRaw = mediaTime
    this.lastOut = Number.NEGATIVE_INFINITY
  }

  get isRunning(): boolean {
    return this.running
  }

  get currentRate(): number {
    return this.rate
  }

  /** Extrapolated time at nowMs without a new reading. */
  predict(nowMs: number): number {
    return this.running ? this.anchorT + ((nowMs - this.anchorMs) / 1000) * this.rate : this.anchorT
  }

  sample(rawMediaTime: number, nowMs: number): number {
    if (!this.running) {
      this.anchorT = rawMediaTime
      this.anchorMs = nowMs
      this.lastRaw = rawMediaTime
      this.lastOut = rawMediaTime
      return rawMediaTime
    }
    if (rawMediaTime !== this.lastRaw) {
      this.lastRaw = rawMediaTime
      const predicted = this.predict(nowMs)
      const err = rawMediaTime - predicted
      if (!(Math.abs(err) <= SMOOTH_SNAP_SEC)) {
        this.anchorT = rawMediaTime
        this.anchorMs = nowMs
        this.lastOut = rawMediaTime
        return rawMediaTime
      }
      this.anchorT = predicted + err * SMOOTH_GAIN
      this.anchorMs = nowMs
    }
    const out = Math.max(this.predict(nowMs), this.lastOut)
    this.lastOut = out
    return out
  }
}

/** Audible song time: smoothed media time minus the output latency, which covers latency x rate of song. */
export const audibleMediaTime = (mediaTime: number, latencySec: number, rate: number): number => mediaTime - latencySec * rate

/**
 * Song time at which a performance.now() timestamp `perfMs` was audible, given the song time
 * now (pure): a real-time interval covers interval x rate of song (0 while paused). Frames from
 * before the current play segment (`epochMs`: last seek / loop restart) map to NaN, so a loop
 * restart never credits the previous pass's frames to the new one.
 */
export function songTimeAtPerf(nowSong: number, nowMs: number, perfMs: number, rate: number, epochMs: number): number {
  if (!(perfMs >= epochMs)) return Number.NaN
  return nowSong - ((nowMs - perfMs) / 1000) * rate
}

export type LoopAction = 'none' | 'wrap' | 'stop'

/** What to do at song time t inside a loop region [.., end]: keep going, jump back, or stop there. */
export function loopAction(t: number, end: number, looping: boolean, ended = false): LoopAction {
  if (!(t >= end) && !ended) return 'none'
  return looping ? 'wrap' : 'stop'
}

type PitchMedia = HTMLMediaElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean }

/** preservesPitch on, with the prefixed fallbacks of older Safari / Firefox. */
export function preservePitch(media: HTMLMediaElement): void {
  const m = media as PitchMedia
  m.preservesPitch = true
  if ('webkitPreservesPitch' in m) m.webkitPreservesPitch = true
  if ('mozPreservesPitch' in m) m.mozPreservesPitch = true
}

function waitForMetadata(media: HTMLMediaElement, signal?: AbortSignal): Promise<void> {
  if (media.readyState >= 1) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const done = (): void => {
      media.removeEventListener('loadedmetadata', onOk)
      media.removeEventListener('error', onErr)
      signal?.removeEventListener('abort', onAbort)
    }
    const onOk = (): void => {
      done()
      resolve()
    }
    const onErr = (): void => {
      done()
      reject(new Error(`The browser could not play this audio (${media.error?.message || `code ${media.error?.code ?? '?'}`})`))
    }
    const onAbort = (): void => {
      done()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    media.addEventListener('loadedmetadata', onOk)
    media.addEventListener('error', onErr)
    signal?.addEventListener('abort', onAbort)
  })
}

export interface TeachLoop {
  /** Where each pass starts (song s; the count-in). */
  start: number
  /** Where a pass ends (song s); playback jumps back to `start` (looping) or stops here. */
  end: number
}

/**
 * The song on an <audio> element at 0.5x / 0.75x / 1x, pitch preserved, with an A-B loop.
 * Call update() every animation frame: it keeps the smoother in step with the element and
 * performs the loop jump (returning what happened).
 */
export class TeachClock {
  readonly media: HTMLAudioElement
  /** Extra output latency (s, real time) to subtract; see the header. */
  outputLatencySec = 0

  private readonly now: () => number
  private readonly smoother = new MediaTimeSmoother()
  private objectUrl: string | null = null
  private key: string | null = null
  private rateValue: TeachRate = 1
  private region: TeachLoop | null = null
  private looping = true
  private epochMs = Number.NEGATIVE_INFINITY
  private wasRunning = false
  private passes = 0

  constructor(media?: HTMLAudioElement, now: () => number = () => performance.now()) {
    this.media = media ?? new Audio()
    this.now = now
    this.media.preload = 'auto'
    preservePitch(this.media)
    const resync = (): void => this.resync()
    for (const ev of ['playing', 'pause', 'seeking', 'seeked', 'waiting', 'ratechange', 'ended'] as const) this.media.addEventListener(ev, resync)
  }

  get rate(): TeachRate {
    return this.rateValue
  }

  get playing(): boolean {
    return !this.media.paused
  }

  get durationSec(): number {
    const d = this.media.duration
    return Number.isFinite(d) ? d : 0
  }

  get loopRegion(): TeachLoop | null {
    return this.region
  }

  get isLooping(): boolean {
    return this.looping
  }

  /** Completed loop jumps since the last setLoop / seek. */
  get loopPasses(): number {
    return this.passes
  }

  /**
   * Fetches the audio (same-origin path such as analysis.audioUrl) into a blob URL, so seeking
   * never depends on HTTP range support. Cached by key. Resolves the duration (s).
   */
  async load(key: string, url: string, signal?: AbortSignal): Promise<number> {
    if (this.key === key && this.objectUrl) return this.durationSec
    const bytes = await fetchAudio(url, signal)
    signal?.throwIfAborted()
    this.releaseUrl()
    this.objectUrl = URL.createObjectURL(new Blob([bytes]))
    this.key = key
    this.media.src = this.objectUrl
    await waitForMetadata(this.media, signal)
    this.media.playbackRate = this.rateValue
    preservePitch(this.media)
    this.resync()
    return this.durationSec
  }

  /** Starts / resumes (call from a click or key handler the first time: autoplay policy). */
  play(): Promise<void> {
    preservePitch(this.media)
    this.media.playbackRate = this.rateValue
    const p = this.media.play()
    this.resync()
    return p
  }

  pause(): void {
    this.media.pause()
    this.resync()
  }

  seek(t: number): void {
    const d = this.durationSec
    this.media.currentTime = Math.max(0, d > 0 ? Math.min(t, d - 0.01) : t)
    this.epochMs = this.now()
    this.resync(true)
  }

  setRate(rate: TeachRate): void {
    this.rateValue = rate
    preservePitch(this.media)
    this.media.playbackRate = rate
    this.resync(true)
  }

  /** Loop region [start - preRollSec, end] (start clamped to >= 0). */
  setLoop(start: number, end: number, preRollSec = 0): void {
    this.region = { start: Math.max(0, start - Math.max(0, preRollSec)), end }
    this.passes = 0
  }

  clearLoop(): void {
    this.region = null
  }

  setLooping(on: boolean): void {
    this.looping = on
  }

  /** Audible song time (s). */
  songTime(): number {
    const t = this.smoother.sample(this.media.currentTime, this.now())
    return audibleMediaTime(t, this.outputLatencySec, this.rateValue)
  }

  /** SongTimeAt for the webcam: rate-aware, NaN for frames from before the last seek / loop jump. */
  readonly songTimeAt: SongTimeAt = (perfMs) => {
    const now = this.now()
    return songTimeAtPerf(this.songTime(), now, perfMs, this.smoother.isRunning ? this.rateValue : 0, this.epochMs)
  }

  /** Every animation frame: keeps the smoother in step and performs the loop jump / stop. */
  update(): LoopAction {
    this.resync()
    const region = this.region
    if (!region || (!this.playing && !this.media.ended)) return 'none'
    const action = loopAction(this.songTime(), region.end, this.looping, this.media.ended)
    if (action === 'wrap') {
      this.seek(region.start)
      this.passes++
      if (this.media.paused) void this.media.play().catch(() => undefined)
    } else if (action === 'stop') {
      this.media.pause()
      this.seek(region.start)
    }
    return action
  }

  /** Stops and releases the audio. The clock stays usable (load() again; StrictMode remounts). */
  dispose(): void {
    this.media.pause()
    this.media.removeAttribute('src')
    this.media.load()
    this.releaseUrl()
    this.key = null
  }

  private releaseUrl(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
  }

  /** Re-anchors the smoother when the element's running state changed (or `force`). */
  private resync(force = false): void {
    const m = this.media
    const running = !m.paused && !m.seeking && !m.ended && m.readyState >= 3
    if (!force && running === this.wasRunning && this.smoother.currentRate === this.rateValue) return
    this.wasRunning = running
    this.smoother.reset(m.currentTime, this.now(), this.rateValue, running)
  }
}
