// Seekable song playback on the AudioContext clock, with an optional metronome that
// accents downbeats. Song time comes only from songTime(clock); never from timers.

import { errorMessage } from '../lib/errors'
import { songTime, type SongClock } from './clock'
import { scheduleClicks, type ClickTrack } from './metronome'

export interface PlayerSong {
  /** Cache key for the decoded buffer (the analysis id). */
  key: string
  loadBytes: (signal: AbortSignal) => Promise<ArrayBuffer>
  /** Beat times (seconds) and which of them are downbeats, for the metronome. */
  beats: readonly number[]
  isDownbeat: (beatIndex: number) => boolean
  /** Fallback duration until the audio is decoded. */
  durationSec: number
}

interface Run {
  clock: SongClock
  source: AudioBufferSourceNode
  clicks: ClickTrack[]
  /** Song time where this run started (the displayed time never goes below it). */
  offset: number
}

const START_DELAY_SEC = 0.06
const BEAT_CLICK = { frequency: 1000, volume: 0.25 }
const DOWNBEAT_CLICK = { frequency: 1760, volume: 0.42 }

export class SongPlayer {
  private onEnded: (() => void) | null = null
  private ctx: AudioContext | null = null
  private song: PlayerSong | null = null
  private decoded: { key: string; buffer: AudioBuffer } | null = null
  private run: Run | null = null
  private position = 0
  private metronome = true
  private token = 0
  private loading: { key: string; promise: Promise<AudioBuffer>; abort: AbortController } | null = null

  get playing(): boolean {
    return this.run !== null
  }

  get durationSec(): number {
    const b = this.decoded && this.decoded.key === this.song?.key ? this.decoded.buffer.duration : 0
    return Math.max(b, this.song?.durationSec ?? 0)
  }

  /** Current song position in seconds (raw audio clock while playing). */
  currentTime(): number {
    const run = this.run
    if (!run) return this.position
    return Math.min(this.durationSec, Math.max(run.offset, songTime(run.clock)))
  }

  /** Called when playback reaches the end of the song on its own. */
  setOnEnded(cb: (() => void) | null): void {
    this.onEnded = cb
  }

  setSong(song: PlayerSong | null): void {
    this.cancel()
    this.song = song
    this.position = 0
    if (this.decoded && this.decoded.key !== song?.key) this.decoded = null // keep one song's PCM only
  }

  /**
   * Plays from `from` (default: the current position). Call it from a click handler: the
   * AudioContext is created/resumed synchronously (autoplay policy). Resolves true once
   * audio is scheduled, false if superseded by another play/pause/seek/setSong.
   */
  async play(from?: number): Promise<boolean> {
    const song = this.song
    if (!song) return false
    const ctx = this.ensureContext()
    const resumed = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve()
    if (from !== undefined) this.position = from
    if (this.position >= this.durationSec - 0.05) this.position = 0
    this.stopRun()
    const token = ++this.token
    let buffer: AudioBuffer
    try {
      buffer = await this.load(ctx, song)
      await resumed
    } catch (err) {
      if (token !== this.token) return false // superseded: aborted loads end up here
      throw err
    }
    if (token !== this.token || this.song !== song) return false
    this.startRun(ctx, buffer, song, this.position)
    return true
  }

  pause(): void {
    this.position = this.currentTime()
    this.cancel()
  }

  /** Jumps to `t`; keeps playing if playing (a pending play() starts there too). */
  seek(t: number): void {
    const dur = this.durationSec
    this.position = Math.min(Math.max(0, t), dur > 0 ? dur : Math.max(0, t))
    const run = this.run
    const song = this.song
    if (run && song && this.decoded) {
      this.stopRun()
      this.startRun(run.clock.ctx, this.decoded.buffer, song, this.position)
    }
  }

  setMetronome(on: boolean): void {
    this.metronome = on
    for (const c of this.run?.clicks ?? []) c.setEnabled(on)
  }

  /** Song clock of the current run (for latency readouts etc.), null when paused. */
  get clock(): SongClock | null {
    return this.run?.clock ?? null
  }

  dispose(): void {
    this.cancel()
    this.onEnded = null
    this.song = null
    this.decoded = null
    const ctx = this.ctx
    this.ctx = null
    if (ctx && ctx.state !== 'closed') void ctx.close()
  }

  // --- internals ---------------------------------------------------------------------

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext({ latencyHint: 'interactive' })
    return this.ctx
  }

  /** Stops audio and invalidates any pending play(). */
  private cancel(): void {
    this.token++
    this.loading?.abort.abort()
    this.loading = null
    this.stopRun()
  }

  /** Fetches + decodes the song once; concurrent play() calls share the same load. */
  private load(ctx: AudioContext, song: PlayerSong): Promise<AudioBuffer> {
    if (this.decoded?.key === song.key) return Promise.resolve(this.decoded.buffer)
    if (this.loading?.key === song.key) return this.loading.promise
    const abort = new AbortController()
    const promise = (async () => {
      const bytes = await song.loadBytes(abort.signal)
      let buffer: AudioBuffer
      try {
        buffer = await ctx.decodeAudioData(bytes)
      } catch (err) {
        throw new Error(`The browser could not decode this audio (${errorMessage(err)})`, { cause: err })
      }
      if (this.song === song) this.decoded = { key: song.key, buffer }
      return buffer
    })()
    const entry = { key: song.key, promise, abort }
    this.loading = entry
    const clear = (): void => {
      if (this.loading === entry) this.loading = null
    }
    promise.then(clear, clear)
    return promise
  }

  private startRun(ctx: AudioContext, buffer: AudioBuffer, song: PlayerSong, offset: number): void {
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    const when = ctx.currentTime + START_DELAY_SEC
    const startAt = when - offset
    source.start(when, offset)

    // Only beats from the start point on (earlier ones would click during the start delay).
    const beatTimes: number[] = []
    const downbeatTimes: number[] = []
    song.beats.forEach((t, i) => {
      if (t >= offset - 0.005) (song.isDownbeat(i) ? downbeatTimes : beatTimes).push(t)
    })
    const enabled = this.metronome
    const clicks = [
      scheduleClicks(ctx, beatTimes, startAt, { enabled, ...BEAT_CLICK }),
      scheduleClicks(ctx, downbeatTimes, startAt, { enabled, ...DOWNBEAT_CLICK }),
    ]

    const run: Run = { clock: { ctx, startAt, compensateLatency: false }, source, clicks, offset }
    source.onended = () => {
      if (this.run !== run) return
      this.stopRun()
      this.position = 0
      this.onEnded?.()
    }
    this.run = run
  }

  private stopRun(): void {
    const run = this.run
    this.run = null
    if (!run) return
    run.source.onended = null
    try {
      run.source.stop()
    } catch {
      // Already stopped; disconnecting silences it anyway.
    }
    run.source.disconnect()
    for (const c of run.clicks) c.stop()
  }
}
