// Game playback clock: one decoded song on the AudioContext clock. The play screen reads
// songTime() every animation frame; nothing here (or there) uses timers or accumulated dt.
//
// Song time t is audible when ctx time is startAt + t. play(from) schedules the source so
// that song time `from` sounds START_DELAY_SEC after the call; a negative `from` is a
// silent lead-in (the 3-2-1 count-in before song time 0).

import { fetchAudio } from '../api'
import { outputLatencySec } from '../audio/clock'
import { scheduleClicks, type ClickTrack } from '../audio/metronome'
import { errorMessage } from '../lib/errors'

/** Scheduling headroom: the first sample is never late, even on a busy main thread. */
export const START_DELAY_SEC = 0.15

/** Where the song's bytes come from: a same-origin URL (analysis.audioUrl) or a local file. */
export type AudioSource = { url: string } | { file: Blob }

export interface OutputTimestampLike {
  contextTime?: number
  performanceTime?: number
}

/**
 * Audible song time from raw clock values (pure): ctx time minus output latency, relative to
 * startAt, never below `floor` (the run's start position, so a resume or count-in holds still
 * during the start delay instead of jumping back) and never past `duration`.
 */
export function audibleSongTime(currentTime: number, latencySec: number, startAt: number, floor: number, duration: number): number {
  const t = currentTime - latencySec - startAt
  return Math.min(Math.max(floor, t), Math.max(floor, duration))
}

interface Run {
  source: AudioBufferSourceNode
  /** Context time of song time 0. */
  startAt: number
  /** Song time this run started from (songTime() never goes below it). */
  floor: number
  clicks: ClickTrack | null
}

const COUNT_IN_CLICK = { frequency: 1500, volume: 0.18 }

export class GameClock {
  private ctx: AudioContext | null = null
  private song: { key: string; buffer: AudioBuffer } | null = null
  private run: Run | null = null
  private position = 0
  private countIn: readonly number[] = []
  private onEnded: (() => void) | null = null
  /** The song's volume (ducked while the herald speaks); one per AudioContext. */
  private music: GainNode | null = null

  /**
   * Creates (or resumes) the AudioContext. Call it synchronously inside a click/key handler
   * so the autoplay policy lets audio start later, after async loading.
   */
  unlock(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext({ latencyHint: 'interactive' })
    const ctx = this.ctx
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined)
    return ctx
  }

  get context(): AudioContext | null {
    return this.ctx
  }

  get loadedKey(): string | null {
    return this.song?.key ?? null
  }

  get durationSec(): number {
    return this.song?.buffer.duration ?? 0
  }

  get playing(): boolean {
    return this.run !== null
  }

  /** Context time of song time 0 for the current run, null when not playing. */
  get startAt(): number | null {
    return this.run?.startAt ?? null
  }

  setOnEnded(cb: (() => void) | null): void {
    this.onEnded = cb
  }

  /**
   * Fetches + decodes a song (cached by `key`: loading the same key again is instant).
   * Resolves the decoded duration in seconds.
   */
  async load(key: string, src: AudioSource, signal?: AbortSignal): Promise<number> {
    if (this.song?.key === key) return this.song.buffer.duration
    const ctx = this.unlock()
    const bytes = 'file' in src ? await src.file.arrayBuffer() : await fetchAudio(src.url, signal)
    signal?.throwIfAborted()
    let buffer: AudioBuffer
    try {
      buffer = await ctx.decodeAudioData(bytes)
    } catch (err) {
      throw new Error(`The browser could not decode this audio (${errorMessage(err)})`, { cause: err })
    }
    signal?.throwIfAborted()
    if (this.ctx !== ctx) throw new DOMException('Clock disposed', 'AbortError')
    this.stop()
    this.song = { key, buffer } // one song's PCM at a time
    return buffer.duration
  }

  /**
   * Plays from song time `from` (negative = silent lead-in), audible START_DELAY_SEC from now.
   * `countIn`: song times < 0 that get a soft click (the count-in beats before the music).
   */
  play(from: number, countIn: readonly number[] = []): void {
    const song = this.song
    if (!song) throw new Error('No song loaded')
    const ctx = this.unlock()
    this.stopRun()
    this.countIn = countIn
    const dur = song.buffer.duration
    const t = Math.min(from, Math.max(0, dur - 0.05))
    const base = ctx.currentTime + START_DELAY_SEC
    const startAt = base - t
    const source = ctx.createBufferSource()
    source.buffer = song.buffer
    if (this.music?.context !== ctx) {
      this.music = ctx.createGain()
      this.music.connect(ctx.destination)
    }
    source.connect(this.music)
    if (t >= 0) source.start(base, t)
    else source.start(startAt, 0)
    const ticks = countIn.filter((c) => c >= t && c < 0)
    const clicks = ticks.length > 0 ? scheduleClicks(ctx, ticks, startAt, COUNT_IN_CLICK) : null
    const run: Run = { source, startAt, floor: t, clicks }
    source.onended = () => {
      if (this.run !== run) return
      this.stopRun()
      this.position = dur
      this.onEnded?.()
    }
    this.run = run
    this.position = t
  }

  /** Freezes song time at what is audible now and silences the song. */
  pause(): void {
    if (!this.run) return
    this.position = this.songTime()
    this.stopRun()
  }

  /** Continues from the paused position. */
  resume(): void {
    if (this.run || !this.song) return
    this.play(this.position, this.countIn)
  }

  seek(t: number): void {
    if (this.run) this.play(t, this.countIn)
    else this.position = t
  }

  /** Lowers the music while the herald speaks (voice/voice.ts setVoiceDucker), back up after. */
  duck(on: boolean): void {
    if (this.ctx && this.music) this.music.gain.setTargetAtTime(on ? 0.35 : 1, this.ctx.currentTime, on ? 0.04 : 0.25)
  }

  /** Stops playback; song time goes back to 0. The decoded song stays cached. */
  stop(): void {
    this.stopRun()
    this.position = 0
  }

  /**
   * AUDIBLE song time in seconds: ctx.currentTime minus the reported output latency, relative
   * to the run's start (negative during a count-in). Frozen while paused or stopped.
   */
  songTime(): number {
    const run = this.run
    const ctx = this.ctx
    if (!run || !ctx) return this.position
    return audibleSongTime(ctx.currentTime, outputLatencySec(ctx), run.startAt, run.floor, this.durationSec)
  }

  /** AudioContext.getOutputTimestamp() (null when unsupported / no context). */
  outputTimestamp(): OutputTimestampLike | null {
    const ctx = this.ctx
    if (!ctx || typeof ctx.getOutputTimestamp !== 'function') return null
    return ctx.getOutputTimestamp()
  }

  /** Reported output latency (base + output), ms; 0 without a context. */
  outputLatencyMs(): number {
    return this.ctx ? outputLatencySec(this.ctx) * 1000 : 0
  }

  /** Stops audio, drops the decoded song and closes the AudioContext. The clock stays usable. */
  dispose(): void {
    this.stopRun()
    this.onEnded = null
    this.song = null
    this.position = 0
    const ctx = this.ctx
    this.ctx = null
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => undefined)
  }

  private stopRun(): void {
    const run = this.run
    this.run = null
    if (!run) return
    run.source.onended = null
    try {
      run.source.stop()
    } catch {
      // Not started yet / already stopped: disconnecting silences it anyway.
    }
    run.source.disconnect()
    run.clicks?.stop()
  }
}
