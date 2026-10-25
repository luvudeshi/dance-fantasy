// The game: a lobby (song, difficulty, mode, seed, autoplay, skip calibration) and a
// full-window stage. Flow (game/flow.ts): lobby -> generating (analysis + routine + audio) ->
// calibration (webcam framing + latency) -> warmup (camera ready) -> game (glowing coach,
// cue strip, live per-beat scoring + HUD) -> results. Playback and every visual run on the
// AudioContext clock (src/game/clock.ts). Webcam frames and poses never leave the browser.

import { useEffect, useReducer, useRef, useState, type ChangeEvent } from 'react'
import type { Analysis } from '@shared/analysis'
import type { Difficulty, Mode } from '@shared/routine'
import { ApiError, listSongs, type SongInfo } from '../api'
import { BotPoseSource, type BotSkill } from '../game/botSource'
import CalibrationScreen from '../game/CalibrationScreen'
import { loadCalibration, type Calibration } from '../game/calibration'
import { GameClock } from '../game/clock'
import { flowReducer, needsCalibration } from '../game/flow'
import PlayStage, { type ActiveGame } from '../game/PlayStage'
import ResultsScreen from '../game/ResultsScreen'
import { buildResultsView, type ResultsView } from '../game/results'
import { GameRun } from '../game/run'
import { buildCheckpoints, ScoreKeeper } from '../game/scoring'
import { apiSessionDeps, prepareGame, STEP_LABELS, type PreparedGame, type SessionState, type SongChoice } from '../game/session'
import { DriftMeter, SyncMonitor } from '../game/sync'
import { songTimeAtFromClock, WebcamPoseSource } from '../game/webcamSource'
import { errorMessage, isAbortError } from '../lib/errors'
import { useLatest } from '../lib/useLatest'
import './play.css'

const randomSeed = (): number => Math.floor(Math.random() * 1_000_000)

/** Autoplay dances well but not flawlessly, so a demo shows every judgment. */
const BOT_SKILL: BotSkill = 'good'

const DIFFICULTIES: readonly { value: Difficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
]

const MODES: readonly { value: Mode; label: string }[] = [
  { value: 'standing', label: 'Standing' },
  { value: 'seated', label: 'Seated' },
]

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
}

function songListError(err: unknown): string {
  if (err instanceof ApiError && err.unreachable) return err.message
  return `Couldn't load the song list: ${errorMessage(err)}`
}

const choiceTitle = (c: SongChoice | null): string =>
  !c ? '' : c.kind === 'upload' ? c.file.name.replace(/\.[^.]+$/, '') : (c.title ?? c.file)

function blurFocus(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

interface Camera {
  source: WebcamPoseSource
  offError: () => void
}

export default function Play() {
  // Survives dispose() (the AudioContext is recreated on the next unlock), so StrictMode's
  // mount -> unmount -> mount keeps working with the same instance.
  const [clock] = useState(() => new GameClock())
  const [songs, setSongs] = useState<SongInfo[] | null>(null)
  const [songsError, setSongsError] = useState<string | null>(null)
  const [songsReload, setSongsReload] = useState(0)
  const [choice, setChoice] = useState<SongChoice | null>(null)
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const [mode, setMode] = useState<Mode>('standing')
  const [seed, setSeed] = useState(randomSeed)
  const [autoplay, setAutoplay] = useState(false)
  const [skipCal, setSkipCal] = useState(false)
  const [onStage, setOnStage] = useState(false)
  const [phase, dispatch] = useReducer(flowReducer, 'lobby')
  const [session, setSession] = useState<SessionState>({ status: 'idle' })
  /** The game waiting for calibration / the camera (not playing yet). */
  const [prepared, setPrepared] = useState<PreparedGame | null>(null)
  const [active, setActive] = useState<ActiveGame | null>(null)
  const [results, setResults] = useState<ResultsView | null>(null)
  const [camSource, setCamSource] = useState<WebcamPoseSource | null>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [mirrored, setMirrored] = useState(true)
  const [pip, setPip] = useState(true)
  const [debug, setDebug] = useState(false)
  const sessionRef = useRef<AbortController | null>(null)
  const camRef = useRef<Camera | null>(null)
  /** This visit's calibration (done or skipped); reset in the lobby (a new dancer may step up). */
  const calRef = useRef<Calibration | null>(null)
  /** Bumped on every start / exit: stale async continuations compare and bail. */
  const tokenRef = useRef(0)
  /** tokenRef value whose calibration was already handled (onDone / onSkip fire once). */
  const calibratedTokenRef = useRef(-1)
  /** Whether the current play-through uses the bot (fixed per run; the lobby toggle may change). */
  const playAutoRef = useRef(false)
  const activeRef = useLatest(active)
  const phaseRef = useLatest(phase)

  // --- pose sources ----------------------------------------------------------------------
  const stopCamera = (): void => {
    const cam = camRef.current
    camRef.current = null
    if (cam) {
      cam.offError()
      cam.source.stop()
    }
    setCamSource(null)
  }

  /**
   * Opens the camera + loads the model (one source per visit to the stage). start() is
   * idempotent while starting / running and retries after a failure (also one the
   * calibration screen retried itself), so every caller gets the live state.
   */
  const ensureCamera = (): Promise<void> => {
    let cam = camRef.current
    if (!cam) {
      const cal = calRef.current ?? loadCalibration()
      const source = new WebcamPoseSource({ songTimeAt: songTimeAtFromClock(clock), latencySec: cal.latencySec })
      const created: Camera = { source, offError: source.onError((msg) => camRef.current === created && setCamError(msg)) }
      cam = created
      camRef.current = cam
      setCamSource(source)
      setCamError(null)
    }
    const mine = cam
    const ready = mine.source.start()
    ready.catch((err: unknown) => {
      if (camRef.current === mine && !isAbortError(err)) setCamError(errorMessage(err))
    })
    return ready
  }

  /** Stops listening to the current run (and the bot); the webcam stays on. */
  const disposeRun = (): void => {
    const run = activeRef.current?.run
    if (!run) return
    run.dispose()
    if (run.source.kind === 'bot') run.source.stop()
  }

  // --- lifecycle -----------------------------------------------------------------------
  // At most one AudioContext, closed on unmount (stops audio, frees the decoded song); the
  // camera is released too.
  const unmountRef = useLatest(() => {
    sessionRef.current?.abort()
    sessionRef.current = null
    tokenRef.current++
    disposeRun()
    const cam = camRef.current
    camRef.current = null
    cam?.offError()
    cam?.source.stop()
    clock.dispose()
  })
  useEffect(() => () => unmountRef.current(), [unmountRef])

  /** The song ended: close the last windows, show the results, release the camera. */
  const finishRef = useLatest((): void => {
    setPaused(false)
    const a = activeRef.current
    const run = a?.run
    if (!a || !run || phaseRef.current !== 'game') return
    const summary = run.finish(a.game.routine, a.game.durationSec)
    console.log(a.monitor.summary())
    setResults(buildResultsView(summary, run.keeper.results(), a.game.routine))
    if (run.source.kind === 'bot') run.source.stop()
    stopCamera()
    dispatch({ type: 'finished' })
  })
  useEffect(() => {
    clock.setOnEnded(() => finishRef.current())
    return () => clock.setOnEnded(null)
  }, [clock, finishRef])

  // Automation hook for sync checks.
  useEffect(() => {
    window.__midnightSync = {
      stats: () => activeRef.current?.monitor.stats() ?? new DriftMeter().stats(),
      reset: () => activeRef.current?.monitor.reset(),
    }
    return () => {
      delete window.__midnightSync
    }
  }, [activeRef])

  useEffect(() => {
    const ac = new AbortController()
    listSongs(ac.signal).then(
      (list) => {
        setSongs(list)
        setSongsError(null)
        const first = list[0]
        setChoice((cur) => cur ?? (first ? { kind: 'library', file: first.file, title: first.title } : null))
      },
      (err: unknown) => {
        if (!isAbortError(err)) setSongsError(songListError(err))
      },
    )
    return () => ac.abort()
  }, [songsReload])

  // No page scroll behind the full-window stage.
  useEffect(() => {
    if (!onStage) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [onStage])

  // --- game flow -----------------------------------------------------------------------
  /** Starts a scored play-through of `game` (count-in first). The pose source must be ready. */
  const begin = (game: PreparedGame): void => {
    const auto = playAutoRef.current
    const cam = camRef.current
    if (!auto && !cam) return
    disposeRun()
    const bot = auto ? new BotPoseSource({ track: game.track, skill: BOT_SKILL, seed: game.routine.seed }) : null
    if (bot) void bot.start()
    const source = bot ?? cam?.source
    if (!source) return
    const keeper = new ScoreKeeper(buildCheckpoints(game.routine, game.routine.mode))
    const run = new GameRun({ keeper, source, bot, isPlaying: () => clock.playing })
    setActive({ game, monitor: new SyncMonitor(game.routine.song.beats), run })
    setPrepared(null)
    setPaused(false)
    dispatch({ type: 'ready' })
    clock.play(-game.timeline.countdown.preRollSec, game.timeline.countInClicks)
  }

  /** Waits for the camera (no wait for the bot), then begins. Camera errors show an overlay. */
  const warmup = async (game: PreparedGame): Promise<void> => {
    const token = tokenRef.current
    if (!playAutoRef.current) {
      try {
        await ensureCamera()
      } catch {
        return // camError is on screen
      }
    }
    if (tokenRef.current === token) begin(game)
  }

  /** Must run inside a click / key handler: it unlocks audio for the autoplay policy. */
  const start = (opts: { seed?: number; reuse?: Analysis } = {}): void => {
    if (!choice) return
    clock.unlock()
    clock.stop()
    sessionRef.current?.abort()
    const ac = new AbortController()
    sessionRef.current = ac
    tokenRef.current++
    disposeRun()
    blurFocus()
    const auto = autoplay
    playAutoRef.current = auto
    setOnStage(true)
    setActive(null)
    setPrepared(null)
    setResults(null)
    setPaused(false)
    setCamError(null)
    dispatch({ type: 'generate' })
    // Open the camera and load the model while the song is analyzed.
    if (auto) stopCamera()
    else void ensureCamera().catch(() => undefined)
    const step = opts.reuse ? 'choreographing' : 'analyzing'
    setSession({ status: 'loading', step, label: STEP_LABELS[step] })
    const req = { song: choice, difficulty, mode, seed: opts.seed ?? seed }
    void prepareGame(req, apiSessionDeps(clock), setSession, ac.signal, { analysis: opts.reuse }).then((game) => {
      if (!game || sessionRef.current !== ac) return
      setPrepared(game)
      const calibrate = needsCalibration({ autoplay: auto, skipCalibration: skipCal, calibrated: calRef.current !== null })
      dispatch({ type: 'prepared', calibrate })
      if (!calibrate) void warmup(game)
    })
  }

  /** CalibrationScreen finished (or was skipped: then the saved / default calibration). */
  const onCalibrated = (cal: Calibration): void => {
    if (phaseRef.current !== 'calibration' || !prepared || calibratedTokenRef.current === tokenRef.current) return
    calibratedTokenRef.current = tokenRef.current
    calRef.current = cal
    camRef.current?.source.setLatency(cal.latencySec)
    setCamError(null) // the calibration screen may have retried the camera successfully
    dispatch({ type: 'calibrated' })
    void warmup(prepared)
  }
  const skipCalibration = (): void => onCalibrated(loadCalibration())

  /** R: same routine from the top; the pose source stays on. */
  const restart = (): void => {
    if (!active || phase !== 'game') return
    clock.unlock()
    begin(active.game)
  }

  /** Results -> the same routine again (the camera reopens; same calibration). */
  const playAgain = (): void => {
    const game = active?.game
    if (!game) return
    clock.unlock()
    tokenRef.current++
    disposeRun()
    setResults(null)
    setActive(null)
    setPrepared(game)
    setCamError(null)
    dispatch({ type: 'replay' })
    void warmup(game)
  }

  /** Camera failed: retry it. */
  const retryCamera = (): void => {
    stopCamera()
    setCamError(null)
    if (phase === 'warmup' && prepared) void warmup(prepared)
    else void ensureCamera().catch(() => undefined)
  }

  /** Camera failed (or none): let the bot dance this one. */
  const switchToAutoplay = (): void => {
    stopCamera()
    setCamError(null)
    setAutoplay(true)
    playAutoRef.current = true
    if (!prepared) return
    clock.unlock()
    if (phase === 'calibration') dispatch({ type: 'calibrated' })
    begin(prepared)
  }

  const togglePause = (): void => {
    if (!active || phase !== 'game') return
    if (clock.playing) {
      clock.pause()
      setPaused(true)
    } else {
      clock.resume()
      setPaused(false)
    }
  }

  const newRoutine = (): void => {
    const s = randomSeed()
    setSeed(s)
    start({ seed: s, reuse: (active?.game ?? prepared)?.analysis })
  }

  const exitToLobby = (): void => {
    sessionRef.current?.abort()
    sessionRef.current = null
    tokenRef.current++
    clock.stop()
    disposeRun()
    stopCamera()
    calRef.current = null
    setActive(null)
    setPrepared(null)
    setResults(null)
    setCamError(null)
    setSession({ status: 'idle' })
    setPaused(false)
    setOnStage(false)
    dispatch({ type: 'exit' })
  }

  const onKey = useLatest((e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const onControl = e.target instanceof Element && e.target.closest('button, input, select, textarea, a') !== null
    switch (e.key) {
      case ' ':
        if (onControl || phase !== 'game') return
        e.preventDefault()
        if (!e.repeat) togglePause()
        break
      case 'Escape':
        e.preventDefault()
        exitToLobby()
        break
      case 'r':
      case 'R':
        if (!e.repeat) restart()
        break
      case 'm':
      case 'M':
        if (!e.repeat) setMirrored((m) => !m)
        break
      case 'c':
      case 'C':
        if (!e.repeat) setPip((p) => !p)
        break
      case 'd':
      case 'D':
        if (!e.repeat) setDebug((d) => !d)
        break
    }
  })
  useEffect(() => {
    if (!onStage) return
    const handler = (e: KeyboardEvent): void => onKey.current(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onStage, onKey])

  // --- lobby input ---------------------------------------------------------------------
  const onUpload = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = '' // picking the same file again still fires
    if (file) setChoice({ kind: 'upload', file })
  }

  // --- render --------------------------------------------------------------------------
  const shown = active?.game ?? prepared
  const routine = shown?.routine
  const stageTitle = shown ? shown.analysis.title : choiceTitle(choice)
  const stageSubtitle = routine
    ? `${routine.difficulty} · ${routine.mode} · seed ${routine.seed}`
    : `${difficulty} · ${mode} · seed ${seed}`
  // The calibration screen shows camera errors itself (with a retry); warmup needs this overlay.
  const camTrouble = camError !== null && phase === 'warmup'

  return (
    <section className="play-lobby">
      {/* inert while the stage covers it: no tabbing into hidden lobby controls. */}
      <div inert={onStage}>
      <div className="lobby-hero">
        <p className="lobby-kicker">The Twelve Dancing Princesses</p>
        <h2 className="lobby-title">The Midnight Ball</h2>
        <p className="lobby-sub">
          Every night the princesses slip away to dance until their slippers wear through. Pick a song, follow the glowing
          dancer like a mirror, and keep up until the clock strikes the final beat.
        </p>
      </div>

      <div className="lobby-grid">
        <div className="lobby-card">
          <h3>
            <span className="step">1</span> Choose your song
          </h3>
          {songsError && (
            <p className="error">
              {songsError}{' '}
              <button type="button" className="link" onClick={() => setSongsReload((n) => n + 1)}>
                Retry
              </button>
            </p>
          )}
          <div className="song-list" role="listbox" aria-label="Songs">
            {songs === null && !songsError && <p className="status">Tuning the orchestra…</p>}
            {songs?.length === 0 && <p className="status">No songs in assets/songs/ yet: upload one below.</p>}
            {songs?.map((s) => {
              const selected = choice?.kind === 'library' && choice.file === s.file
              return (
                <button
                  key={s.file}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`song-item${selected ? ' selected' : ''}`}
                  onClick={() => setChoice({ kind: 'library', file: s.file, title: s.title })}
                >
                  <span className="song-note" aria-hidden="true">
                    ♪
                  </span>
                  <span className="song-name">{s.title}</span>
                  <span className="song-size">{formatBytes(s.sizeBytes)}</span>
                </button>
              )
            })}
          </div>
          <label className={`upload-tile${choice?.kind === 'upload' ? ' selected' : ''}`}>
            <input type="file" accept="audio/*" onChange={onUpload} />
            <span className="upload-icon" aria-hidden="true">
              ⬆
            </span>
            {choice?.kind === 'upload' ? (
              <span>
                <strong>{choice.file.name}</strong>
                <span className="dim"> · {formatBytes(choice.file.size)} · click to change</span>
              </span>
            ) : (
              <span>
                <strong>Upload your own song</strong>
                <span className="dim"> · mp3, wav, ogg…</span>
              </span>
            )}
          </label>
        </div>

        <div className="lobby-card">
          <h3>
            <span className="step">2</span> Set the floor
          </h3>
          <div className="field">
            <span className="field-label">Difficulty</span>
            <div className="segmented" role="radiogroup" aria-label="Difficulty">
              {DIFFICULTIES.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={difficulty === d.value}
                  className={difficulty === d.value ? 'on' : undefined}
                  onClick={() => setDifficulty(d.value)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Mode</span>
            <div className="segmented" role="radiogroup" aria-label="Mode">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.value}
                  className={mode === m.value ? 'on' : undefined}
                  onClick={() => setMode(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="play-seed">
              Seed
            </label>
            <div className="seed-row">
              <input
                id="play-seed"
                type="number"
                step={1}
                value={seed}
                onChange={(e) => setSeed(Math.trunc(Number(e.target.value)) || 0)}
              />
              <button type="button" onClick={() => setSeed(randomSeed())} title="A different routine for the same song">
                🎲 New seed
              </button>
            </div>
          </div>
          <div className="field lobby-toggles">
            <label className="toggle">
              <input type="checkbox" checked={autoplay} onChange={(e) => setAutoplay(e.target.checked)} />
              <span>
                Autoplay (bot) <span className="dim">· no camera, for demos</span>
              </span>
            </label>
            <label className={`toggle${autoplay ? ' disabled' : ''}`}>
              <input type="checkbox" checked={skipCal} disabled={autoplay} onChange={(e) => setSkipCal(e.target.checked)} />
              <span>
                Skip calibration <span className="dim">· use the saved timing</span>
              </span>
            </label>
          </div>
          <button type="button" className="start-button" disabled={!choice} onClick={() => start()}>
            ▶ Start the ball
          </button>
          <p className="hint lobby-keys">
            {autoplay ? 'The bot dances, you watch.' : 'Your camera stays on this device: no video ever leaves the browser.'}
            <br />
            Space pause · R restart · M mirror · C camera · K skip calibration · D debug · Esc back here
          </p>
        </div>
      </div>
      </div>

      {onStage && (
        <PlayStage
          clock={clock}
          active={active}
          mirrored={mirrored}
          debug={debug}
          pip={pip}
          paused={paused}
          title={stageTitle}
          subtitle={stageSubtitle}
          onTogglePause={togglePause}
          onExit={exitToLobby}
        >
          {session.status === 'loading' && (
            <div className="play-overlay">
              <div className="play-card loading">
                <div className="slipper-spinner" aria-hidden="true" />
                <p className="play-loading-label" aria-live="polite">
                  {session.label}
                </p>
                <button type="button" onClick={exitToLobby}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {session.status === 'error' && (
            <div className="play-overlay">
              <div className="play-card">
                <h2>The clock struck twelve too soon</h2>
                <p className="error">{session.message}</p>
                <div className="play-card-actions">
                  <button type="button" className="primary" onClick={() => start()}>
                    Try again
                  </button>
                  <button type="button" onClick={exitToLobby}>
                    Back to the lobby
                  </button>
                </div>
              </div>
            </div>
          )}
          {phase === 'calibration' && camSource && routine && (
            <>
              {/* K inside the calibration screen calls onSkip. */}
              <CalibrationScreen
                source={camSource}
                mode={routine.mode}
                clock={clock}
                onDone={onCalibrated}
                onSkip={skipCalibration}
                cameraErrorActions={
                  <>
                    <button type="button" onClick={switchToAutoplay}>
                      🤖 No camera? Let the bot dance
                    </button>
                    <button type="button" onClick={exitToLobby}>
                      Lobby
                    </button>
                  </>
                }
              />
            </>
          )}
          {phase === 'warmup' && !camTrouble && (
            <div className="play-overlay">
              <div className="play-card loading">
                <div className="slipper-spinner" aria-hidden="true" />
                <p className="play-loading-label" aria-live="polite">
                  Waking the magic mirror…
                </p>
                <button type="button" onClick={exitToLobby}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {camTrouble && (
            <div className="play-overlay dim-bg">
              <div className="play-card">
                <h2>The magic mirror stayed dark</h2>
                <p className="error">{camError}</p>
                <div className="play-card-actions">
                  <button type="button" className="primary" onClick={retryCamera}>
                    Try the camera again
                  </button>
                  <button type="button" onClick={switchToAutoplay}>
                    🤖 Let the bot dance
                  </button>
                  <button type="button" onClick={exitToLobby}>
                    Lobby
                  </button>
                </div>
              </div>
            </div>
          )}
          {paused && phase === 'game' && (
            <div className="play-overlay dim-bg">
              <div className="play-card">
                <h2>Paused</h2>
                <p className="dim">The music waits for you. Press Space to dance on.</p>
                <div className="play-card-actions">
                  <button type="button" className="primary" onClick={togglePause}>
                    ▶ Resume
                  </button>
                  <button type="button" onClick={restart}>
                    Restart
                  </button>
                </div>
              </div>
            </div>
          )}
          {phase === 'results' && results && active && (
            <ResultsScreen
              view={results}
              moves={active.game.routine.moves}
              mirrored={mirrored}
              autoplay={active.run?.source.kind === 'bot'}
              onPlayAgain={playAgain}
              onNewRoutine={newRoutine}
              onLobby={exitToLobby}
            />
          )}
        </PlayStage>
      )}
    </section>
  )
}
