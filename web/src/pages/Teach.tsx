// Teach mode: #/teach?routine=<16-hex id>[&start=<move index>]. Learn one 8-count at a time:
// pick it on the strip, loop it at 0.5x / 0.75x / 1x (pitch preserved), copy the coach after a
// "5 6 7 8" count-in, and get one short tip per beat ("Left arm late", "Right arm too low").
// Two passes >= 80% suggest the next speed; two at 1x: "Nailed it!". No camera? The demo bot
// dances (and improves) so the tips still show.
//
// The page owns the camera, the canvas loop and the keys; game/teachEngine.ts does the rest.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { apiSessionDeps, prepareFromRoutine, STEP_LABELS, type PreparedGame, type SessionState } from '../game/session'
import { loadCalibration } from '../game/calibration'
import { JUDGMENT_STYLE } from '../game/hud'
import { loadJudging, scoringFor } from '../game/judging'
import { TEACH_RATES, TeachClock, type TeachRate } from '../game/mediaClock'
import { buildCheckpoints, judge } from '../game/scoring'
import { buildSegments, PASS_ACCURACY, PASSES_TO_ADVANCE, passStreak, segmentForMove, suggestionFor } from '../game/teach'
import { drawTeachFrame } from '../game/teachDraw'
import { TeachEngine } from '../game/teachEngine'
import { WebcamPoseSource } from '../game/webcamSource'
import { prepareCanvas } from '../lib/canvas'
import { errorMessage, isAbortError } from '../lib/errors'
import { isRoutineId, parseHash, playRoutineHash } from '../lib/hashRoute'
import { coachThemeFor } from '../render/coach'
import './teach.css'

const subscribeHash = (cb: () => void): (() => void) => {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}
const readHash = (): string => window.location.hash

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)
const rateLabel = (r: number): string => `${r}×`
const pct = (v: number): string => `${Math.round(Math.max(0, Math.min(100, v)))}%`

/** Keep Space for play / pause, not for re-clicking the focused button. */
const click = (fn: () => void) => (e: { currentTarget: HTMLElement }) => {
  e.currentTarget.blur()
  fn()
}

export default function TeachPage() {
  const hash = useSyncExternalStore(subscribeHash, readHash)
  const { params } = parseHash(hash)
  const id = params.get('routine')
  const startParam = params.get('start')
  const start = startParam !== null && /^\d{1,4}$/.test(startParam) ? Number(startParam) : null
  if (!isRoutineId(id)) {
    return (
      <TeachProblem title="Which dance shall we learn?">
        Pick a song in the lobby, then choose <b>Learn it first</b> (or <b>Practice your hardest move</b> after a dance).
      </TeachProblem>
    )
  }
  return <TeachSession key={`${id}:${start ?? ''}`} routineId={id} start={start} />
}

function TeachProblem({ title, children, routineId }: { title: string; children: ReactNode; routineId?: string }) {
  return (
    <section className="teach teach-problem">
      <div className="teach-card">
        <p className="teach-kicker">Dance lesson</p>
        <h2>{title}</h2>
        <p>{children}</p>
        <div className="teach-card-actions">
          {routineId && (
            <a className="teach-button primary" href={playRoutineHash(routineId)}>
              Open it in Play
            </a>
          )}
          <a className="teach-button" href="#/play">
            Back to the lobby
          </a>
        </div>
      </div>
    </section>
  )
}

function TeachSession({ routineId, start }: { routineId: string; start: number | null }) {
  // Survives dispose() (StrictMode remounts reuse it).
  const [clock] = useState(() => new TeachClock())
  const [state, setState] = useState<SessionState>({ status: 'loading', step: 'findingRoutine', label: STEP_LABELS.findingRoutine })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const ac = new AbortController()
    const deps = apiSessionDeps({
      load: (key, src, signal) => ('url' in src ? clock.load(key, src.url, signal) : Promise.reject(new Error('teach mode plays server audio only'))),
    })
    void prepareFromRoutine(routineId, deps, setState, ac.signal)
    return () => ac.abort()
  }, [clock, routineId, attempt])

  useEffect(() => () => clock.dispose(), [clock])

  if (state.status === 'error') {
    return (
      <TeachProblem title="This lesson can’t start" routineId={routineId}>
        {state.message}.{' '}
        {state.recipe ? 'Open it in Play to generate it again, then come back.' : ''}
        <button type="button" className="link teach-retry" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </TeachProblem>
    )
  }
  if (state.status !== 'ready') {
    return (
      <section className="teach teach-problem">
        <div className="teach-card loading">
          <div className="teach-spinner" aria-hidden="true" />
          <p aria-live="polite">{state.status === 'loading' ? state.label : 'Getting ready…'}</p>
        </div>
      </section>
    )
  }
  return <TeachStudio game={state.game} clock={clock} routineId={routineId} start={start} />
}

type Camera = { status: 'starting' | 'live' | 'off' } | { status: 'error'; message: string }

function TeachStudio({ game, clock, routineId, start }: { game: PreparedGame; clock: TeachClock; routineId: string; start: number | null }) {
  const { routine, track } = game
  const segments = useMemo(() => buildSegments(routine), [routine])
  const hardest = start !== null ? segmentForMove(segments, start) : null
  const [cal] = useState(() => loadCalibration())
  const [engine] = useState(
    () =>
      new TeachEngine({
        clock,
        routine,
        track,
        segments,
        checkpoints: buildCheckpoints(routine, routine.mode),
        base: scoringFor(loadJudging()),
        calLatencySec: cal.latencySec,
        initialSegment: hardest ?? 0,
      }),
  )
  const st = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
  const [useCamera, setUseCamera] = useState(true)
  const [camAttempt, setCamAttempt] = useState(0)
  const [camera, setCamera] = useState<Camera>({ status: 'starting' })
  const [audioError, setAudioError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  /** The current attempt's webcam source (its <video> feeds the PIP). */
  const camSourceRef = useRef<WebcamPoseSource | null>(null)

  useEffect(() => () => engine.dispose(), [engine])

  // The camera (one WebcamPoseSource per attempt), on the TeachClock's rate-aware time mapping.
  useEffect(() => {
    if (!useCamera) return
    const source = new WebcamPoseSource({ songTimeAt: clock.songTimeAt, latencySec: cal.latencySec * engine.getSnapshot().rate })
    let alive = true
    const fail = (message: string): void => {
      if (!alive) return
      engine.detachWebcam(source)
      setCamera({ status: 'error', message })
    }
    const offError = source.onError(fail)
    camSourceRef.current = source
    source.start().then(
      () => {
        if (!alive) return
        engine.attachWebcam(source)
        setCamera({ status: 'live' })
      },
      (err: unknown) => {
        if (!isAbortError(err)) fail(errorMessage(err))
      },
    )
    return () => {
      alive = false
      offError()
      engine.detachWebcam(source)
      source.stop()
      if (camSourceRef.current === source) camSourceRef.current = null
    }
  }, [engine, clock, cal, useCamera, camAttempt])

  // The frame loop: everything visual follows engine.frame() (the TeachClock).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const v = engine.frame(performance.now())
      const prepared = prepareCanvas(canvas)
      if (prepared && v.segment) {
        const kind = engine.getSnapshot().source
        const video = camSourceRef.current?.video
        const aspect = video && video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 4 / 3
        const pip =
          kind === 'bot'
            ? { kind: 'bot' as const, frame: v.frame, tint: v.tint, aspect }
            : video
              ? { kind: 'webcam' as const, video, frame: v.frame, tint: v.tint, aspect }
              : null
        drawTeachFrame(prepared.ctx, prepared.width, prepared.height, { t: v.t, routine, track, segment: v.segment, wrong: v.wrong, pip })
      }
      const tip = tipRef.current
      if (tip) {
        const text = v.tip?.hint.text ?? ''
        if (tip.textContent !== text) tip.textContent = text
        tip.style.opacity = String(v.tip?.alpha ?? 0)
        tip.dataset.good = v.tip?.hint.good ? 'yes' : 'no'
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engine, routine, track])

  // Keep the chosen 8-count in view on the strip.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('.teach-seg.active')
    el?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [st.segment])

  const actions = useMemo(
    () => ({
      toggle: (): void => {
        setAudioError(null)
        engine.togglePlay().catch((err: unknown) => {
          if (!isAbortError(err)) setAudioError(`The music didn’t start (${errorMessage(err)}). Press ▶ again.`)
        })
      },
      rate: (r: TeachRate): void => engine.selectRate(r),
      segment: (i: number): void => engine.selectSegment(i),
      loop: (): void => engine.setLooping(!engine.getSnapshot().looping),
      bot: (): void => {
        setUseCamera(false)
        setCamera({ status: 'off' })
        engine.useBot()
      },
      camera: (): void => {
        setCamera({ status: 'starting' })
        setUseCamera(true)
        setCamAttempt((n) => n + 1)
      },
    }),
    [engine],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      const el = e.target
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return
      const s = engine.getSnapshot()
      if (e.key === ' ') actions.toggle()
      else if (e.key === '1' || e.key === '2' || e.key === '3') actions.rate(TEACH_RATES[Number(e.key) - 1])
      else if (e.key === 'ArrowLeft') actions.segment(s.segment - 1)
      else if (e.key === 'ArrowRight') actions.segment(s.segment + 1)
      else if (e.key === 'l' || e.key === 'L') actions.loop()
      else if (e.key === 'Escape') window.location.hash = playRoutineHash(routineId)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, actions, routineId])

  const seg = segments[st.segment]
  if (!seg) {
    return (
      <TeachProblem title="Nothing to learn here" routineId={routineId}>
        This routine has no moves to practise.
      </TeachProblem>
    )
  }
  const suggestion = suggestionFor(st.history, st.segment, st.rate)
  const streak = Math.min(PASSES_TO_ADVANCE, passStreak(st.history, st.segment, st.rate))
  const lastPass = [...st.history].reverse().find((h) => h.segment === st.segment) ?? null
  const nailedHere = st.nailed.has(st.segment)
  const recent = st.history.slice(-8)

  return (
    <section className="teach">
      <header className="teach-head">
        <a className="teach-back" href={playRoutineHash(routineId)} title="Back to the full song (Esc)">
          ← Full song
        </a>
        <div className="teach-title">
          <span className="teach-kicker">Dance lesson</span>
          <h2>{routine.song.title}</h2>
          <span className="teach-meta">
            {cap(routine.difficulty)} · {routine.mode} · {segments.length} eight-counts
          </span>
        </div>
        <span className={`teach-cam ${st.source ?? camera.status}`}>
          {st.source === 'bot'
            ? '🤖 Bot demo'
            : st.source === 'webcam'
              ? '📷 Camera on'
              : camera.status === 'starting'
                ? 'Waking the camera…'
                : camera.status === 'error'
                  ? 'No camera'
                  : ''}
        </span>
      </header>

      <div className="teach-segments" ref={stripRef} role="tablist" aria-label="Eight-counts of the routine">
        {segments.map((s) => (
          <button
            key={s.index}
            type="button"
            role="tab"
            aria-selected={s.index === st.segment}
            className={`teach-seg${s.index === st.segment ? ' active' : ''}`}
            style={{ '--seg': coachThemeFor(s.section).glow } as CSSProperties}
            title={`${s.label}: ${s.moveNames.join(', ')}`}
            onClick={click(() => actions.segment(s.index))}
          >
            <span className="teach-seg-label">
              {cap(s.section)} <b>{s.barEnd > s.barStart ? `${s.barStart}–${s.barEnd}` : s.barStart}</b>
              {s.index === hardest && <span className="teach-tag">hardest</span>}
              {st.nailed.has(s.index) && <span className="teach-tag nailed">✨</span>}
            </span>
            <span className="teach-seg-moves">{s.moveNames.join(' · ')}</span>
          </button>
        ))}
      </div>

      <div className="teach-main">
        <div className="teach-stage">
          <canvas ref={canvasRef} className="teach-canvas" aria-label="Dance coach: copy the glowing dancer" />
          <div ref={tipRef} className="teach-tip" aria-live="polite" />
          {nailedHere && (
            <div className="teach-nailed" role="status">
              <span className="teach-nailed-badge">Nailed it! ✨</span>
              <a className="teach-button primary" href={playRoutineHash(routineId)}>
                Back to the full song
              </a>
              {st.segment + 1 < segments.length && (
                <button type="button" className="teach-button" onClick={click(() => actions.segment(st.segment + 1))}>
                  Next 8-count →
                </button>
              )}
            </div>
          )}
          {!st.started && (
            <div className="teach-overlay">
              <div className="teach-card">
                <p className="teach-kicker">{seg.label}</p>
                <h2>Learn it slowly, then nail it</h2>
                <p>
                  We count you in <b>5 · 6 · 7 · 8</b>, then copy the coach like a mirror. The 8-count loops at {rateLabel(st.rate)} until
                  it clicks.
                </p>
                <div className="teach-card-actions">
                  <button type="button" className="teach-button primary big" onClick={click(actions.toggle)}>
                    ▶ Start the lesson
                  </button>
                  {camera.status === 'error' && st.source === null && (
                    <button
                      type="button"
                      className="teach-button"
                      onClick={click(() => {
                        actions.bot()
                        actions.toggle()
                      })}
                    >
                      🤖 Teach me with the bot
                    </button>
                  )}
                </div>
                {camera.status === 'error' && st.source === null && (
                  <p className="teach-small warn">No camera: {camera.message}</p>
                )}
                <p className="teach-small">Space play/pause · 1 2 3 speed · ← → 8-count · L loop · Esc full song</p>
              </div>
            </div>
          )}
          {camera.status === 'error' && st.source === null && st.started && (
            <div className="teach-camcard" role="alert">
              <p>
                <b>The camera didn’t start.</b> {camera.message}
              </p>
              <div className="teach-card-actions">
                <button type="button" className="teach-button primary" onClick={click(actions.bot)}>
                  🤖 Teach me with the bot
                </button>
                <button type="button" className="teach-button" onClick={click(actions.camera)}>
                  Try the camera again
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="teach-side">
          <div className="teach-panel">
            <span className="teach-label">Now learning</span>
            <strong className="teach-seg-title">{seg.label}</strong>
            <span className="teach-moves">{seg.moveNames.join(' → ')}</span>
          </div>

          <div className="teach-panel teach-transport">
            <button type="button" className="teach-button primary big" onClick={click(actions.toggle)} title="Play / pause (Space)">
              {st.playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button
              type="button"
              className={`teach-button toggle${st.looping ? ' on' : ''}`}
              aria-pressed={st.looping}
              onClick={click(actions.loop)}
              title="Loop the 8-count (L)"
            >
              ⟲ Loop {st.looping ? 'on' : 'off'}
            </button>
          </div>

          <div className="teach-panel">
            <span className="teach-label">Speed</span>
            <div className="teach-speeds" role="group" aria-label="Playback speed">
              {TEACH_RATES.map((r, i) => (
                <button
                  key={r}
                  type="button"
                  className={`teach-button speed${st.rate === r ? ' on' : ''}`}
                  aria-pressed={st.rate === r}
                  onClick={click(() => actions.rate(r))}
                  title={`${rateLabel(r)} (${i + 1})`}
                >
                  {rateLabel(r)}
                </button>
              ))}
            </div>
          </div>

          <div className="teach-panel teach-score">
            <span className="teach-label">This pass</span>
            <span className="teach-acc" style={{ color: st.pass.accuracy === null ? undefined : JUDGMENT_STYLE[judge(st.pass.accuracy)].color }}>
              {st.pass.accuracy === null ? '–' : pct(st.pass.accuracy)}
            </span>
            <span className="teach-small">
              {st.pass.total > 0 ? `${st.pass.judged} / ${st.pass.total} beats judged` : 'No judged beats in this 8-count'}
              {lastPass ? ` · last ${pct(lastPass.accuracy)} at ${rateLabel(lastPass.rate)}` : ''}
            </span>
            <span className="teach-streak" title={`${PASSES_TO_ADVANCE} passes at ${PASS_ACCURACY}%+ unlock the next speed`}>
              {Array.from({ length: PASSES_TO_ADVANCE }, (_, i) => (
                <span key={i} className={i < streak ? 'on' : undefined} />
              ))}
              <span className="teach-small">
                {PASS_ACCURACY}%+ twice at {rateLabel(st.rate)}
              </span>
            </span>
          </div>

          {suggestion?.kind === 'speed-up' && (
            <div className="teach-panel teach-suggest" role="status">
              <strong>Lovely! Ready for {rateLabel(suggestion.next)}?</strong>
              <button type="button" className="teach-button primary" onClick={click(() => actions.rate(suggestion.next))}>
                Speed up to {rateLabel(suggestion.next)}
              </button>
            </div>
          )}
          {suggestion?.kind === 'nailed' && (
            <div className="teach-panel teach-suggest nailed" role="status">
              <strong>Nailed it at full speed! ✨</strong>
              <a className="teach-button primary" href={playRoutineHash(routineId)}>
                Back to the full song
              </a>
            </div>
          )}

          {recent.length > 0 && (
            <div className="teach-panel">
              <span className="teach-label">Your passes</span>
              <ol className="teach-history">
                {recent.map((h, i) => (
                  <li key={st.history.length - recent.length + i} style={{ borderColor: JUDGMENT_STYLE[judge(h.accuracy)].color }}>
                    <b>{pct(h.accuracy)}</b>
                    <span>
                      {rateLabel(h.rate)}
                      {h.segment !== st.segment ? ` · ${segments[h.segment]?.barStart ?? ''}` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {st.source === 'bot' && (
            <button type="button" className="link teach-switch" onClick={click(actions.camera)}>
              Use my camera instead
            </button>
          )}
          {audioError && <p className="error">{audioError}</p>}
        </aside>
      </div>
    </section>
  )
}
