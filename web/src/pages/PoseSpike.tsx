// SPIKE 1: webcam -> MediaPipe PoseLandmarker -> 17-joint skeleton on the video and in
// the normalized body frame. Pose data never leaves the browser.

import { useEffect, useRef, useState } from 'react'
import { JOINTS, type JointName, type Vec2 } from '@shared/skeleton'
import { prepareCanvas } from '../lib/canvas'
import { errorMessage, isAbortError } from '../lib/errors'
import { RateMeter } from '../lib/rateMeter'
import { useLatest } from '../lib/useLatest'
import { drawSkeleton } from '../pose/draw'
import { createPoseLandmarker, type PoseLandmarkerHandle } from '../pose/mediapipe'
import { DELEGATES, POSE_MODELS, type Delegate, type PoseModel } from '../pose/mediapipeAssets'
import { bodyToScreen, imageToDisplay, landmarksToPlayerPose, type PlayerPose } from '../pose/normalize'
import { startWebcam, stopWebcam } from '../pose/webcam'
import { UI_FONT } from '../theme/fonts'

const MODEL_SIZES: Record<PoseModel, string> = { lite: '5.8 MB', full: '9.4 MB', heavy: '31 MB' }
const UI_UPDATE_MS = 100
const GOOD_FPS = 24

type CameraStatus = 'off' | 'starting' | 'on'

interface LoadResult {
  /** `${model}|${delegate}|${reloads}` this result belongs to. */
  key: string
  handle: PoseLandmarkerHandle | null
  error: string | null
}

interface LiveStats {
  inferenceFps: number
  renderFps: number
  inferenceMs: number
  videoWidth: number
  videoHeight: number
  rWrist: Vec2 | null
  lWrist: Vec2 | null
  torsoPx: number
  person: 'none' | 'invalid' | 'ok'
}

const EMPTY_STATS: LiveStats = {
  inferenceFps: 0,
  renderFps: 0,
  inferenceMs: 0,
  videoWidth: 0,
  videoHeight: 0,
  rWrist: null,
  lWrist: null,
  torsoPx: 0,
  person: 'none',
}

/** Narrows a <select> value to one of `options` (falls back to `current`). */
function pick<T extends string>(options: readonly T[], value: string, current: T): T {
  return options.find((o) => o === value) ?? current
}

const rightHandUp = (w: Vec2 | null | undefined): boolean => !!w && w[0] > 0 && w[1] < -1
const fmt = (v: number, digits = 2): string => (v >= 0 ? '+' : '') + v.toFixed(digits)
const fpsClass = (fps: number): string => (fps >= GOOD_FPS ? 'good' : fps >= 15 ? 'warn' : 'bad')

// --- drawing -------------------------------------------------------------------------

function drawVideoOverlay(canvas: HTMLCanvasElement, video: HTMLVideoElement, pose: PlayerPose | null, mirrored: boolean): void {
  const prepared = prepareCanvas(canvas)
  if (!prepared || !pose) return
  const { ctx, width, height } = prepared
  const vw = video.videoWidth
  const vh = video.videoHeight
  const points: Partial<Record<JointName, Vec2>> = {}
  for (const j of JOINTS) points[j] = imageToDisplay(pose.image[j], vw, vh, width, height, mirrored)
  drawSkeleton(ctx, points, {
    visibility: pose.visibility,
    color: pose.valid ? '#c4b5fd' : '#f87171',
    outlineColor: 'rgba(8, 10, 30, 0.6)',
    lineWidth: 4,
  })
}

function drawBodyPanel(
  canvas: HTMLCanvasElement,
  pose: PlayerPose | null,
  mirrored: boolean,
  emptyMessage = 'No person detected',
): void {
  const prepared = prepareCanvas(canvas)
  if (!prepared) return
  const { ctx, width, height } = prepared
  // Fit roughly x in [-2.2, 2.2] and y in [-2.6, 2.2] (raised hands to feet).
  const scale = Math.min(width / 4.4, height / 4.8)
  const view = { cx: width / 2, cy: height / 2 + 0.2 * scale, scale, mirrored }
  const halfW = width / 2 / scale
  const top = -view.cy / scale
  const bottom = (height - view.cy) / scale

  // Grid every 0.5 body units; integer lines a bit brighter.
  ctx.lineWidth = 1
  for (let u = Math.ceil(-halfW * 2) / 2; u <= halfW; u += 0.5) {
    const [x] = bodyToScreen([u, 0], view)
    ctx.strokeStyle = Number.isInteger(u) ? 'rgba(148, 163, 255, 0.16)' : 'rgba(148, 163, 255, 0.07)'
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let u = Math.ceil(top * 2) / 2; u <= bottom; u += 0.5) {
    const [, y] = bodyToScreen([0, u], view)
    ctx.strokeStyle = Number.isInteger(u) ? 'rgba(148, 163, 255, 0.16)' : 'rgba(148, 163, 255, 0.07)'
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }

  // Axes through the origin (mid-hip).
  const [ox, oy] = bodyToScreen([0, 0], view)
  ctx.strokeStyle = 'rgba(203, 213, 255, 0.55)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(0, oy)
  ctx.lineTo(width, oy)
  ctx.moveTo(ox, 0)
  ctx.lineTo(ox, height)
  ctx.stroke()

  // Shoulder line y = -1: a raised hand is above it.
  const [, shY] = bodyToScreen([0, -1], view)
  ctx.save()
  ctx.setLineDash([6, 6])
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.45)'
  ctx.beginPath()
  ctx.moveTo(0, shY)
  ctx.lineTo(width, shY)
  ctx.stroke()
  ctx.restore()

  ctx.font = `600 12px ${UI_FONT}`
  ctx.fillStyle = 'rgba(203, 213, 255, 0.8)'
  ctx.textBaseline = 'bottom'
  const [plusX] = bodyToScreen([halfW - 0.1, 0], view)
  ctx.textAlign = mirrored ? 'right' : 'left'
  ctx.fillText(mirrored ? "+x (dancer's right) →" : "← +x (dancer's right)", plusX, oy - 4)
  ctx.textAlign = 'left'
  ctx.fillText('+y ↓', ox + 6, height - 6)
  ctx.fillStyle = 'rgba(250, 204, 21, 0.75)'
  ctx.fillText('y = -1 (shoulders)', 8, shY - 3)

  if (!pose || !pose.valid) {
    ctx.fillStyle = 'rgba(203, 213, 255, 0.6)'
    ctx.textAlign = 'center'
    ctx.font = `600 15px ${UI_FONT}`
    ctx.fillText(pose ? 'Pose too small: step closer' : emptyMessage, width / 2, height * 0.18)
    return
  }

  const points: Partial<Record<JointName, Vec2>> = {}
  for (const j of JOINTS) {
    const p = pose.pose[j]
    if (p) points[j] = bodyToScreen(p, view)
  }
  drawSkeleton(ctx, points, { visibility: pose.visibility, color: '#7dd3fc', lineWidth: 5 })

  const rw = pose.pose.r_wrist
  if (rightHandUp(rw) && points.r_wrist) {
    ctx.strokeStyle = '#4ade80'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(points.r_wrist[0], points.r_wrist[1], 14, 0, Math.PI * 2)
    ctx.stroke()
  }
}

// --- component -----------------------------------------------------------------------

export default function PoseSpike() {
  const [model, setModel] = useState<PoseModel>('lite')
  const [delegate, setDelegate] = useState<Delegate>('GPU')
  const [mirrored, setMirrored] = useState(true)
  const [camera, setCamera] = useState<CameraStatus>('off')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [load, setLoad] = useState<LoadResult | null>(null)
  const [reloads, setReloads] = useState(0)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [stats, setStats] = useState<LiveStats>(EMPTY_STATS)

  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const bodyRef = useRef<HTMLCanvasElement>(null)
  /** The landmarker the render loop should use; null while (re)loading. */
  const landmarkerRef = useRef<PoseLandmarkerHandle | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const cameraAbortRef = useRef<AbortController | null>(null)
  const mirroredRef = useLatest(mirrored)

  const loadKey = `${model}|${delegate}|${reloads}`
  const loading = load?.key !== loadKey
  const handle = loading ? null : load.handle
  const modelError = loading ? null : load.error

  // (Re)create the landmarker whenever model/delegate change. StrictMode runs this twice
  // on mount, and an older create can resolve after a newer one: every run owns its own
  // AbortController and closes whatever it created once it is cleaned up.
  useEffect(() => {
    const ac = new AbortController()
    const key = `${model}|${delegate}|${reloads}`
    let mine: PoseLandmarkerHandle | null = null
    createPoseLandmarker({ model, delegate, signal: ac.signal }).then(
      (h) => {
        if (ac.signal.aborted) {
          h.landmarker.close()
          return
        }
        mine = h
        landmarkerRef.current = h
        setLoad({ key, handle: h, error: null })
      },
      (err: unknown) => {
        if (ac.signal.aborted || isAbortError(err)) return
        console.error('[pose] landmarker creation failed', err)
        setLoad({ key, handle: null, error: errorMessage(err) })
      },
    )
    return () => {
      ac.abort()
      if (mine) {
        if (landmarkerRef.current === mine) landmarkerRef.current = null
        mine.landmarker.close()
        mine = null
      }
    }
  }, [model, delegate, reloads])

  // Camera start/stop are imperative (button clicks); this only guarantees cleanup.
  const stopCamera = (): void => {
    cameraAbortRef.current?.abort()
    cameraAbortRef.current = null
    stopWebcam(streamRef.current, videoRef.current)
    streamRef.current = null
    setCamera('off')
  }

  useEffect(
    () => () => {
      cameraAbortRef.current?.abort()
      cameraAbortRef.current = null
      stopWebcam(streamRef.current, videoRef.current)
      streamRef.current = null
    },
    [],
  )

  const startCamera = async (): Promise<void> => {
    const video = videoRef.current
    if (!video) return
    cameraAbortRef.current?.abort()
    const ac = new AbortController()
    cameraAbortRef.current = ac
    setCameraError(null)
    setCamera('starting')
    try {
      const stream = await startWebcam(video, { width: 640, height: 480, signal: ac.signal })
      streamRef.current = stream
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (streamRef.current !== stream) return
        stopWebcam(stream, videoRef.current)
        streamRef.current = null
        setCamera('off')
        setCameraError('The camera stopped (unplugged, or taken by another app).')
      })
      setCamera('on')
    } catch (err) {
      if (ac.signal.aborted || isAbortError(err)) return
      setCameraError(errorMessage(err))
      setCamera('off')
    } finally {
      if (cameraAbortRef.current === ac) cameraAbortRef.current = null
    }
  }

  // Render/detect loop while the camera runs. Detection only runs on new video frames
  // (requestVideoFrameCallback when available, else a currentTime change); drawing runs
  // every animation frame.
  const live = camera === 'on'
  useEffect(() => {
    const video = videoRef.current
    const overlay = overlayRef.current
    const body = bodyRef.current
    if (!live || !video || !overlay || !body) return

    const inference = new RateMeter(1000)
    const render = new RateMeter(1000)
    let raf = 0
    let vfcHandle = 0
    let newFrame = false
    let lastVideoTime = -1
    let lastTimestamp = -Infinity
    let lastUi = 0
    let current: PoseLandmarkerHandle | null = null
    let failed = false
    let pose: PlayerPose | null = null

    const hasVfc = typeof video.requestVideoFrameCallback === 'function'
    const onVideoFrame = (): void => {
      newFrame = true
      vfcHandle = video.requestVideoFrameCallback(onVideoFrame)
    }
    if (hasVfc) vfcHandle = video.requestVideoFrameCallback(onVideoFrame)

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      render.add(now)

      const h = landmarkerRef.current
      if (h !== current) {
        // Model/delegate changed (or still loading): forget the old pose and errors.
        current = h
        pose = null
        failed = false
        setDetectError(null)
      }
      if (!hasVfc && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime
        newFrame = true
      }
      if (h && !failed && newFrame && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        newFrame = false
        // MediaPipe requires strictly increasing timestamps (ms).
        const ts = Math.max(performance.now(), lastTimestamp + 1)
        lastTimestamp = ts
        const t0 = performance.now()
        try {
          const result = h.landmarker.detectForVideo(video, ts)
          const t1 = performance.now()
          inference.add(t1, t1 - t0)
          const lms = result.landmarks[0]
          pose = lms ? landmarksToPlayerPose(lms, video.videoWidth, video.videoHeight) : null
        } catch (err) {
          failed = true
          pose = null
          console.error('[pose] detectForVideo failed', err)
          setDetectError(`Pose detection failed: ${errorMessage(err)}. Try the CPU delegate.`)
        }
      }

      const mirror = mirroredRef.current
      drawVideoOverlay(overlay, video, pose, mirror)
      drawBodyPanel(body, pose, mirror)

      if (now - lastUi >= UI_UPDATE_MS) {
        lastUi = now
        setStats({
          inferenceFps: inference.rate(now),
          renderFps: render.rate(now),
          inferenceMs: inference.mean(now),
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          rWrist: pose?.valid ? (pose.pose.r_wrist ?? null) : null,
          lWrist: pose?.valid ? (pose.pose.l_wrist ?? null) : null,
          torsoPx: pose?.torsoPx ?? 0,
          person: pose ? (pose.valid ? 'ok' : 'invalid') : 'none',
        })
      }
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      if (hasVfc) video.cancelVideoFrameCallback(vfcHandle)
      prepareCanvas(overlay)
      prepareCanvas(body)
      setStats(EMPTY_STATS)
    }
  }, [live, mirroredRef])

  // While the camera is off, keep the (empty) body-frame grid visible and sized.
  useEffect(() => {
    const body = bodyRef.current
    if (live || !body) return
    const redraw = (): void => drawBodyPanel(body, null, mirrored, 'Camera off')
    redraw()
    const ro = new ResizeObserver(redraw)
    ro.observe(body)
    return () => ro.disconnect()
  }, [live, mirrored])

  const status = loading
    ? `Loading pose model (${model}, ${delegate})…`
    : camera === 'starting'
      ? 'Starting camera… allow access if the browser asks.'
      : camera === 'off'
        ? 'Camera off.'
        : null

  return (
    <section className="page pose-spike">
      <div className="toolbar">
        {camera === 'off' ? (
          <button type="button" className="primary" onClick={() => void startCamera()}>
            Start camera
          </button>
        ) : (
          <button type="button" onClick={stopCamera}>
            Stop camera
          </button>
        )}
        <label>
          Model
          <select value={model} onChange={(e) => setModel(pick(POSE_MODELS, e.target.value, model))}>
            {POSE_MODELS.map((m) => (
              <option key={m} value={m}>
                {m} ({MODEL_SIZES[m]})
              </option>
            ))}
          </select>
        </label>
        <label>
          Delegate
          <select value={delegate} onChange={(e) => setDelegate(pick(DELEGATES, e.target.value, delegate))}>
            {DELEGATES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={mirrored} onChange={(e) => setMirrored(e.target.checked)} />
          Mirror
        </label>
        {status && <span className="status">{status}</span>}
      </div>

      {modelError && (
        <p className="error">
          Pose model: {modelError}{' '}
          <button type="button" className="link" onClick={() => setReloads((n) => n + 1)}>
            Retry
          </button>
        </p>
      )}
      {cameraError && <p className="error">Camera: {cameraError}</p>}
      {detectError && <p className="error">{detectError}</p>}

      <div className="pose-panels">
        <div className="panel">
          <h2>Webcam</h2>
          <div className="stage video-stage">
            <video ref={videoRef} className={mirrored ? 'mirrored' : undefined} playsInline muted />
            <canvas ref={overlayRef} className="overlay" />
            <dl className="stats">
              <dt>inference</dt>
              <dd className={fpsClass(stats.inferenceFps)}>{stats.inferenceFps.toFixed(0)} fps</dd>
              <dt>render</dt>
              <dd className={fpsClass(stats.renderFps)}>{stats.renderFps.toFixed(0)} fps</dd>
              <dt>avg infer</dt>
              <dd>{stats.inferenceMs.toFixed(1)} ms</dd>
              <dt>delegate</dt>
              <dd>
                {handle ? handle.delegate : '…'}
                {handle && handle.delegate !== delegate ? ` (asked ${delegate})` : ''}
              </dd>
              <dt>model</dt>
              <dd>{handle ? handle.model : model}</dd>
              <dt>wasm / model</dt>
              <dd>{handle ? `${handle.wasmSource} / ${handle.modelSource}` : '…'}</dd>
              <dt>video</dt>
              <dd>{stats.videoWidth ? `${stats.videoWidth}×${stats.videoHeight}` : '–'}</dd>
            </dl>
          </div>
        </div>

        <div className="panel">
          <h2>Body frame</h2>
          <div className="stage body-stage">
            <canvas ref={bodyRef} />
          </div>
          <p className="hint">
            Raise your RIGHT hand: <code>r_wrist.x &gt; 0</code> and <code>y &lt; -1</code>
            {rightHandUp(stats.rWrist) && <strong className="good"> ✓ right hand up</strong>}
          </p>
          <dl className="readout">
            <dt>r_wrist</dt>
            <dd>{stats.rWrist ? `(${fmt(stats.rWrist[0])}, ${fmt(stats.rWrist[1])})` : '–'}</dd>
            <dt>l_wrist</dt>
            <dd>{stats.lWrist ? `(${fmt(stats.lWrist[0])}, ${fmt(stats.lWrist[1])})` : '–'}</dd>
            <dt>torso</dt>
            <dd>{stats.torsoPx ? `${stats.torsoPx.toFixed(0)} px` : '–'}</dd>
            <dt>person</dt>
            <dd>{stats.person}</dd>
          </dl>
        </div>
      </div>
      <p className="footnote">
        Pose detection runs entirely in this browser tab; no video or pose data is sent anywhere.
      </p>
    </section>
  )
}
