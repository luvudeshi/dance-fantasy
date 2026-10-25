// The webcam PoseSource: camera -> MediaPipe PoseLandmarker (in the browser) -> PlayerFrame on
// the song clock. Frames and poses never leave the browser: the stream only feeds a local
// <video> and the in-page model.
//
// Timing: every video frame is stamped with its capture time (requestVideoFrameCallback
// metadata, performance.now() timebase), mapped onto the song clock with songTimeAt, minus the
// calibrated camera/model latency. Scoring compares that with beat times.

import type { Delegate, PoseModel } from '../pose/mediapipeAssets'
import { abortReason, errorMessage } from '../lib/errors'
import { createPoseLandmarker } from '../pose/mediapipe'
import { landmarksToPlayerPose, type LandmarkLike } from '../pose/normalize'
import { startWebcam, stopWebcam } from '../pose/webcam'
import type { PlayerFrame, PoseSource, SongTimeAt } from './poseSource'

/** The parts of MediaPipe's PoseLandmarker this module uses (a fake in tests). */
export interface LandmarkerLike {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): { landmarks: LandmarkLike[][] }
  close(): void
}

export interface LandmarkerHandleLike {
  landmarker: LandmarkerLike
  delegate: Delegate
}

export interface WebcamDeps {
  startWebcam: (video: HTMLVideoElement, opts: { width?: number; height?: number; signal?: AbortSignal }) => Promise<MediaStream>
  stopWebcam: (stream: MediaStream | null, video?: HTMLVideoElement | null) => void
  createPoseLandmarker: (opts: { model?: PoseModel; delegate?: Delegate; signal?: AbortSignal }) => Promise<LandmarkerHandleLike>
  now: () => number
  requestAnimationFrame: (cb: FrameRequestCallback) => number
  cancelAnimationFrame: (handle: number) => void
}

export interface WebcamPoseSourceOptions {
  songTimeAt: SongTimeAt
  /** Camera + model latency (s) subtracted from frame times. */
  latencySec: number
  model?: PoseModel
  delegate?: Delegate
  /** Defaults to a new detached <video>. */
  video?: HTMLVideoElement
  /** Test seams; real modules by default. */
  deps?: Partial<WebcamDeps>
}

export type WebcamStatus = 'idle' | 'starting' | 'running' | 'error'

/** Without a requestVideoFrameCallback for this long, poll the video from rAF instead. */
const VFC_STALE_MS = 400
/** Capture timestamps further than this from now are bogus; use now. */
const MAX_CAPTURE_SKEW_MS = 1000

const defaultDeps = (): WebcamDeps => ({
  startWebcam,
  stopWebcam,
  createPoseLandmarker,
  now: () => performance.now(),
  requestAnimationFrame: (cb) => requestAnimationFrame(cb),
  cancelAnimationFrame: (h) => cancelAnimationFrame(h),
})

/**
 * performance.now() time (ms) at which a video frame was captured: metadata.captureTime ??
 * metadata.expectedDisplayTime ?? now, falling back to now when the value is implausible.
 */
export function captureTimeMs(meta: { captureTime?: number; expectedDisplayTime?: number } | null, nowMs: number): number {
  const t = meta?.captureTime ?? meta?.expectedDisplayTime
  return t !== undefined && Number.isFinite(t) && Math.abs(nowMs - t) <= MAX_CAPTURE_SKEW_MS ? t : nowMs
}

/** MediaPipe needs strictly increasing timestamps. */
export function nextTimestamp(wantedMs: number, lastMs: number): number {
  return Math.max(wantedMs, lastMs + 1)
}

/** One detection result -> PlayerFrame on the song clock. */
export function buildPlayerFrame(
  landmarks: readonly LandmarkLike[] | undefined,
  videoWidth: number,
  videoHeight: number,
  captureMs: number,
  songTimeAt: SongTimeAt,
  latencySec: number,
): PlayerFrame {
  const rawSongTime = songTimeAt(captureMs)
  const base = { songTime: rawSongTime - latencySec, rawSongTime, captureMs, videoWidth, videoHeight }
  if (!landmarks) return { ...base, pose: {}, visibility: {}, valid: false }
  const p = landmarksToPlayerPose(landmarks, videoWidth, videoHeight)
  return { ...base, pose: p.pose, visibility: p.visibility, valid: p.valid, image: p.image }
}

/**
 * SongTimeAt for a clock exposing the AUDIBLE song time now (GameClock.songTime()): the song
 * time `perfMs` was audible = now's song time minus the time elapsed since. Frozen (constant)
 * while the clock is paused or stopped.
 */
export function songTimeAtFromClock(clock: { songTime(): number }, now: () => number = () => performance.now()): SongTimeAt {
  return (perfMs) => clock.songTime() - (now() - perfMs) / 1000
}

interface Run {
  ac: AbortController
  promise: Promise<void>
  stream: MediaStream | null
  handle: LandmarkerHandleLike | null
  live: boolean
  vfc: number | null
  raf: number | null
  lastTs: number
  lastVfcMs: number
  lastVideoTime: number
  /** GPU detection failed once and a CPU landmarker is being / was created. */
  cpuFallback: boolean
  failed: boolean
  cleanup: Array<() => void>
}

export class WebcamPoseSource implements PoseSource {
  readonly kind = 'webcam' as const
  readonly video: HTMLVideoElement
  private songTimeAt: SongTimeAt
  private latency: number
  private readonly model: PoseModel
  private readonly delegate: Delegate
  private readonly deps: WebcamDeps
  private readonly frameListeners = new Set<(f: PlayerFrame) => void>()
  private readonly errorListeners = new Set<(message: string) => void>()
  private last: PlayerFrame | null = null
  private run: Run | null = null
  private lastError: string | null = null
  /** Tiny on-page parking spot for the <video> while no screen shows it (see parkVideo). */
  private holder: HTMLElement | null = null

  constructor(opts: WebcamPoseSourceOptions) {
    this.songTimeAt = opts.songTimeAt
    this.latency = Number.isFinite(opts.latencySec) ? opts.latencySec : 0
    this.model = opts.model ?? 'lite'
    this.delegate = opts.delegate ?? 'GPU'
    this.deps = { ...defaultDeps(), ...opts.deps }
    this.video = opts.video ?? document.createElement('video')
    this.video.muted = true
    this.video.playsInline = true
  }

  get latencySec(): number {
    return this.latency
  }

  setLatency(sec: number): void {
    if (Number.isFinite(sec)) this.latency = sec
  }

  /** Swap the song-clock mapping (e.g. a new GameClock). */
  setSongTimeAt(fn: SongTimeAt): void {
    this.songTimeAt = fn
  }

  get status(): WebcamStatus {
    if (this.run) return this.run.live ? 'running' : 'starting'
    return this.lastError ? 'error' : 'idle'
  }

  /** Last user-facing error (start failure, camera unplugged, detection failure). */
  get error(): string | null {
    return this.lastError
  }

  /** The delegate actually detecting (null until running). */
  get activeDelegate(): Delegate | null {
    return this.run?.handle?.delegate ?? null
  }

  /**
   * Opens the camera and loads the model (in parallel), then detects on every new video frame.
   * Idempotent while starting/running. Rejects with a user-facing Error, or an AbortError when
   * stop() interrupted it (callers ignore those: lib/errors isAbortError).
   */
  start(): Promise<void> {
    if (this.run) return this.run.promise
    const run: Run = {
      ac: new AbortController(),
      promise: Promise.resolve(),
      stream: null,
      handle: null,
      live: false,
      vfc: null,
      raf: null,
      lastTs: -Infinity,
      lastVfcMs: 0,
      lastVideoTime: -1,
      cpuFallback: false,
      failed: false,
      cleanup: [],
    }
    this.run = run
    this.lastError = null
    this.parkVideo()
    run.promise = this.boot(run)
    return run.promise
  }

  /** Releases the camera, closes the model, cancels the loop. Safe to call any number of times. */
  stop(): void {
    const run = this.run
    this.run = null
    if (!run) return
    run.ac.abort()
    this.release(run)
    if (this.holder && this.video.parentNode === this.holder) this.holder.remove()
  }

  onFrame(cb: (frame: PlayerFrame) => void): () => void {
    this.frameListeners.add(cb)
    return () => {
      this.frameListeners.delete(cb)
    }
  }

  /** Runtime errors after start() resolved (camera lost, detection failed). */
  onError(cb: (message: string) => void): () => void {
    this.errorListeners.add(cb)
    return () => {
      this.errorListeners.delete(cb)
    }
  }

  latest(): PlayerFrame | null {
    return this.last
  }

  // --- internals -------------------------------------------------------------------------

  /**
   * Keeps the <video> in the document while it runs: a detached element may get paused or stop
   * firing requestVideoFrameCallback (then frames would fall back to rAF timing, which differs
   * from what calibration measured). Screens that show it (CalibrationScreen) move it into their
   * own box and put it back here afterwards; drawImage-based views just read it.
   */
  private parkVideo(): void {
    if (this.video.isConnected || typeof document === 'undefined' || !document.body) return
    if (!this.holder) {
      const holder = document.createElement('div')
      holder.setAttribute('aria-hidden', 'true')
      holder.style.cssText =
        'position:fixed;left:0;bottom:0;width:4px;height:3px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1'
      this.holder = holder
    }
    this.holder.appendChild(this.video)
    document.body.appendChild(this.holder)
  }

  private async boot(run: Run): Promise<void> {
    const { signal } = run.ac
    const [cam, model] = await Promise.allSettled([
      this.deps.startWebcam(this.video, { width: 640, height: 480, signal }),
      this.deps.createPoseLandmarker({ model: this.model, delegate: this.delegate, signal }),
    ])
    if (cam.status === 'fulfilled') run.stream = cam.value
    if (model.status === 'fulfilled') run.handle = model.value
    if (signal.aborted || cam.status === 'rejected' || model.status === 'rejected') {
      // Whatever did start is released (also when stop() ran before it arrived).
      this.release(run)
      if (this.run === run) this.run = null
      if (signal.aborted) throw abortReason(signal)
      const reason: unknown = cam.status === 'rejected' ? cam.reason : model.status === 'rejected' ? model.reason : null
      const err = reason instanceof Error ? reason : new Error(errorMessage(reason))
      this.lastError = err.message
      throw err
    }

    const track = run.stream?.getVideoTracks()[0]
    if (track) {
      const onEnded = (): void => {
        if (this.run !== run) return
        this.stop()
        this.fail('The camera stopped (unplugged, or taken by another app).')
      }
      track.addEventListener('ended', onEnded)
      run.cleanup.push(() => track.removeEventListener('ended', onEnded))
    }
    // Detaching the <video> from the DOM pauses it (HTML spec): park it again, keep it rolling.
    const onPause = (): void => {
      if (!run.live) return
      this.parkVideo()
      this.video.play().catch(() => undefined)
    }
    this.video.addEventListener('pause', onPause)
    run.cleanup.push(() => this.video.removeEventListener('pause', onPause))

    run.live = true
    this.loop(run)
  }

  private loop(run: Run): void {
    const video = this.video
    const hasVfc = typeof video.requestVideoFrameCallback === 'function'
    run.lastVfcMs = this.deps.now()
    const onVideoFrame = (now: number, meta: VideoFrameCallbackMetadata): void => {
      if (!run.live) return
      run.vfc = video.requestVideoFrameCallback(onVideoFrame)
      run.lastVfcMs = this.deps.now()
      run.lastVideoTime = video.currentTime
      this.process(run, captureTimeMs(meta, Number.isFinite(now) ? now : this.deps.now()))
    }
    // rAF fallback: browsers without requestVideoFrameCallback, or when it goes quiet.
    const onAnimationFrame = (): void => {
      if (!run.live) return
      run.raf = this.deps.requestAnimationFrame(onAnimationFrame)
      const now = this.deps.now()
      if (hasVfc && now - run.lastVfcMs < VFC_STALE_MS) return
      if (video.currentTime === run.lastVideoTime) return
      run.lastVideoTime = video.currentTime
      this.process(run, now)
    }
    if (hasVfc) run.vfc = video.requestVideoFrameCallback(onVideoFrame)
    run.raf = this.deps.requestAnimationFrame(onAnimationFrame)
  }

  private process(run: Run, captureMs: number): void {
    const handle = run.handle
    const video = this.video
    if (!handle || run.failed || !run.live) return
    if (video.readyState < 2 || !(video.videoWidth > 0) || !(video.videoHeight > 0)) return
    const ts = nextTimestamp(captureMs, run.lastTs)
    let landmarks: LandmarkLike[] | undefined
    try {
      landmarks = handle.landmarker.detectForVideo(video, ts).landmarks[0]
    } catch (err) {
      this.onDetectError(run, handle, err)
      return
    }
    run.lastTs = ts
    const frame = buildPlayerFrame(landmarks, video.videoWidth, video.videoHeight, captureMs, this.songTimeAt, this.latency)
    this.last = frame
    for (const cb of this.frameListeners) {
      try {
        cb(frame)
      } catch (err) {
        console.error('[webcam] frame listener failed', err)
      }
    }
  }

  /** GPU inference can fail at the first frame on some machines: retry once on CPU. */
  private onDetectError(run: Run, handle: LandmarkerHandleLike, err: unknown): void {
    console.error('[webcam] detectForVideo failed', err)
    run.handle = null
    handle.landmarker.close()
    if (handle.delegate !== 'GPU' || run.cpuFallback) {
      this.giveUp(run, `Pose detection failed: ${errorMessage(err)}`)
      return
    }
    run.cpuFallback = true
    this.deps.createPoseLandmarker({ model: this.model, delegate: 'CPU', signal: run.ac.signal }).then(
      (h) => {
        if (run.live && this.run === run) run.handle = h
        else h.landmarker.close()
      },
      (cpuErr: unknown) => {
        if (!run.ac.signal.aborted) this.giveUp(run, `Pose detection failed: ${errorMessage(cpuErr)}`)
      },
    )
  }

  /** Stops a broken run (so start() can retry from scratch) and reports why. */
  private giveUp(run: Run, message: string): void {
    run.failed = true
    if (this.run === run) this.stop()
    this.fail(message)
  }

  private release(run: Run): void {
    run.live = false
    if (run.vfc !== null) {
      this.video.cancelVideoFrameCallback?.(run.vfc)
      run.vfc = null
    }
    if (run.raf !== null) {
      this.deps.cancelAnimationFrame(run.raf)
      run.raf = null
    }
    for (const fn of run.cleanup.splice(0)) fn()
    const stream = run.stream
    run.stream = null
    if (stream) this.deps.stopWebcam(stream, this.video)
    const handle = run.handle
    run.handle = null
    if (handle) {
      try {
        handle.landmarker.close()
      } catch (err) {
        console.warn('[webcam] landmarker.close failed', err)
      }
    }
  }

  private fail(message: string): void {
    this.lastError = message
    for (const cb of this.errorListeners) cb(message)
  }
}
