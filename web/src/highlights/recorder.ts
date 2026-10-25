// Records a scored round for the highlight reel: the stage canvas, scaled into a small offscreen
// canvas with the player's webcam as a picture-in-picture, encoded by MediaRecorder (~1.5 Mbps,
// WebM on Chrome/Firefox, MP4 on Safari). Runs on its own requestAnimationFrame at <= 30 fps (one
// drawImage of the stage + one of the camera; encoding is off the main thread), so the game loop
// never waits on it. While the song plays it samples (songTime, recordingTime), so at the end the
// highlight windows (song time, windows.ts) land on the right seconds of the recording.
// Unsupported browser, recorder error or an exhausted byte budget: no reel (or a shorter one),
// never an exception into the game.

import type { Move } from '@shared/routine'
import type { CheckpointResult } from '../game/scoring'
import { bitrateFor, pickHighlights, pickMimeType, recordingSize, TimeMap } from './windows'

export interface ReelClip {
  /** Recording time (s). */
  start: number
  end: number
  /** Song time (s). */
  songStart: number
  songEnd: number
  combo: number
  /** Holds the round's best streak. */
  best: boolean
  /** "12x combo!" */
  label: string
  /** Move names danced in the clip, in order. */
  moves: string[]
}

export interface HighlightRecording {
  blob: Blob
  /** Object URL of blob; revoked by HighlightRecorder.dispose(). */
  url: string
  mimeType: string
  fileName: string
  durationSec: number
  clips: ReelClip[]
}

export interface RecorderOptions {
  /** The stage canvas (PlayStage's canvas.play-canvas). */
  canvas: HTMLCanvasElement | null
  /** The webcam <video> (null for the bot: the canvas alone is recorded). */
  video?: HTMLVideoElement | null
  clock: { songTime(): number; readonly playing: boolean }
  /** Song length (s): sizes the bitrate so the whole round fits maxBytes. */
  durationSec: number
  /** Song title, for the download's file name. */
  title?: string
  maxBytes?: number
}

export const MAX_RECORDING_BYTES = 60 * 1024 * 1024
const FPS = 30
/** Shorter clips (cut by the recording's end) are dropped. */
const MIN_CLIP_SEC = 1

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)

export class HighlightRecorder {
  /** A running recorder, or null when this browser can't record a canvas. */
  static start(o: RecorderOptions): HighlightRecorder | null {
    if (!o.canvas || typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t))
    if (!mimeType) return null
    try {
      return new HighlightRecorder(o, o.canvas, mimeType)
    } catch (err) {
      console.warn('[highlights] recording unavailable:', err)
      return null
    }
  }

  private readonly src: HTMLCanvasElement
  private readonly video: HTMLVideoElement | null
  private readonly clock: RecorderOptions['clock']
  private readonly out: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly stream: MediaStream
  private readonly recorder: MediaRecorder
  private readonly chunks: Blob[] = []
  private readonly map = new TimeMap()
  private readonly maxBytes: number
  private readonly fileName: string
  private readonly t0: number
  private bytes = 0
  private raf = 0
  private lastDraw = Number.NEGATIVE_INFINITY
  private endedAt: number | null = null
  private failed = false
  private disposed = false
  private url: string | null = null
  private readonly stopped: Promise<void>

  private constructor(o: RecorderOptions, canvas: HTMLCanvasElement, mimeType: string) {
    this.src = canvas
    this.video = o.video ?? null
    this.clock = o.clock
    this.maxBytes = o.maxBytes ?? MAX_RECORDING_BYTES
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
    this.fileName = `dance-fantasy-${slug(o.title ?? '') || 'highlights'}.${ext}`
    const { width, height } = recordingSize(canvas.clientWidth / canvas.clientHeight)
    this.out = document.createElement('canvas')
    this.out.width = width
    this.out.height = height
    const ctx = this.out.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('no 2D context for the recording canvas')
    this.ctx = ctx
    this.draw()
    this.stream = this.out.captureStream(FPS)
    this.recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: bitrateFor(o.durationSec, this.maxBytes) })
    this.stopped = new Promise((resolve) => this.recorder.addEventListener('stop', () => resolve(), { once: true }))
    this.recorder.ondataavailable = (e) => {
      if (e.data.size === 0 || this.disposed) return
      this.chunks.push(e.data)
      this.bytes += e.data.size
      if (this.bytes > this.maxBytes) this.end() // ponytail: budget hit = the reel stops here; later moments are lost
    }
    this.recorder.onerror = (e) => {
      console.warn('[highlights] recorder error:', e)
      this.failed = true
      this.end()
    }
    this.recorder.start(1000)
    this.t0 = performance.now()
    this.raf = requestAnimationFrame(this.loop)
  }

  private readonly loop = (): void => {
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now()
    if (now - this.lastDraw < 1000 / FPS - 4) return
    this.lastDraw = now
    this.draw()
    if (this.clock.playing) this.map.push(this.clock.songTime(), (now - this.t0) / 1000)
  }

  /** Stage letterboxed into the recording; webcam inset top-left, where the stage's HTML top bar
   *  (not in the canvas) leaves room; mirrored, like the stage. */
  private draw(): void {
    const { ctx, out, src } = this
    const W = out.width
    const H = out.height
    ctx.fillStyle = '#152338'
    ctx.fillRect(0, 0, W, H)
    if (src.width > 0 && src.height > 0) {
      const s = Math.min(W / src.width, H / src.height)
      const w = src.width * s
      const h = src.height * s
      ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h)
    }
    const v = this.video
    if (!v || v.readyState < 2 || v.videoWidth === 0) return
    const bw = Math.round(Math.min(W, H) * (W >= H ? 0.34 : 0.45))
    const bh = Math.round((bw * v.videoHeight) / v.videoWidth)
    const x = Math.round(Math.min(W, H) * 0.035)
    const y = x
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, y, bw, bh, 10)
    ctx.clip()
    ctx.translate(x + bw, y)
    ctx.scale(-1, 1)
    ctx.drawImage(v, 0, 0, bw, bh)
    ctx.restore()
    ctx.lineWidth = 4
    ctx.strokeStyle = '#dbb35e'
    ctx.beginPath()
    ctx.roundRect(x, y, bw, bh, 10)
    ctx.stroke()
  }

  /** Stops drawing and recording (idempotent); the recording ends at this moment. */
  private end(): void {
    cancelAnimationFrame(this.raf)
    if (this.endedAt === null) this.endedAt = performance.now()
    if (this.recorder.state !== 'inactive') this.recorder.stop()
    for (const t of this.stream.getTracks()) t.stop()
  }

  /**
   * Ends the recording and picks the reel from the round's judged checkpoints. Null when the
   * recording failed, nothing is worth replaying, or dispose() came first.
   */
  async stop(results: readonly CheckpointResult[], moves: readonly Pick<Move, 'name'>[]): Promise<HighlightRecording | null> {
    if (this.disposed) return null
    this.end()
    await this.stopped
    if (this.disposed || this.failed || this.chunks.length === 0) return null
    const durationSec = ((this.endedAt ?? performance.now()) - this.t0) / 1000
    const clips: ReelClip[] = []
    for (const w of pickHighlights(results)) {
      const start = Math.max(0, this.map.recTimeAt(w.start) ?? 0)
      const end = Math.min(durationSec, this.map.recTimeAt(w.end) ?? 0)
      if (end - start < MIN_CLIP_SEC) continue
      const names = w.moveIndices.map((i) => moves[i]?.name).filter((n): n is string => !!n)
      clips.push({
        start,
        end,
        songStart: w.start,
        songEnd: w.end,
        combo: w.combo,
        best: w.best,
        label: `${w.combo}x combo!`,
        moves: names.filter((n, i) => names.indexOf(n) === i),
      })
    }
    if (clips.length === 0) return null
    const mimeType = this.recorder.mimeType || (this.fileName.endsWith('mp4') ? 'video/mp4' : 'video/webm')
    const blob = new Blob(this.chunks, { type: mimeType })
    this.url = URL.createObjectURL(blob)
    return { blob, url: this.url, mimeType, fileName: this.fileName, durationSec, clips }
  }

  /** Stops everything and revokes the recording's URL (a pending stop() resolves null). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.end()
    this.chunks.length = 0
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
  }
}
