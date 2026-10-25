import { describe, expect, it, vi } from 'vitest'
import { JOINTS, MEDIAPIPE_INDEX } from '@shared/skeleton'
import type { LandmarkLike } from '../pose/normalize'
import type { Delegate } from '../pose/mediapipeAssets'
import {
  buildPlayerFrame,
  captureTimeMs,
  nextTimestamp,
  songTimeAtFromClock,
  WebcamPoseSource,
  type LandmarkerHandleLike,
  type WebcamDeps,
} from './webcamSource'
import type { PlayerFrame } from './poseSource'

// --- fakes -------------------------------------------------------------------------------

function landmarks(): LandmarkLike[] {
  const lms: LandmarkLike[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }))
  const place: Partial<Record<(typeof JOINTS)[number], [number, number]>> = {
    l_shoulder: [0.56, 0.25],
    r_shoulder: [0.44, 0.25],
    l_hip: [0.53, 0.52],
    r_hip: [0.47, 0.52],
    l_wrist: [0.62, 0.5],
    r_wrist: [0.38, 0.5],
  }
  for (const j of JOINTS) {
    const p = place[j]
    if (p) lms[MEDIAPIPE_INDEX[j]] = { x: p[0], y: p[1], visibility: 0.9 }
  }
  return lms
}

type VfcCb = (now: number, meta: { captureTime?: number; expectedDisplayTime: number }) => void

class FakeVideo {
  muted = false
  playsInline = false
  readyState = 4
  videoWidth = 640
  videoHeight = 480
  currentTime = 0
  srcObject: unknown = null
  vfc = new Map<number, VfcCb>()
  nextId = 1
  listeners = new Map<string, Set<() => void>>()
  plays = 0
  requestVideoFrameCallback?: (cb: VfcCb) => number = (cb) => {
    const id = this.nextId++
    this.vfc.set(id, cb)
    return id
  }
  cancelVideoFrameCallback(id: number): void {
    this.vfc.delete(id)
  }
  addEventListener(type: string, cb: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(cb)
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb)
  }
  dispatch(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb()
  }
  play(): Promise<void> {
    this.plays++
    return Promise.resolve()
  }
  /** Delivers one video frame to every pending callback. */
  frame(now: number, meta: { captureTime?: number; expectedDisplayTime: number }): void {
    const cbs = [...this.vfc.values()]
    this.vfc.clear()
    for (const cb of cbs) cb(now, meta)
  }
}

class FakeTrack {
  stopped = false
  listeners = new Set<() => void>()
  addEventListener(_type: string, cb: () => void): void {
    this.listeners.add(cb)
  }
  removeEventListener(_type: string, cb: () => void): void {
    this.listeners.delete(cb)
  }
}

function fakeStream(): { stream: MediaStream; track: FakeTrack } {
  const track = new FakeTrack()
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] }
  return { stream: stream as unknown as MediaStream, track }
}

function harness(
  opts: { failCamera?: Error; gpuDetectFails?: boolean; cpuDetectFails?: boolean; noVfc?: boolean; deferCamera?: boolean } = {},
) {
  const video = new FakeVideo()
  if (opts.noVfc) video.requestVideoFrameCallback = undefined
  const { stream, track } = fakeStream()
  const closed: Delegate[] = []
  const detectCalls: number[] = []
  let now = 1000
  const rafs = new Map<number, FrameRequestCallback>()
  let rafId = 1
  const makeHandle = (delegate: Delegate): LandmarkerHandleLike => ({
    delegate,
    landmarker: {
      detectForVideo: (_v, ts) => {
        if (delegate === 'GPU' && opts.gpuDetectFails) throw new Error('GPU lost')
        if (delegate === 'CPU' && opts.cpuDetectFails) throw new Error('wasm crashed')
        detectCalls.push(ts)
        return { landmarks: [landmarks()] }
      },
      close: () => {
        closed.push(delegate)
      },
    },
  })
  let releaseCamera: (() => void) | null = null
  const stopWebcam = vi.fn()
  const deps: WebcamDeps = {
    startWebcam: () => {
      if (opts.failCamera) return Promise.reject(opts.failCamera)
      if (opts.deferCamera) return new Promise((resolve) => (releaseCamera = () => resolve(stream)))
      return Promise.resolve(stream)
    },
    stopWebcam,
    createPoseLandmarker: (o) => Promise.resolve(makeHandle(o.delegate ?? 'GPU')),
    now: () => now,
    requestAnimationFrame: (cb) => {
      const id = rafId++
      rafs.set(id, cb)
      return id
    },
    cancelAnimationFrame: (id) => {
      rafs.delete(id)
    },
  }
  const frames: PlayerFrame[] = []
  const source = new WebcamPoseSource({
    songTimeAt: (ms) => ms / 1000 - 1, // song time 0 at perf 1000 ms
    latencySec: 0.1,
    video: video as unknown as HTMLVideoElement,
    deps,
  })
  source.onFrame((f) => frames.push(f))
  return {
    source,
    video,
    track,
    deps,
    closed,
    detectCalls,
    stopWebcam,
    rafs,
    frames,
    setNow: (ms: number) => {
      now = ms
    },
    releaseCamera: () => releaseCamera?.(),
  }
}

const tickRaf = (rafs: Map<number, FrameRequestCallback>, ms: number): void => {
  const cbs = [...rafs.values()]
  rafs.clear()
  for (const cb of cbs) cb(ms)
}

// --- pure helpers --------------------------------------------------------------------------

describe('webcam frame helpers', () => {
  it('prefers captureTime, then expectedDisplayTime, then now; ignores bogus values', () => {
    expect(captureTimeMs({ captureTime: 990, expectedDisplayTime: 1016 }, 1020)).toBe(990)
    expect(captureTimeMs({ expectedDisplayTime: 1016 }, 1020)).toBe(1016)
    expect(captureTimeMs(null, 1020)).toBe(1020)
    expect(captureTimeMs({ captureTime: 5, expectedDisplayTime: 1016 }, 50_000)).toBe(50_000)
    expect(captureTimeMs({ captureTime: Number.NaN }, 1020)).toBe(1020)
  })

  it('keeps MediaPipe timestamps strictly increasing', () => {
    expect(nextTimestamp(1000, -Infinity)).toBe(1000)
    expect(nextTimestamp(1000, 1000)).toBe(1001)
    expect(nextTimestamp(990, 1000)).toBe(1001)
    expect(nextTimestamp(1033, 1000)).toBe(1033)
  })

  it('stamps frames on the song clock minus latency', () => {
    const f = buildPlayerFrame(landmarks(), 640, 480, 3000, (ms) => ms / 1000 - 1, 0.12)
    expect(f.rawSongTime).toBeCloseTo(2, 9)
    expect(f.songTime).toBeCloseTo(1.88, 9)
    expect(f.captureMs).toBe(3000)
    expect(f.valid).toBe(true)
    expect(f.videoWidth).toBe(640)
    // Player's right wrist is image-left -> +x in the body frame.
    expect(f.pose.r_wrist?.[0]).toBeGreaterThan(0)
    const none = buildPlayerFrame(undefined, 640, 480, 3000, () => 5, 0.1)
    expect(none).toMatchObject({ valid: false, pose: {}, songTime: 4.9, rawSongTime: 5 })
  })

  it('maps a past performance time onto a running song clock', () => {
    const at = songTimeAtFromClock({ songTime: () => 10 }, () => 5000)
    expect(at(4900)).toBeCloseTo(9.9, 9)
  })
})

// --- lifecycle -----------------------------------------------------------------------------

describe('WebcamPoseSource', () => {
  it('detects on every video frame with capture-time stamps', async () => {
    const h = harness()
    expect(h.source.status).toBe('idle')
    const p = h.source.start()
    expect(h.source.status).toBe('starting')
    await p
    expect(h.source.status).toBe('running')
    expect(h.source.activeDelegate).toBe('GPU')
    expect(h.video.muted && h.video.playsInline).toBe(true)

    h.setNow(2020)
    h.video.frame(2020, { captureTime: 2000, expectedDisplayTime: 2030 })
    expect(h.detectCalls).toEqual([2000])
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0].rawSongTime).toBeCloseTo(1, 9)
    expect(h.frames[0].songTime).toBeCloseTo(0.9, 9)
    expect(h.source.latest()).toBe(h.frames[0])

    // Same capture time again (duplicate metadata): timestamps still strictly increase.
    h.video.frame(2025, { captureTime: 2000, expectedDisplayTime: 2030 })
    expect(h.detectCalls).toEqual([2000, 2001])

    h.source.setLatency(0.2)
    h.setNow(2060)
    h.video.frame(2060, { captureTime: 2050, expectedDisplayTime: 2070 })
    expect(h.frames[2].songTime).toBeCloseTo(0.85, 9)
    h.source.stop()
  })

  it('stop() releases everything once, is idempotent, and stops the loop', async () => {
    const h = harness()
    await h.source.start()
    h.source.stop()
    h.source.stop()
    expect(h.stopWebcam).toHaveBeenCalledTimes(1)
    expect(h.closed).toEqual(['GPU'])
    expect(h.video.vfc.size).toBe(0)
    expect(h.rafs.size).toBe(0)
    h.video.frame(3000, { expectedDisplayTime: 3000 })
    expect(h.frames).toHaveLength(0)
    expect(h.source.status).toBe('idle')
  })

  it('is StrictMode-safe: stop during start releases late arrivals, and it can start again', async () => {
    const h = harness({ deferCamera: true })
    const first = h.source.start()
    expect(h.source.start()).toBe(first) // idempotent while starting
    h.source.stop()
    h.releaseCamera() // the camera opens after the unmount
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.stopWebcam).toHaveBeenCalledTimes(1)
    expect(h.closed).toEqual(['GPU'])

    const second = h.source.start()
    h.releaseCamera()
    await second
    expect(h.source.status).toBe('running')
    h.setNow(1500)
    h.video.frame(1500, { captureTime: 1490, expectedDisplayTime: 1510 })
    expect(h.frames).toHaveLength(1)
    h.source.stop()
  })

  it('surfaces camera errors and closes the model it loaded', async () => {
    const h = harness({ failCamera: new Error('Camera permission was denied.') })
    await expect(h.source.start()).rejects.toThrow('Camera permission was denied.')
    expect(h.closed).toEqual(['GPU'])
    expect(h.source.status).toBe('error')
    expect(h.source.error).toBe('Camera permission was denied.')
  })

  it('reports a camera that disappears', async () => {
    const h = harness()
    const errors: string[] = []
    h.source.onError((m) => errors.push(m))
    await h.source.start()
    for (const cb of h.track.listeners) cb()
    expect(errors).toEqual(['The camera stopped (unplugged, or taken by another app).'])
    expect(h.source.status).toBe('error')
    expect(h.stopWebcam).toHaveBeenCalledTimes(1)
  })

  it('falls back to CPU when GPU inference fails', async () => {
    const h = harness({ gpuDetectFails: true })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await h.source.start()
    h.video.frame(1100, { captureTime: 1090, expectedDisplayTime: 1110 })
    expect(h.closed).toEqual(['GPU'])
    await Promise.resolve()
    await Promise.resolve()
    expect(h.source.activeDelegate).toBe('CPU')
    h.setNow(1200)
    h.video.frame(1200, { captureTime: 1190, expectedDisplayTime: 1210 })
    expect(h.frames).toHaveLength(1)
    h.source.stop()
    expect(h.closed).toEqual(['GPU', 'CPU'])
    err.mockRestore()
  })

  it('gives up (stopped, retryable) when CPU inference fails too', async () => {
    const h = harness({ gpuDetectFails: true, cpuDetectFails: true })
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const errors: string[] = []
    h.source.onError((m) => errors.push(m))
    await h.source.start()
    h.video.frame(1100, { captureTime: 1090, expectedDisplayTime: 1110 })
    await Promise.resolve()
    await Promise.resolve()
    h.setNow(1200)
    h.video.frame(1200, { captureTime: 1190, expectedDisplayTime: 1210 })
    expect(errors).toEqual(['Pose detection failed: wasm crashed'])
    expect(h.source.status).toBe('error')
    expect(h.stopWebcam).toHaveBeenCalledTimes(1)
    expect(h.closed).toEqual(['GPU', 'CPU'])
    await h.source.start()
    expect(h.source.status).toBe('running')
    h.source.stop()
    err.mockRestore()
  })

  it('polls from requestAnimationFrame without requestVideoFrameCallback', async () => {
    const h = harness({ noVfc: true })
    await h.source.start()
    h.setNow(1100)
    tickRaf(h.rafs, 1100)
    expect(h.frames).toHaveLength(1)
    expect(h.frames[0].captureMs).toBe(1100)
    h.setNow(1116)
    tickRaf(h.rafs, 1116)
    expect(h.frames).toHaveLength(1) // currentTime unchanged: no new video frame
    h.video.currentTime = 0.033
    h.setNow(1133)
    tickRaf(h.rafs, 1133)
    expect(h.frames).toHaveLength(2)
    h.source.stop()
  })

  it('keeps the camera rolling when the <video> gets paused by a DOM move', async () => {
    const h = harness()
    await h.source.start()
    h.video.dispatch('pause')
    expect(h.video.plays).toBe(1)
    h.source.stop()
    h.video.dispatch('pause')
    expect(h.video.plays).toBe(1)
  })
})
