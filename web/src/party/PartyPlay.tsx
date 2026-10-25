// "#/play?party=N": the whole party flow on one device and one camera. Setup sheet (dancers, song,
// the mirror with a live head count) -> the regular play stage (coach, cue strip, count-in) with the
// party overlay -> the podium. Reuses the game's clock, session loading, checkpoints and judging;
// calibration is skipped (the saved single-player latency, or the default, is used).

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Difficulty } from '@shared/routine'
import { listSongs, type SongInfo } from '../api'
import { loadCalibration } from '../game/calibration'
import { GameClock } from '../game/clock'
import { loadJudging, scoringFor } from '../game/judging'
import PlayStage, { type ActiveGame } from '../game/PlayStage'
import { buildCheckpoints } from '../game/scoring'
import { apiSessionDeps, prepareGame, STEP_LABELS, type PreparedGame, type SessionState } from '../game/session'
import { SyncMonitor } from '../game/sync'
import { songTimeAtFromClock } from '../game/webcamSource'
import { errorMessage, isAbortError } from '../lib/errors'
import { useLatest } from '../lib/useLatest'
import '../pages/play.css'
import { PartyPoseSource } from './multiPose'
import PartyHud from './PartyHud'
import { PartyRun, type PartyStanding } from './partyRun'
import PartyResults from './PartyResults'
import PartySetup from './PartySetup'
import { clampCount, displayName, loadPartyPlayers, MAX_PARTY, partyPlayers, savePartyPlayers, type PartyPlayer } from './players'
import { PartyTracker } from './tracker'

type Phase = 'setup' | 'stage' | 'results'

interface Stage {
  active: ActiveGame
  run: PartyRun
}

export default function PartyPlay({ count: initialCount }: { count: number }) {
  const [clock] = useState(() => new GameClock())
  const [source] = useState(
    () => new PartyPoseSource({ songTimeAt: songTimeAtFromClock(clock), latencySec: loadCalibration().latencySec, maxPeople: MAX_PARTY }),
  )
  const [players, setPlayers] = useState<PartyPlayer[]>(() => partyPlayers(initialCount, loadPartyPlayers()))
  const [camError, setCamError] = useState<string | null>(null)
  const [camTry, setCamTry] = useState(0)
  const [songs, setSongs] = useState<SongInfo[] | null>(null)
  const [song, setSong] = useState<string | null>(null)
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('setup')
  const [stage, setStage] = useState<Stage | null>(null)
  const [paused, setPaused] = useState(false)
  const [standings, setStandings] = useState<PartyStanding[] | null>(null)
  const preparedRef = useRef<{ key: string; game: PreparedGame } | null>(null)
  const sessionRef = useRef<AbortController | null>(null)
  const stageRef = useLatest(stage)
  const count = players.length

  // One tracker per line-up size; identities carry over from the setup sheet into the game.
  const tracker = useMemo(() => new PartyTracker(source, count), [source, count])
  useEffect(() => tracker.attach(), [tracker])

  // The camera stays on from the setup sheet through the podium.
  useEffect(() => {
    source.start().catch((err: unknown) => {
      if (!isAbortError(err)) setCamError(errorMessage(err))
    })
    const off = source.onError((msg) => setCamError(msg))
    return () => {
      off()
      source.stop()
    }
  }, [source, camTry])

  useEffect(() => {
    const ac = new AbortController()
    listSongs(ac.signal).then(
      (list) => {
        setSongs(list)
        setSong((cur) => cur ?? list[0]?.file ?? null)
      },
      (err: unknown) => {
        if (!isAbortError(err)) setError(`Couldn't find the music: ${errorMessage(err)}`)
      },
    )
    return () => ac.abort()
  }, [])

  useEffect(
    () => () => {
      sessionRef.current?.abort()
      stageRef.current?.run.dispose()
      clock.dispose()
    },
    [clock, stageRef],
  )

  const begin = (game: PreparedGame): void => {
    stageRef.current?.run.dispose()
    const run = new PartyRun({
      tracker,
      players,
      checkpoints: buildCheckpoints(game.routine, game.routine.mode),
      config: scoringFor(loadJudging()),
      isPlaying: () => clock.playing,
    })
    setStage({ active: { game, monitor: new SyncMonitor(game.routine.song.beats), run: null }, run })
    setStandings(null)
    setPaused(false)
    setPhase('stage')
    clock.play(-game.timeline.countdown.preRollSec, game.timeline.countInClicks)
  }

  const finishRef = useLatest((): void => {
    const s = stageRef.current
    if (!s || s.run.finished) return
    setStandings(s.run.finish(s.active.game.routine, s.active.game.durationSec))
    setPaused(false)
    setPhase('results')
  })
  useEffect(() => {
    clock.setOnEnded(() => finishRef.current())
    return () => clock.setOnEnded(null)
  }, [clock, finishRef])

  const start = (): void => {
    if (!song || busy) return
    clock.unlock() // inside the click: the autoplay policy
    savePartyPlayers(players)
    setError(null)
    const key = `${song}|${difficulty}`
    const ready = preparedRef.current
    if (ready?.key === key) {
      begin(ready.game)
      return
    }
    sessionRef.current?.abort()
    const ac = new AbortController()
    sessionRef.current = ac
    const title = songs?.find((s) => s.file === song)?.title
    const onState = (s: SessionState): void => {
      if (sessionRef.current !== ac) return
      if (s.status === 'loading') setBusy(s.label)
      else if (s.status === 'error') {
        setBusy(null)
        setError(s.message)
      }
    }
    setBusy(STEP_LABELS.analyzing)
    const req = { song: { kind: 'library' as const, file: song, title }, difficulty, mode: 'standing' as const, seed: Math.floor(Math.random() * 1_000_000) }
    void prepareGame(req, apiSessionDeps(clock), onState, ac.signal).then((game) => {
      if (sessionRef.current !== ac) return
      setBusy(null)
      if (!game) return
      preparedRef.current = { key, game }
      begin(game)
    })
  }

  const exitStage = (): void => {
    clock.stop()
    stageRef.current?.run.dispose()
    setStage(null)
    setPaused(false)
    setPhase('setup')
  }

  const togglePause = (): void => {
    if (phase !== 'stage') return
    if (clock.playing) {
      clock.pause()
      setPaused(true)
    } else {
      clock.resume()
      setPaused(false)
    }
  }
  const keysRef = useLatest({ phase, togglePause, exitStage })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const k = keysRef.current
      if (k.phase !== 'stage' || e.target instanceof HTMLInputElement) return
      if (e.key === ' ') {
        e.preventDefault()
        k.togglePause()
      } else if (e.key === 'Escape') k.exitStage()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keysRef])

  // No page scroll behind the full-window stage.
  useEffect(() => {
    if (phase !== 'stage') return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [phase])

  const setCount = (n: number): void => {
    const next = clampCount(n)
    setPlayers((cur) => partyPlayers(next, [...cur, ...loadPartyPlayers().slice(cur.length)]))
    window.history.replaceState(null, '', `#/play?party=${next}`)
  }

  if (phase === 'stage' && stage) {
    const game = stage.active.game
    return (
      <PlayStage
        clock={clock}
        active={stage.active}
        mirrored
        debug={false}
        pip={false}
        paused={paused}
        title={game.analysis.title}
        subtitle={`Party · ${players.map(displayName).join(', ')}`}
        onTogglePause={togglePause}
        onExit={exitStage}
        keys="Space pause · Esc back to the party"
      >
        <PartyHud run={stage.run} tracker={tracker} video={source.video} clock={clock} />
      </PlayStage>
    )
  }

  if (phase === 'results' && standings && stage) {
    return (
      <PartyResults
        standings={standings}
        songTitle={stage.active.game.analysis.title}
        onAgain={() => {
          clock.unlock()
          begin(stage.active.game)
        }}
        onSetup={() => {
          clock.stop()
          setPhase('setup')
        }}
      />
    )
  }

  return (
    <PartySetup
      players={players}
      onPlayers={setPlayers}
      onCount={setCount}
      tracker={tracker}
      video={source.video}
      songs={songs}
      song={song}
      onSong={setSong}
      difficulty={difficulty}
      onDifficulty={setDifficulty}
      onStart={start}
      busy={busy}
      error={error}
      cameraError={camError}
      onRetryCamera={() => {
        setCamError(null)
        setCamTry((n) => n + 1)
      }}
    />
  )
}
