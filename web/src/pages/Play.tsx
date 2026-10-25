// The game: a lobby (song, difficulty, mode, seed, "before the ball", autoplay, skip
// calibration, "Your routines") and a full-window stage. Flow (game/flow.ts): lobby ->
// generating (analysis + routine + audio) -> calibration (webcam framing + latency) -> warmup
// (camera ready) -> game (glowing coach, cue strip, live per-beat scoring + HUD) -> results,
// optionally with a preview (Watch first) or a practice run before the real round. A routine
// can also come from "#/play?routine=<id>" (the Studio's "Play this routine") or the shelf;
// "Learn it first" / "Practice your hardest move" / the shelf's Learn open "#/teach?routine=<id>".
// Judging strictness (game/judging.ts) and sound effects (game/sfx.ts, S) are lobby settings
// remembered on this device. Playback and every visual run on the AudioContext clock
// (src/game/clock.ts). Webcam frames and poses never leave the browser; the optional session
// log (game/sessionLog.ts) holds numbers only and is saved only when downloaded.

import { useEffect, useReducer, useRef, useState, type ChangeEvent } from 'react'
import type { Difficulty, Mode } from '@shared/routine'
import { ApiError, listSongs, type SongInfo } from '../api'
import { BotPoseSource, type BotSkill } from '../game/botSource'
import CalibrationScreen from '../game/CalibrationScreen'
import { loadCalibration, type Calibration } from '../game/calibration'
import { GameClock } from '../game/clock'
import { flowReducer, isRunning, needsCalibration, teachHash, type Phase } from '../game/flow'
import { JUDGING_PRESETS, judgingLabel, loadJudging, saveJudging, scoringFor, type JudgingPreset } from '../game/judging'
import PlayStage, { type ActiveGame } from '../game/PlayStage'
import type { PoseSource } from '../game/poseSource'
import { barSeekTarget, effectiveRehearsal, loadRehearsal, REHEARSALS, saveRehearsal, type Rehearsal } from '../game/rehearsal'
import ResultsScreen from '../game/ResultsScreen'
import { useAnnouncer } from '../announcer/announcer'
import { HeraldBubble } from '../announcer/Herald'
import { SignatureCard } from '../signature/SignatureCard'
import { buildResultsView, roundDetails, type ResultsView } from '../game/results'
import {
  forgetRoutine,
  loadShelf,
  recipeOf,
  relativeTime,
  rememberRoutine,
  SHELF_KEY,
  shelfEntryFor,
  type ShelfEntry,
} from '../game/routineShelf'
import { GameRun } from '../game/run'
import { buildCheckpoints, ScoreKeeper, type ScoringConfig } from '../game/scoring'
import {
  apiSessionDeps,
  prepareFromRecipe,
  prepareFromRoutine,
  prepareGame,
  routineFor,
  STEP_LABELS,
  type PreparedGame,
  type RoutineRecipe,
  type SessionDeps,
  type SessionState,
  type SessionStep,
  type SongChoice,
} from '../game/session'
import { buildSessionLog, downloadSessionLog, type SessionLog } from '../game/sessionLog'
import { countdownSfx, judgmentSfx, loadSfxEnabled, saveSfxEnabled, Sfx } from '../game/sfx'
import { DriftMeter, SyncMonitor } from '../game/sync'
import { songTimeAtFromClock, WebcamPoseSource } from '../game/webcamSource'
import { errorMessage, isAbortError } from '../lib/errors'
import { isRoutineId, routineFromHash } from '../lib/hashRoute'
import { useLatest } from '../lib/useLatest'
import { finishRoomRound, roomRoundFor, useRoomReporter, waitForRoomStart } from '../rooms/gameLink'
import RoomLeaderboard from '../rooms/RoomLeaderboard'
import { getSettings } from '../settings'
import { Corners } from '../theme/components'
import { Icon } from '../theme/Icon'
import type { IconName } from '../theme/icons'
import { PauseMenu } from '../theme/screens/PauseMenu'
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

const START_LABEL: Readonly<Record<Rehearsal, string>> = {
  none: 'Start the ball',
  watch: 'Watch, then dance',
  practice: 'Practice, then dance',
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
}

function songListError(err: unknown): string {
  if (err instanceof ApiError && err.unreachable) return err.message
  return `Couldn't load the song list: ${errorMessage(err)}`
}

const choiceTitle = (c: SongChoice | null): string =>
  !c ? '' : c.kind === 'upload' ? c.file.name.replace(/\.[^.]+$/, '') : (c.title ?? c.file)

const setupLabel = (s: { difficulty: Difficulty; mode: Mode; seed: number }): string => `${s.difficulty} · ${s.mode} · seed ${s.seed}`

function blurFocus(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

/** Audio may only start after the page saw a click / key (autoplay policy). */
const pageWasActivated = (): boolean => navigator.userActivation?.hasBeenActive ?? true

const isRehearsing = (p: Phase): boolean => p === 'preview' || p === 'practice'

/** Tells listeners in this tab (the app shell's Learn link) that the shelf changed. */
const notifyShelf = (): void => {
  window.dispatchEvent(new StorageEvent('storage', { key: SHELF_KEY }))
}

const HOW_TO_PLAY: readonly { icon: IconName; title: string; text: string }[] = [
  { icon: 'mirror-cam', title: 'Step back', text: 'Head to toe in the camera (or sit, in Seated mode).' },
  { icon: 'dance-shoe', title: 'Mirror the dancer', text: 'Copy the glowing coach; the cards below show what’s next.' },
  { icon: 'music-note', title: 'Hit the beat', text: 'Land each pose on the beat for PERFECT and keep the combo.' },
]

const KEY_HINTS: readonly [string, string][] = [
  ['Space', 'pause'],
  ['R', 'restart'],
  ['M', 'mirror'],
  ['C', 'camera'],
  ['S', 'sound'],
  ['K', 'skip calibration'],
  ['Esc', 'back here'],
]

/** What a scored round used (fixed when it starts): for the results line and the session log. */
interface RoundMeta {
  preset: JudgingPreset
  config: ScoringConfig
  /** null for the bot. */
  calibration: Calibration | null
  auto: boolean
}

interface Camera {
  source: WebcamPoseSource
  offError: () => void
}

/** One way of getting a game ready (song + settings, a saved routine, a recipe). */
interface Launch {
  load: (deps: SessionDeps, onState: (s: SessionState) => void, signal: AbortSignal) => Promise<PreparedGame | null>
  firstStep: SessionStep
  title: string
  subtitle: string
  /** a saved routine (a room round plays one: no rehearsal, no calibration) */
  routineId?: string
}

export default function Play() {
  // Survives dispose() (the AudioContext is recreated on the next unlock), so StrictMode's
  // mount -> unmount -> mount keeps working with the same instance.
  const [clock] = useState(() => new GameClock())
  const [songs, setSongs] = useState<SongInfo[] | null>(null)
  const [songsError, setSongsError] = useState<string | null>(null)
  const [songsReload, setSongsReload] = useState(0)
  const [choice, setChoice] = useState<SongChoice | null>(null)
  const [difficulty, setDifficulty] = useState<Difficulty>(() => getSettings().difficulty)
  const [mode, setMode] = useState<Mode>(() => getSettings().mode)
  const [seed, setSeed] = useState(randomSeed)
  const [autoplay, setAutoplay] = useState(false)
  const [skipCal, setSkipCal] = useState(false)
  /** The lobby's "Before the ball" (remembered on this device). */
  const [rehearsal, setRehearsal] = useState<Rehearsal>(() => loadRehearsal())
  /** This stage visit's rehearsal (fixed at start; a failed practice camera may fall back to watching). */
  const [runRehearsal, setRunRehearsal] = useState<Rehearsal>('none')
  const [shelf, setShelf] = useState<ShelfEntry[]>(() => loadShelf())
  /** "5 min ago" reference time (ticks while the page is open). */
  const [nowMs, setNowMs] = useState(() => Date.now())
  /** A "#/play?routine=<id>" deep link waiting for a click (no user activation yet). */
  const [linked, setLinked] = useState<string | null>(() => routineFromHash(window.location.hash))
  /** Title / setup shown on the stage while a game loads. */
  const [pending, setPending] = useState<{ title: string; subtitle: string } | null>(null)
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
  const [mirrored, setMirrored] = useState(() => getSettings().mirror)
  const [pip, setPip] = useState(() => getSettings().cameraWindow)
  const [debug, setDebug] = useState(() => getSettings().debugOverlay)
  /** Lobby: judging strictness (remembered on this device). */
  const [judging, setJudging] = useState<JudgingPreset>(() => loadJudging())
  /** Sound effects for camera games (remembered); autoplay runs use autoSfx (off until S). */
  const [sfxOn, setSfxOn] = useState(() => loadSfxEnabled())
  const [autoSfx, setAutoSfx] = useState(false)
  const [sfx] = useState(() => new Sfx(() => clock.context))
  const announcer = useAnnouncer()
  /** "Learn it first": the step label while the routine is generated, then an error if any. */
  const [learnBusy, setLearnBusy] = useState<string | null>(null)
  const [learnError, setLearnError] = useState<string | null>(null)
  /** The finished round's details line + session log. */
  const [round, setRound] = useState<{ details: string; log: SessionLog } | null>(null)
  const sessionRef = useRef<AbortController | null>(null)
  const learnRef = useRef<AbortController | null>(null)
  const roundMetaRef = useRef<RoundMeta | null>(null)
  const camRef = useRef<Camera | null>(null)
  /** This visit's calibration (done or skipped); reset in the lobby (a new dancer may step up). */
  const calRef = useRef<Calibration | null>(null)
  /** Bumped on every start / exit: stale async continuations compare and bail. */
  const tokenRef = useRef(0)
  /** tokenRef value whose calibration was already handled (onDone / onSkip fire once). */
  const calibratedTokenRef = useRef(-1)
  /** Whether the current play-through uses the bot (fixed per run; the lobby toggle may change). */
  const playAutoRef = useRef(false)
  /** Whether the next begin() starts a practice run (no score) rather than the real game. */
  const practiceNextRef = useRef(false)
  /** The last launch, for "Try again". */
  const lastLaunchRef = useRef<Launch | null>(null)
  const activeRef = useLatest(active)
  const phaseRef = useLatest(phase)
  /** Sound for the current stage run: autoplay runs only when toggled on with S. */
  const soundOn = autoplay ? autoSfx : sfxOn
  const soundOnRef = useLatest(soundOn)
  const judgingRef = useLatest(judging)
  const inRoom = roomRoundFor(active?.game.routine.meta?.routineId) !== null // no R / Restart: it would desync the round
  useRoomReporter(active?.game.routine.meta?.routineId, () => {
    const a = activeRef.current
    return a?.run && phaseRef.current === 'game' ? { keeper: a.run.keeper, songTime: clock.songTime(), durationSec: a.game.durationSec } : null
  })

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

  /** A scored run of `game` on the bot or the camera; `fromT` drops earlier checkpoints (a seek). */
  const createRun = (game: PreparedGame, auto: boolean, cam: PoseSource | null, fromT = Number.NEGATIVE_INFINITY): GameRun | null => {
    const bot = auto ? new BotPoseSource({ track: game.track, skill: BOT_SKILL, seed: game.routine.seed }) : null
    if (bot) void bot.start()
    const source = bot ?? cam
    if (!source) return null
    const checkpoints = buildCheckpoints(game.routine, game.routine.mode).filter((cp) => cp.time >= fromT)
    const config = scoringFor(judgingRef.current)
    return new GameRun({
      keeper: new ScoreKeeper(checkpoints, config),
      source,
      bot,
      isPlaying: () => clock.playing,
      onResults: (rs, comboBefore) => {
        if (!isRehearsing(phaseRef.current)) announcer.onResults(rs, comboBefore)
        if (!soundOnRef.current) return
        for (const name of judgmentSfx(rs, comboBefore)) sfx.play(name)
      },
    })
  }

  /** (Re)schedules the count-in ticks + "go" from the current song position (after play / resume / seek). */
  const armCountdown = (game: PreparedGame): void => {
    sfx.cancelScheduled()
    if (!soundOnRef.current || !clock.playing) return
    sfx.schedule(countdownSfx(game.timeline.countdown, game.timeline.countInClicks, clock.songTime()), clock.startAt)
  }

  // --- lifecycle -----------------------------------------------------------------------
  // At most one AudioContext, closed on unmount (stops audio, frees the decoded song); the
  // camera is released too.
  const unmountRef = useLatest(() => {
    sessionRef.current?.abort()
    sessionRef.current = null
    learnRef.current?.abort()
    sfx.cancelScheduled()
    tokenRef.current++
    disposeRun()
    const cam = camRef.current
    camRef.current = null
    cam?.offError()
    cam?.source.stop()
    clock.dispose()
  })
  useEffect(() => () => unmountRef.current(), [unmountRef])

  /** The preview / practice run ended or was skipped: the "Ready to dance?" card (camera stays on). */
  const endRehearsal = (): void => {
    if (!isRehearsing(phaseRef.current)) return
    clock.stop()
    sfx.cancelScheduled()
    disposeRun()
    const a = activeRef.current
    if (a?.run) setActive({ ...a, run: null })
    setPaused(false)
    dispatch({ type: 'rehearsed' })
  }

  /** The song ended: close the last windows, show the results, release the camera. */
  const finishRef = useLatest((): void => {
    setPaused(false)
    if (isRehearsing(phaseRef.current)) {
      endRehearsal()
      return
    }
    const a = activeRef.current
    const run = a?.run
    if (!a || !run || phaseRef.current !== 'game') return
    const summary = run.finish(a.game.routine, a.game.durationSec)
    finishRoomRound(a.game.routine.meta?.routineId, summary)
    console.log(a.monitor.summary())
    const results = run.keeper.results()
    const auto = run.source.kind === 'bot'
    const meta: RoundMeta = roundMetaRef.current ?? { preset: 'standard', config: scoringFor('standard'), calibration: null, auto }
    setResults(buildResultsView(summary, results, a.game.routine, meta.config.thresholds))
    announcer.results(summary)
    setRound({
      details: roundDetails({
        judging: judgingLabel(meta.preset),
        latencySec: meta.calibration?.latencySec ?? null,
        latencySource: meta.calibration?.source,
        autoplay: auto,
      }),
      log: buildSessionLog({
        routine: a.game.routine,
        title: a.game.analysis.title,
        durationSec: a.game.durationSec,
        autoplay: auto,
        calibration: meta.calibration,
        preset: meta.preset,
        config: meta.config,
        summary,
        results,
      }),
    })
    sfx.cancelScheduled()
    if (soundOnRef.current) sfx.play('fanfare')
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

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // The shelf changes in other tabs (e.g. the Analysis tab open elsewhere).
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === SHELF_KEY || e.key === null) setShelf(loadShelf())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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
  /** Starts a play-through of `game` (count-in first): the real game, or a practice run. The pose source must be ready. */
  const begin = (game: PreparedGame): void => {
    const auto = playAutoRef.current
    const practice = practiceNextRef.current && !auto
    const cam = camRef.current
    if (!auto && !cam) return
    disposeRun()
    const run = createRun(game, auto, cam?.source ?? null)
    if (!run) return
    const preset = judgingRef.current
    roundMetaRef.current = { preset, config: scoringFor(preset), calibration: auto ? null : (calRef.current ?? loadCalibration()), auto }
    setActive({ game, monitor: new SyncMonitor(game.routine.song.beats), run, practice })
    setPrepared(null)
    setPaused(false)
    dispatch({ type: 'ready', practice })
    if (!practice) announcer.intro({ songTitle: game.analysis.title, difficulty: game.routine.difficulty })
    clock.play(-game.timeline.countdown.preRollSec, game.timeline.countInClicks)
    armCountdown(game)
  }

  /** Watch first: the coach dances the whole routine to the music; no camera, no scoring. */
  const beginPreview = (game: PreparedGame): void => {
    disposeRun()
    setActive({ game, monitor: new SyncMonitor(game.routine.song.beats), run: null })
    setPrepared(null)
    setPaused(false)
    clock.play(-game.timeline.countdown.preRollSec, game.timeline.countInClicks)
    armCountdown(game)
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
    await waitForRoomStart(game.routine.meta?.routineId)
    if (tokenRef.current === token) begin(game)
  }

  const shelve = (game: PreparedGame): void => {
    const entry = shelfEntryFor(game.routine, game.analysis, 'play')
    if (!entry) return
    setShelf(rememberRoutine(entry))
    notifyShelf()
  }

  /**
   * Gets a game ready and walks it through the flow with the lobby's current toggles. Must run
   * inside a click / key handler (or after one): it unlocks audio for the autoplay policy.
   */
  const launch = (l: Launch): void => {
    clock.unlock()
    clock.stop()
    sfx.cancelScheduled()
    sessionRef.current?.abort()
    const ac = new AbortController()
    sessionRef.current = ac
    tokenRef.current++
    disposeRun()
    blurFocus()
    lastLaunchRef.current = l
    setLinked(null) // a waiting deep link is superseded by whatever starts now
    const auto = autoplay
    playAutoRef.current = auto
    const roomRound = roomRoundFor(l.routineId) !== null
    const reh = roomRound ? 'none' : effectiveRehearsal(rehearsal, auto)
    setRunRehearsal(reh)
    practiceNextRef.current = reh === 'practice'
    setPending({ title: l.title, subtitle: l.subtitle })
    setOnStage(true)
    setActive(null)
    setPrepared(null)
    setResults(null)
    setRound(null)
    setPaused(false)
    setCamError(null)
    dispatch({ type: 'generate' })
    // Open the camera and load the model while the song is analyzed (a preview needs no camera).
    if (auto || reh === 'watch') stopCamera()
    else void ensureCamera().catch(() => undefined)
    setSession({ status: 'loading', step: l.firstStep, label: STEP_LABELS[l.firstStep] })
    void l.load(apiSessionDeps(clock), setSession, ac.signal).then((game) => {
      if (!game || sessionRef.current !== ac) return
      setPrepared(game)
      shelve(game)
      const calibrate = needsCalibration({ autoplay: auto, skipCalibration: skipCal || roomRound, calibrated: calRef.current !== null })
      dispatch({ type: 'prepared', calibrate, rehearsal: reh })
      if (reh === 'watch') beginPreview(game)
      else if (!calibrate) void warmup(game)
    })
  }

  /** Lobby Start: the chosen song + settings. */
  const start = (): void => {
    if (!choice) return
    const req = { song: choice, difficulty, mode, seed }
    launch({ load: (deps, on, signal) => prepareGame(req, deps, on, signal), firstStep: 'analyzing', title: choiceTitle(choice), subtitle: setupLabel(req) })
  }

  /** A saved routine by id (the shelf / a deep link from the Analysis tab). */
  const playRoutine = (routineId: string): void => {
    const entry = shelf.find((e) => e.routineId === routineId) ?? loadShelf().find((e) => e.routineId === routineId)
    const hint = entry ? recipeOf(entry) : undefined
    launch({
      load: (deps, on, signal) => prepareFromRoutine(routineId, deps, on, signal, hint),
      firstStep: 'findingRoutine',
      routineId,
      title: entry?.title ?? 'Your routine',
      subtitle: entry ? setupLabel(entry) : `routine ${routineId}`,
    })
  }

  /** The routine is gone from the server: the same recipe builds it again. */
  const generateAgain = (recipe: RoutineRecipe): void => {
    launch({
      load: (deps, on, signal) => prepareFromRecipe(recipe, deps, on, signal),
      firstStep: 'analyzing',
      title: pending?.title ?? 'Your routine',
      subtitle: setupLabel(recipe),
    })
  }

  const retryLaunch = (): void => {
    const l = lastLaunchRef.current
    if (l) launch(l)
    else start()
  }

  // "#/play?routine=<id>": after a click (from the Analysis tab) start right away; a pasted
  // link waits for a click on the lobby banner. The query is dropped so Esc / reload don't
  // start it again.
  useEffect(() => {
    const onHash = (): void => {
      const id = routineFromHash(window.location.hash)
      if (id) setLinked(id)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const playRoutineRef = useLatest(playRoutine)
  useEffect(() => {
    if (!linked) return
    if (routineFromHash(window.location.hash)) window.history.replaceState(null, '', '#/play')
    if (pageWasActivated()) playRoutineRef.current(linked) // launch() clears `linked`
  }, [linked, playRoutineRef])

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

  /** R: same routine from the top (preview, practice or game); the pose source stays on. */
  const restart = (): void => {
    if (!active || !isRunning(phase)) return
    clock.unlock()
    if (phase === 'preview') beginPreview(active.game)
    else begin(active.game)
  }

  /** ←/→ in a preview / practice run: one bar back / forward. */
  const seekBar = (dir: -1 | 1): void => {
    const a = activeRef.current
    if (!a || !isRehearsing(phase)) return
    const target = barSeekTarget(a.game.routine.song.downbeats, clock.songTime(), dir)
    if (target === null) return
    a.monitor.breakContinuity()
    if (phase === 'practice' && a.run) {
      // Fresh judgments from the new position (no misses for the skipped part).
      disposeRun()
      setActive({ ...a, run: createRun(a.game, false, camRef.current?.source ?? null, target) })
    }
    clock.seek(target)
    armCountdown(a.game)
  }

  /** "Ready to dance?" -> the real round with the same routine (and, after practice, the same camera + calibration). */
  const playForReal = (): void => {
    const game = activeRef.current?.game
    if (!game || phase !== 'ready') return
    clock.unlock()
    tokenRef.current++
    disposeRun()
    practiceNextRef.current = false
    const auto = playAutoRef.current
    const calibrate = needsCalibration({ autoplay: auto, skipCalibration: skipCal, calibrated: calRef.current !== null })
    setActive(null)
    setPrepared(game)
    setPaused(false)
    setCamError(null)
    if (!auto) void ensureCamera().catch(() => undefined)
    dispatch({ type: 'play', calibrate })
    if (!calibrate) void warmup(game)
  }

  /** "Watch again" / "Practice again" from the ready card. */
  const rehearseAgain = (): void => {
    const game = activeRef.current?.game
    if (!game || phase !== 'ready') return
    clock.unlock()
    if (runRehearsal === 'practice') {
      tokenRef.current++
      disposeRun()
      practiceNextRef.current = true
      setActive(null)
      setPrepared(game)
      setCamError(null)
      dispatch({ type: 'replay' })
      void warmup(game)
    } else {
      dispatch({ type: 'watch' })
      beginPreview(game)
    }
  }

  /** Practice camera failed: watch the dance instead (the camera is retried on Play for real). */
  const switchToWatch = (): void => {
    const game = prepared ?? activeRef.current?.game
    if (!game) return
    clock.unlock()
    tokenRef.current++
    stopCamera()
    setCamError(null)
    setRunRehearsal('watch')
    practiceNextRef.current = false
    dispatch({ type: 'watch' })
    beginPreview(game)
  }

  /** Results -> the same routine again (the camera reopens; same calibration). */
  const playAgain = (): void => {
    const game = active?.game
    if (!game) return
    announcer.hush()
    clock.unlock()
    tokenRef.current++
    disposeRun()
    practiceNextRef.current = false
    setResults(null)
    setRound(null)
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

  /** Camera failed (or none): let the bot dance this one (the real round). */
  const switchToAutoplay = (): void => {
    stopCamera()
    setCamError(null)
    setAutoplay(true)
    playAutoRef.current = true
    practiceNextRef.current = false
    if (!prepared) return
    clock.unlock()
    if (phase === 'calibration') dispatch({ type: 'calibrated' })
    begin(prepared)
  }

  const togglePause = (): void => {
    if (!active || !isRunning(phase)) return
    if (clock.playing) {
      clock.pause()
      sfx.cancelScheduled()
      announcer.hush()
      setPaused(true)
    } else {
      clock.resume()
      armCountdown(active.game)
      setPaused(false)
    }
  }

  /** S / the lobby toggle: sound effects on or off (autoplay runs have their own switch). */
  const toggleSound = (): void => {
    const botRun = autoplay && onStage
    const next = botRun ? !autoSfx : !sfxOn
    if (botRun) setAutoSfx(next)
    else {
      setSfxOn(next)
      saveSfxEnabled(next)
    }
    if (!botRun && autoplay) return // the lobby switch while Autoplay is ticked: the bot's sound is unchanged
    soundOnRef.current = next
    const a = activeRef.current
    if (next && a && isRunning(phaseRef.current)) armCountdown(a.game)
    else if (!next) sfx.cancelScheduled()
  }

  const chooseJudging = (j: JudgingPreset): void => {
    setJudging(j)
    saveJudging(j)
  }

  /** Leaves the stage (if on it) for the teach page; Play unmounts and releases everything. */
  const openTeach = (routineId: string, start?: number): void => {
    window.location.hash = teachHash(routineId, start)
  }

  /** "Learn it first": choreograph what Start would play, shelve it, open it on the teach page. */
  const learnFirst = async (): Promise<void> => {
    if (!choice || learnRef.current) return
    const ac = new AbortController()
    learnRef.current = ac
    setLearnError(null)
    setLearnBusy(STEP_LABELS.analyzing)
    try {
      const req = { song: choice, difficulty, mode, seed }
      const { analysis, routine } = await routineFor(req, apiSessionDeps(clock), ac.signal, (step) => setLearnBusy(STEP_LABELS[step]))
      const id = routine.meta?.routineId
      const entry = shelfEntryFor(routine, analysis, 'play')
      if (!entry || !isRoutineId(id)) throw new Error('The server did not return a saved routine id')
      setShelf(rememberRoutine(entry))
      notifyShelf()
      openTeach(id)
    } catch (err) {
      if (!ac.signal.aborted && !isAbortError(err)) setLearnError(errorMessage(err))
    } finally {
      if (learnRef.current === ac) {
        learnRef.current = null
        setLearnBusy(null)
      }
    }
  }

  /** Results -> a new seed for the same song and setup. */
  const newRoutine = (): void => {
    const game = active?.game ?? prepared
    if (!game) return
    const s = randomSeed()
    setSeed(s)
    const recipe: RoutineRecipe = { analysisId: game.analysis.id, difficulty: game.routine.difficulty, mode: game.routine.mode, seed: s }
    launch({
      load: (deps, on, signal) => prepareFromRecipe(recipe, deps, on, signal, { analysis: game.analysis }),
      firstStep: 'choreographing',
      title: game.analysis.title,
      subtitle: setupLabel(recipe),
    })
  }

  const exitToLobby = (): void => {
    announcer.hush()
    sessionRef.current?.abort()
    sessionRef.current = null
    tokenRef.current++
    clock.stop()
    sfx.cancelScheduled()
    disposeRun()
    stopCamera()
    calRef.current = null
    practiceNextRef.current = false
    setActive(null)
    setPrepared(null)
    setResults(null)
    setRound(null)
    setCamError(null)
    setSession({ status: 'idle' })
    setPending(null)
    setPaused(false)
    setOnStage(false)
    dispatch({ type: 'exit' })
  }

  const onKey = useLatest((e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const onControl = e.target instanceof Element && e.target.closest('button, input, select, textarea, a') !== null
    switch (e.key) {
      case ' ':
        if (onControl || !isRunning(phase)) return
        e.preventDefault()
        if (!e.repeat) togglePause()
        break
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onControl || !isRehearsing(phase)) return
        e.preventDefault()
        seekBar(e.key === 'ArrowLeft' ? -1 : 1)
        break
      case 'Escape':
        e.preventDefault()
        exitToLobby()
        break
      case 'r':
      case 'R':
        if (!e.repeat && !inRoom) restart()
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
      case 's':
      case 'S':
        if (!e.repeat) toggleSound()
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

  const chooseRehearsal = (r: Rehearsal): void => {
    setRehearsal(r)
    saveRehearsal(r)
  }

  const startLinked = (): void => {
    if (linked) playRoutine(linked)
  }

  // --- render --------------------------------------------------------------------------
  const shown = active?.game ?? prepared
  const routine = shown?.routine
  const stageTitle = shown ? shown.analysis.title : (pending?.title ?? choiceTitle(choice))
  const stageSubtitle = routine ? setupLabel(routine) : (pending?.subtitle ?? setupLabel({ difficulty, mode, seed }))
  // The calibration screen shows camera errors itself (with a retry); warmup needs this overlay.
  const camTrouble = camError !== null && phase === 'warmup'
  const rehearsalHint =
    autoplay && rehearsal === 'practice'
      ? 'The bot can’t practice for you: you’ll watch the dance first.'
      : REHEARSALS.find((r) => r.value === rehearsal)?.hint
  const linkedEntry = linked ? shelf.find((e) => e.routineId === linked) : undefined
  const stageKeys = isRehearsing(phase)
    ? `Space pause · ←/→ one bar · R restart · M mirror${phase === 'practice' ? ' · C camera' : ''} · S sound (${soundOn ? 'on' : 'off'}) · Esc lobby`
    : undefined
  const goneRecipe = session.status === 'error' ? session.recipe : undefined
  const judgingHint = JUDGING_PRESETS.find((j) => j.value === judging)?.hint
  const shownId = active?.game.routine.meta?.routineId
  const hardestIndex = results?.hardest?.moveIndex
  const practiceHardest =
    isRoutineId(shownId) && hardestIndex !== undefined ? () => openTeach(shownId, hardestIndex) : undefined
  const roundLog = round?.log
  const watchInstead =
    runRehearsal === 'practice' ? (
      <button type="button" onClick={switchToWatch}>
        Just watch it first
      </button>
    ) : null

  return (
    <section className="play-lobby df-screen">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      {/* inert while the stage covers it: no tabbing into hidden lobby controls. */}
      <div inert={onStage}>
      <div className="lobby-hero">
        <p className="lobby-kicker">The Twelve Dancing Princesses</p>
        <h2 className="lobby-title">Dance Fantasy</h2>
        <p className="lobby-sub">
          Every night the princesses slip away to dance until their slippers wear through. Pick a song, follow the glowing
          dancer like a mirror, and keep up until the clock strikes the final beat.
        </p>
        <ol className="how-to-play" aria-label="How to play">
          {HOW_TO_PLAY.map((h, i) => (
            <li key={h.title}>
              <span className="how-icon" aria-hidden="true">
                <Icon name={h.icon} size="sm" cut="sm" />
              </span>
              <span>
                <strong>
                  {i + 1}. {h.title}
                </strong>
                <span className="how-text">{h.text}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      {linked && (
        <div className="lobby-card linked-banner">
          <div>
            <strong>A routine is waiting for you</strong>
            <span className="dim">
              {' '}
              · {linkedEntry ? `${linkedEntry.title} · ${setupLabel(linkedEntry)}` : `routine ${linked}`}
            </span>
          </div>
          <div className="linked-actions">
            <button type="button" className="primary" onClick={startLinked}>
              ▶ Dance it
            </button>
            <button type="button" onClick={() => setLinked(null)}>
              Not now
            </button>
          </div>
        </div>
      )}

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
                    <Icon name="music-note" size={36} cut="sm" />
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
              <Icon name="upload" size={40} cut="sm" />
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
          {choice?.kind === 'library' && <SignatureCard className="lobby-signature" title={choiceTitle(choice)} />}
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
                New seed
              </button>
            </div>
          </div>
          <div className="field">
            <span className="field-label">Before the ball</span>
            <div className="segmented" role="radiogroup" aria-label="Before the ball">
              {REHEARSALS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  role="radio"
                  aria-checked={rehearsal === r.value}
                  className={rehearsal === r.value ? 'on' : undefined}
                  onClick={() => chooseRehearsal(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <span className="hint rehearsal-hint">{rehearsalHint}</span>
          </div>
          <div className="field">
            <span className="field-label">Judging</span>
            <div className="segmented" role="radiogroup" aria-label="Judging">
              {JUDGING_PRESETS.map((j) => (
                <button
                  key={j.value}
                  type="button"
                  role="radio"
                  aria-checked={judging === j.value}
                  className={judging === j.value ? 'on' : undefined}
                  onClick={() => chooseJudging(j.value)}
                >
                  {j.label}
                </button>
              ))}
            </div>
            <span className="hint rehearsal-hint">{judgingHint}</span>
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
            <label className="toggle">
              <input type="checkbox" checked={sfxOn} onChange={toggleSound} />
              <span>
                Sound effects <span className="dim">· S on stage{autoplay ? ' (off for the bot until you press S)' : ''}</span>
              </span>
            </label>
          </div>
          <button type="button" className="start-button" disabled={!choice} onClick={start}>
            <Icon name="sparkles" size="xs" cut="none" />
            {START_LABEL[effectiveRehearsal(rehearsal, autoplay)]}
          </button>
          <button
            type="button"
            className="learn-button"
            disabled={!choice || learnBusy !== null}
            onClick={() => void learnFirst()}
            title="Step through this routine move by move, at your own pace"
          >
            {learnBusy ?? (
              <>
                <Icon name="storybook" size="xs" cut="none" /> Learn it first
              </>
            )}
          </button>
          {learnError && <p className="error">{learnError}</p>}
          <p className="hint lobby-privacy">
            {autoplay ? 'The bot dances, you watch.' : 'Your camera stays on this device: no video ever leaves the browser.'}
          </p>
          <ul className="key-hints" aria-label="Keyboard shortcuts">
            {KEY_HINTS.map(([k, what]) => (
              <li key={k}>
                <kbd>{k}</kbd> {what}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {shelf.length > 0 && (
        <div className="lobby-card shelf-card">
          <h3>
            <span className="step">
              <Icon name="crown" size={30} cut="none" />
            </span>{' '}
            Your routines
          </h3>
          <ul className="shelf-list">
            {shelf.map((e) => (
              <li key={e.routineId} className="shelf-item">
                <div className="shelf-info">
                  <span className="shelf-title">
                    {e.title}
                    {e.artist && <span className="dim"> · {e.artist}</span>}
                  </span>
                  <span className="shelf-meta">
                    {setupLabel(e)} · {e.moves} moves · {e.from === 'analysis' ? 'from Studio' : 'played'} ·{' '}
                    {relativeTime(e.createdAt, nowMs)}
                  </span>
                </div>
                <button type="button" className="primary" onClick={() => playRoutine(e.routineId)}>
                  ▶ Play
                </button>
                <button type="button" onClick={() => openTeach(e.routineId)} title="Learn it move by move">
                  <Icon name="storybook" size="xs" cut="none" /> Learn
                </button>
                <button
                  type="button"
                  className="shelf-remove"
                  title="Remove from this list"
                  aria-label={`Remove ${e.title} (seed ${e.seed})`}
                  onClick={() => setShelf(forgetRoutine(e.routineId))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
          caption={phase === 'preview'}
          keys={stageKeys}
          sound={soundOn}
        >
          {phase !== 'results' && <RoomLeaderboard routineId={routine?.meta?.routineId} />}
          {phase !== 'results' && <HeraldBubble announcer={announcer} />}
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
                {goneRecipe && (
                  <p className="dim">The same song, setup and seed ({setupLabel(goneRecipe)}) make the very same routine.</p>
                )}
                <div className="play-card-actions">
                  {goneRecipe ? (
                    <button type="button" className="primary" onClick={() => generateAgain(goneRecipe)}>
                      Generate it again
                    </button>
                  ) : (
                    <button type="button" className="primary" onClick={retryLaunch}>
                      Try again
                    </button>
                  )}
                  <button type="button" onClick={exitToLobby}>
                    Back to the lobby
                  </button>
                </div>
              </div>
            </div>
          )}
          {isRehearsing(phase) && (
            <div className="rehearsal-bar">
              <span className={`play-badge ${phase}`}>{phase === 'preview' ? 'PREVIEW' : 'PRACTICE'}</span>
              <button type="button" className="primary" onClick={endRehearsal}>
                Skip → I’m ready
              </button>
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
                    {watchInstead}
                    <button type="button" onClick={switchToAutoplay}>
                      No camera? Let the bot dance
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
                  {watchInstead}
                  <button type="button" onClick={switchToAutoplay}>
                    Let the bot dance
                  </button>
                  <button type="button" onClick={exitToLobby}>
                    Lobby
                  </button>
                </div>
              </div>
            </div>
          )}
          {paused && isRunning(phase) && (
            <PauseMenu onResume={togglePause} onRestart={inRoom ? undefined : restart} onQuit={exitToLobby} onSkip={isRehearsing(phase) ? endRehearsal : undefined} />
          )}
          {phase === 'ready' && active && (
            <div className="play-overlay dim-bg">
              <div className="play-card">
                <h2>Ready to dance?</h2>
                <p className="dim">
                  {runRehearsal === 'practice'
                    ? 'Warmed up! The real round keeps your camera and timing.'
                    : autoplay
                      ? 'Now the bot dances it for real.'
                      : 'You’ve seen the whole dance. Your turn!'}
                </p>
                <div className="play-card-actions">
                  <button type="button" className="primary" onClick={playForReal}>
                    ▶ Play for real
                  </button>
                  <button type="button" onClick={rehearseAgain}>
                    {runRehearsal === 'practice' ? 'Practice again' : 'Watch again'}
                  </button>
                  <button type="button" onClick={newRoutine} title="Same song and setup, a new seed">
                    New routine
                  </button>
                  <button type="button" onClick={exitToLobby}>
                    Lobby
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
              details={round?.details}
              onPlayAgain={playAgain}
              onNewRoutine={newRoutine}
              onLobby={exitToLobby}
              onPracticeHardest={practiceHardest}
              onDownloadLog={roundLog ? () => downloadSessionLog(roundLog) : undefined}
              onLearn={isRoutineId(shownId) ? () => openTeach(shownId) : undefined}
              onMenu={() => {
                window.location.hash = '#/'
              }}
              aside={<SignatureCard title={active.game.analysis.title} />}
              herald={
                <>
                  <HeraldBubble announcer={announcer} placement="inline" />
                  <RoomLeaderboard routineId={shownId} inline />
                </>
              }
            />
          )}
        </PlayStage>
      )}
    </section>
  )
}
