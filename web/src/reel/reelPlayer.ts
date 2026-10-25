// Plays a highlight reel on a canvas: a title card, each clip (1x, then its best second at
// 0.5x) with overlays drawn in sync, the song audio from the clip's time range under it,
// then the awards card. The clip's video is the clock while it plays (overlays follow the
// frames actually shown); clips without video run on the wall clock.

import type { Award } from './awards'
import { drawAwardsCard, drawClipFrame, drawTitleCard, REEL_H, REEL_W } from './drawReel'
import { clipSegments, songAtVideo, videoAtSong, type Segment } from './timeline'
import type { ClipMeta } from './types'

export const TITLE_SEC = 1.5
export const AWARDS_SEC = 6
/** Re-sync the song audio when it drifts further than this (s) from the video. */
const AUDIO_DRIFT_SEC = 0.2
/** A segment never runs longer than its duration plus this (s), whatever the video does. */
const SEGMENT_SLACK_SEC = 1.5
const EVENT_TIMEOUT_MS = 2500

export interface ReelItem {
  clip: ClipMeta
  /** Object URL of the clip video, or null. */
  url: string | null
  caption: string
}

export type ReelScene = { kind: 'title' } | { kind: 'clip'; index: number; segment: Segment } | { kind: 'awards' } | { kind: 'done' }

export interface ReelPlaybackOptions {
  canvas: HTMLCanvasElement
  video: HTMLVideoElement
  audio: HTMLAudioElement | null
  items: readonly ReelItem[]
  awards: readonly Award[]
  title: string
  showPlayer: boolean
  onScene?: (s: ReelScene) => void
}

function once(target: EventTarget, type: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      target.removeEventListener(type, done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    target.addEventListener(type, done)
  })
}

/** MediaRecorder webm has no duration (Infinity) until the browser has scanned it; force that so seeking works. */
async function loadVideo(video: HTMLVideoElement, url: string): Promise<void> {
  video.src = url
  if (video.readyState < 1) await once(video, 'loadedmetadata')
  if (!Number.isFinite(video.duration)) {
    const changed = once(video, 'durationchange')
    video.currentTime = 1e7
    await changed
  }
}

async function seek(video: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(video.currentTime - t) < 0.02 && video.readyState >= 2) return
  const seeked = once(video, 'seeked')
  video.currentTime = t
  await seeked
}

type Draw = (ctx: CanvasRenderingContext2D, now: number) => void

export class ReelPlayback {
  private readonly o: ReelPlaybackOptions
  private readonly ctx: CanvasRenderingContext2D | null
  private raf = 0
  private stopped = false
  private draw: Draw | null = null
  private waiter: { until: (now: number) => boolean; resolve: () => void } | null = null

  constructor(o: ReelPlaybackOptions) {
    this.o = o
    o.canvas.width = REEL_W
    o.canvas.height = REEL_H
    this.ctx = o.canvas.getContext('2d')
    o.video.muted = true
    o.video.playsInline = true
  }

  start(): void {
    this.stopped = false
    const loop = (): void => {
      if (this.stopped) return
      const now = performance.now() / 1000
      if (this.ctx && this.draw) this.draw(this.ctx, now)
      if (this.waiter?.until(now)) {
        const w = this.waiter
        this.waiter = null
        w.resolve()
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
    void this.run()
  }

  stop(): void {
    this.stopped = true
    cancelAnimationFrame(this.raf)
    this.waiter?.resolve()
    this.waiter = null
    this.o.video.pause()
    this.o.video.removeAttribute('src')
    this.o.video.load()
    this.o.audio?.pause()
  }

  private wait(until: (now: number) => boolean): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) resolve()
      else this.waiter = { until, resolve }
    })
  }

  private scene(s: ReelScene): void {
    if (!this.stopped) this.o.onScene?.(s)
  }

  private async card(kind: 'title' | 'awards', seconds: number): Promise<void> {
    const t0 = performance.now() / 1000
    this.scene({ kind })
    this.draw =
      kind === 'title'
        ? (ctx, now) => drawTitleCard(ctx, this.o.title, (now - t0) / seconds)
        : (ctx, now) => drawAwardsCard(ctx, this.o.awards, this.o.showPlayer, (now - t0) / seconds)
    await this.wait((now) => now - t0 >= seconds)
  }

  private async run(): Promise<void> {
    const { items, video, audio } = this.o
    await this.card('title', TITLE_SEC)
    for (let i = 0; i < items.length && !this.stopped; i++) {
      const item = items[i]
      const useVideo = item.url !== null && item.clip.hasVideo
      if (useVideo) await loadVideo(video, item.url as string)
      for (const segment of clipSegments(item.clip)) {
        if (this.stopped) return
        await this.playSegment(item, i, segment, useVideo)
      }
      video.pause()
      audio?.pause()
    }
    if (this.stopped) return
    await this.card('awards', AWARDS_SEC)
    this.scene({ kind: 'done' })
  }

  private async playSegment(item: ReelItem, index: number, segment: Segment, useVideo: boolean): Promise<void> {
    const { video, audio } = this.o
    const clip = item.clip
    if (useVideo) {
      video.pause()
      await seek(video, Math.max(0, videoAtSong(clip, segment.from)))
      video.playbackRate = segment.rate
    }
    if (this.stopped) return
    if (audio) {
      audio.currentTime = Math.max(0, segment.from)
      audio.playbackRate = segment.rate
      audio.preservesPitch = false // the slow-mo drops an octave, on purpose
      void audio.play().catch(() => {})
    }
    if (useVideo) await video.play().catch(() => {})
    const t0 = performance.now() / 1000
    const songTime = (now: number): number =>
      useVideo ? Math.max(segment.from, songAtVideo(clip, video.currentTime)) : segment.from + (now - t0) * segment.rate
    this.scene({ kind: 'clip', index, segment })
    const frame = { clip, segment, caption: item.caption, index: index + 1, total: this.o.items.length, showPlayer: this.o.showPlayer }
    this.draw = (ctx, now) => {
      const s = songTime(now)
      drawClipFrame(ctx, { ...frame, video: useVideo ? video : null, songTime: Math.min(s, segment.to) })
      if (audio && !audio.paused && Math.abs(audio.currentTime - s) > AUDIO_DRIFT_SEC) audio.currentTime = Math.max(0, s)
    }
    await this.wait((now) => songTime(now) >= segment.to || (useVideo && video.ended) || now - t0 > segment.duration + SEGMENT_SLACK_SEC)
  }
}
