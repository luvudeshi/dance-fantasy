// "The Magic Mirror": the pre-game calibration overlay. Step 1 gets the player fully in frame,
// step 2 has them hold a star pose to say "ready", step 3 (optional) measures the camera +
// model latency by clapping along with chimes. K skips everything. Webcam frames and poses
// stay in this page: the source's <video> is shown here and the detectors are pure functions.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Mode } from '@shared/routine'
import { JOINTS, type JointName, type Vec2 } from '@shared/skeleton'
import { outputLatencySec } from '../audio/clock'
import { scheduleClicks, type ClickTrack } from '../audio/metronome'
import { prepareCanvas } from '../lib/canvas'
import { errorMessage, isAbortError } from '../lib/errors'
import { useLatest } from '../lib/useLatest'
import { drawSkeleton } from '../pose/draw'
import { imageToDisplay } from '../pose/normalize'
import {
  checkFraming,
  ClapCalibrator,
  clapSchedule,
  FRAMING_MIN_VISIBILITY,
  loadCalibration,
  ReadyDetector,
  saveCalibration,
  type Calibration,
  type ClapSchedule,
  type FramingCheck,
  type FramingIssue,
  type LatencyEstimate,
} from './calibration'
import type { GameClock } from './clock'
import type { PlayerFrame } from './poseSource'
import type { WebcamPoseSource } from './webcamSource'
import './calibration.css'

export interface CalibrationScreenProps {
  /** Started here if needed (start() is idempotent); the parent owns stop(). */
  source: WebcamPoseSource
  mode: Mode
  /** Its AudioContext plays the clap-test chimes. */
  clock: GameClock
  onDone: (cal: Calibration) => void
  onSkip: () => void
  /** Extra buttons shown beside "Try again" while the camera is failing (e.g. bot / lobby). */
  cameraErrorActions?: ReactNode
}

type Step = 'framing' | 'ready' | 'clap'
type Camera = { status: 'starting' } | { status: 'running' } | { status: 'error'; message: string }
type ClapUi =
  | { kind: 'idle' }
  | { kind: 'running'; beat: number; heard: number }
  | { kind: 'done'; estimate: LatencyEstimate; calibration: Calibration }

interface ClapRun {
  ctx: AudioContext
  /** AudioContext time of schedule time 0. */
  startAt: number
  sched: ClapSchedule
  cal: ClapCalibrator
  tracks: ClickTrack[]
}

/** Framing must stay OK this long before moving on (no flicker). */
const FRAMING_HOLD_SEC = 0.6
/** In step 2, losing the player this long goes back to step 1. */
const LOST_SEC = 1.5
/** Lead time before the first count-in chime. */
const CLAP_LEAD_SEC = 1.0
const SUCCESS_CONTINUE_MS = 2500
const STALE_FRAME_MS = 500
const BEAT_SEC = 60 / 100

const ISSUE_RANK: Record<FramingIssue, number> = {
  'no-person': 0,
  'step-back': 1,
  'move-left': 2,
  'move-right': 2,
  closer: 3,
  ok: 4,
}

const frameSec = (f: PlayerFrame): number => (f.captureMs ?? performance.now()) / 1000

/** Context time audible at performance time `perfMs` (same mapping as GameClock.songTime()). */
const audibleCtxAt = (ctx: AudioContext, perfMs: number): number =>
  ctx.currentTime - outputLatencySec(ctx) - (performance.now() - perfMs) / 1000

const sameFraming = (a: FramingCheck, b: FramingCheck): boolean =>
  a.ok === b.ok && a.hint === b.hint && a.issue === b.issue && a.missing.join() === b.missing.join()

const msLabel = (c: Calibration): string =>
  `${Math.round(c.latencySec * 1000)} ms (${c.source === 'measured' ? 'saved' : 'default'})`

export default function CalibrationScreen({ source, mode, clock, onDone, onSkip, cameraErrorActions }: CalibrationScreenProps) {
  const [camera, setCamera] = useState<Camera>(() =>
    source.status === 'running' ? { status: 'running' } : { status: 'starting' },
  )
  const [attempt, setAttempt] = useState(0)
  const [step, setStep] = useState<Step>('framing')
  const [framing, setFraming] = useState<FramingCheck>(() => checkFraming(null, mode))
  const [readyProgress, setReadyProgress] = useState(0)
  const [clap, setClap] = useState<ClapUi>({ kind: 'idle' })
  const [saved, setSaved] = useState<Calibration>(() => loadCalibration())

  const mirrorRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const clapRunRef = useRef<ClapRun | null>(null)
  const stepRef = useLatest(step)
  const modeRef = useLatest(mode)
  const framingOkRef = useLatest(framing.ok)
  const doneRef = useRef(false)

  const finish = (cal: Calibration): void => {
    if (doneRef.current) return
    doneRef.current = true
    stopClapRun(clapRunRef)
    source.setLatency(cal.latencySec)
    onDone(cal)
  }
  const finishRef = useLatest(finish)

  // --- camera ----------------------------------------------------------------------------
  useEffect(() => {
    let alive = true
    source.start().then(
      () => {
        if (alive) setCamera({ status: 'running' })
      },
      (err: unknown) => {
        if (alive && !isAbortError(err)) setCamera({ status: 'error', message: errorMessage(err) })
      },
    )
    const off = source.onError((message) => setCamera({ status: 'error', message }))
    return () => {
      alive = false
      off()
    }
  }, [source, attempt])

  // Show the source's own <video> inside the mirror; put it back where it was afterwards.
  useLayoutEffect(() => {
    const host = mirrorRef.current
    const video = source.video
    if (!host) return
    const prevParent = video.parentNode
    const prevNext = video.nextSibling
    host.prepend(video) // styled by `.calib-mirror > video`
    return () => {
      if (video.parentNode === host) {
        if (prevParent) prevParent.insertBefore(video, prevNext && prevNext.parentNode === prevParent ? prevNext : null)
        else host.removeChild(video)
      }
    }
  }, [source])

  // --- frames -> detectors -----------------------------------------------------------------
  useEffect(() => {
    const ready = new ReadyDetector()
    let okSince: number | null = null
    let lastSeen: number | null = null
    return source.onFrame((frame) => {
      const t = frameSec(frame)
      const check = checkFraming(frame, modeRef.current)
      setFraming((prev) => (sameFraming(prev, check) ? prev : check))
      if (check.issue !== 'no-person') lastSeen = t

      const s = stepRef.current
      if (s === 'framing') {
        okSince = check.ok ? (okSince ?? t) : null
        if (okSince !== null && t - okSince >= FRAMING_HOLD_SEC) {
          ready.reset()
          setReadyProgress(0)
          setStep('ready')
        }
      } else if (s === 'ready') {
        if (lastSeen === null || t - lastSeen > LOST_SEC) {
          okSince = null
          setStep('framing')
          return
        }
        const r = ready.update(frame, t)
        setReadyProgress(Math.round(r.progress * 20) / 20)
        if (r.ready) setStep('clap')
      } else {
        const run = clapRunRef.current
        if (!run) return
        const tc = audibleCtxAt(run.ctx, frame.captureMs ?? performance.now()) - run.startAt
        if (run.cal.addFrame(frame, tc)) {
          const heard = run.cal.claps.length
          setClap((c) => (c.kind === 'running' ? { ...c, heard } : c))
        }
      }
    })
  }, [source, stepRef, modeRef])

  // --- clap test ---------------------------------------------------------------------------
  /** Must run in a user gesture when the AudioContext is still locked. */
  const startClapTest = (): void => {
    stopClapRun(clapRunRef)
    const ctx = clock.unlock()
    const sched = clapSchedule()
    const startAt = ctx.currentTime + CLAP_LEAD_SEC
    const tracks = [
      scheduleClicks(ctx, sched.countIn, startAt, { frequency: 880, volume: 0.22 }),
      scheduleClicks(ctx, sched.clicks, startAt, { frequency: 1320, volume: 0.4 }),
    ]
    clapRunRef.current = { ctx, startAt, sched, cal: new ClapCalibrator(sched.clicks), tracks }
    setClap({ kind: 'running', beat: -1, heard: 0 })
  }
  const startClapRef = useLatest(startClapTest)

  // Entering step 3 starts the chimes right away when audio is already unlocked (it is after
  // "Start the ball"); otherwise a button press does it.
  useEffect(() => {
    if (step !== 'clap' || clapRunRef.current) return
    if (clock.context?.state === 'running') startClapRef.current()
  }, [step, clock, startClapRef])

  useEffect(() => () => stopClapRun(clapRunRef), [])

  // After a good measurement, carry on by itself.
  useEffect(() => {
    if (clap.kind !== 'done' || !clap.estimate.ok) return
    const cal = clap.calibration
    const id = window.setTimeout(() => finishRef.current(cal), SUCCESS_CONTINUE_MS)
    return () => window.clearTimeout(id)
  }, [clap, finishRef])

  // --- drawing loop: mirror skeleton + clap-test beat tracking --------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const prepared = prepareCanvas(canvas)
      const f = source.latest()
      if (prepared && f?.image && f.videoWidth && f.videoHeight && performance.now() - (f.captureMs ?? 0) < STALE_FRAME_MS) {
        const { ctx, width, height } = prepared
        const pts: Partial<Record<JointName, Vec2>> = {}
        for (const j of JOINTS) {
          const p = f.image[j]
          if (p) pts[j] = imageToDisplay(p, f.videoWidth, f.videoHeight, width, height, true)
        }
        drawSkeleton(ctx, pts, {
          visibility: f.visibility,
          minVisibility: FRAMING_MIN_VISIBILITY,
          color: framingOkRef.current ? '#fde68a' : '#c4b5fd',
          outlineColor: 'rgba(8, 10, 30, 0.65)',
          lineWidth: 6,
        })
      }

      const run = clapRunRef.current
      if (run) {
        const t = run.ctx.currentTime - outputLatencySec(run.ctx) - run.startAt
        const beat = t < -0.05 ? -1 : Math.floor(t / BEAT_SEC + 0.15)
        setClap((c) => (c.kind === 'running' && c.beat !== beat ? { ...c, beat } : c))
        if (t > run.sched.endSec) {
          clapRunRef.current = null
          for (const tr of run.tracks) tr.stop()
          const previous = loadCalibration()
          const result = run.cal.finish(previous)
          if (result.estimate.ok) {
            saveCalibration(result.calibration)
            setSaved(result.calibration)
          }
          setClap({ kind: 'done', ...result })
        }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [source, framingOkRef])

  // --- keys ------------------------------------------------------------------------------------
  const primary = (): void => {
    if (step !== 'clap') return
    if (clap.kind === 'done') finish(clap.calibration)
    else if (clap.kind === 'idle') startClapTest()
  }
  const onKey = useLatest((e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault()
      if (!doneRef.current) {
        doneRef.current = true
        stopClapRun(clapRunRef)
        onSkip()
      }
    } else if (e.key === 'Enter') {
      if (e.target instanceof Element && e.target.closest('button, input, select, textarea, a')) return
      e.preventDefault()
      primary()
    }
  })
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => onKey.current(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onKey])

  // --- render ----------------------------------------------------------------------------------
  const rank = ISSUE_RANK[framing.issue ?? (framing.ok ? 'ok' : 'no-person')]
  const checklist = [
    { label: 'The mirror sees you', ok: rank > 0 },
    { label: mode === 'seated' ? 'Head and hands in the glass' : 'Head to toe in the glass', ok: rank > 1 },
    { label: 'Centre of the ballroom', ok: rank > 2 },
    { label: 'Close enough to shine', ok: rank > 3 },
  ]
  const steps: { id: Step; label: string }[] = [
    { id: 'framing', label: 'Stand in the mirror' },
    { id: 'ready', label: 'Strike a star' },
    { id: 'clap', label: 'Clap along' },
  ]
  const stepIndex = steps.findIndex((s) => s.id === step)

  let hint: string
  let sub: string
  if (camera.status === 'starting') {
    hint = 'Waking the magic mirror…'
    sub = 'Allow the camera if your browser asks. Everything it sees stays on this computer.'
  } else if (camera.status === 'error') {
    hint = 'The magic mirror stays dark'
    sub = camera.message
  } else if (step === 'framing') {
    hint = framing.hint
    sub =
      mode === 'seated'
        ? 'The magic mirror needs to see your face, arms and hands…'
        : 'The magic mirror needs to see all of you, from crown to slippers…'
  } else if (step === 'ready') {
    hint = 'Strike a star! ✦'
    sub = 'Raise both arms up and out like a star, and hold it while the light fills.'
  } else if (clap.kind === 'done') {
    hint = clap.estimate.ok ? 'The mirror keeps time!' : 'Let’s try that again?'
    sub = clap.estimate.message
  } else {
    hint = 'Clap along with the chimes'
    sub = 'Four soft chimes count you in, then clap on each of the next eight. Big claps, arms wide in between!'
  }

  return (
    <div className="calib" role="dialog" aria-modal="true" aria-label="Magic mirror calibration">
      <header className="calib-head">
        <p className="calib-kicker">Before the ball</p>
        <h2 className="calib-title">The Magic Mirror</h2>
        <ol className="calib-steps">
          {steps.map((s, i) => (
            <li key={s.id} className={i < stepIndex ? 'done' : i === stepIndex ? 'on' : undefined}>
              <span className="calib-step-num">{i < stepIndex ? '✓' : i + 1}</span>
              {s.label}
            </li>
          ))}
        </ol>
      </header>

      <div className="calib-body">
        <div className={`calib-mirror${framing.ok && camera.status === 'running' ? ' ok' : ''}`} ref={mirrorRef}>
          <canvas className="calib-overlay" ref={canvasRef} />
          {camera.status === 'starting' && <div className="slipper-spinner calib-spinner" aria-hidden="true" />}
          {step === 'ready' && (
            <div className="calib-star" style={{ opacity: 0.25 + 0.75 * readyProgress }} aria-hidden="true">
              ✦
            </div>
          )}
        </div>

        <aside className="calib-panel">
          <p className="calib-hint" aria-live="polite">
            {hint}
          </p>
          <p className="calib-sub">{sub}</p>

          {camera.status === 'running' && step === 'framing' && (
            <ul className="calib-checklist">
              {checklist.map((c) => (
                <li key={c.label} className={c.ok ? 'ok' : undefined}>
                  <span aria-hidden="true">{c.ok ? '✦' : '○'}</span> {c.label}
                </li>
              ))}
            </ul>
          )}

          {step === 'ready' && (
            <div className="calib-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(readyProgress * 100)}>
              <span style={{ transform: `scaleX(${readyProgress})` }} />
            </div>
          )}

          {step === 'clap' && clap.kind === 'running' && (
            <>
              <div className="calib-beats" aria-hidden="true">
                {Array.from({ length: 12 }, (_, i) => (
                  <span
                    key={i}
                    className={[i < 4 ? 'count-in' : 'clap', i === clap.beat ? 'now' : i < clap.beat ? 'past' : ''].join(' ')}
                  />
                ))}
              </div>
              <p className="calib-heard">
                {clap.beat < 4 ? (clap.beat < 0 ? 'Listen…' : `${4 - clap.beat}…`) : 'Clap!'} · {clap.heard} clap
                {clap.heard === 1 ? '' : 's'} heard
              </p>
            </>
          )}

          <div className="calib-actions">
            {camera.status === 'error' && (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setCamera({ status: 'starting' })
                  setAttempt((n) => n + 1)
                }}
              >
                Try again
              </button>
            )}
            {camera.status === 'error' && cameraErrorActions}
            {step === 'clap' && clap.kind === 'idle' && (
              <button type="button" className="primary" onClick={startClapTest}>
                ♪ Start the clap test
              </button>
            )}
            {step === 'clap' && clap.kind === 'done' && (
              <>
                {!clap.estimate.ok && (
                  <button type="button" className="primary" onClick={startClapTest}>
                    Clap again
                  </button>
                )}
                <button type="button" className={clap.estimate.ok ? 'primary' : undefined} onClick={() => finish(clap.calibration)}>
                  {clap.estimate.ok ? 'To the ball! ▶' : `Continue with ${msLabel(clap.calibration)}`}
                </button>
              </>
            )}
            {step === 'clap' && clap.kind !== 'done' && (
              <button type="button" onClick={() => finish(saved)}>
                Skip clap test — use {msLabel(saved)}
              </button>
            )}
          </div>
          <p className="calib-keys">K skips the mirror{step === 'clap' ? ' · Enter continues' : ''} · Esc lobby</p>
        </aside>
      </div>
    </div>
  )
}

function stopClapRun(ref: { current: ClapRun | null }): void {
  const run = ref.current
  ref.current = null
  if (run) for (const t of run.tracks) t.stop()
}
