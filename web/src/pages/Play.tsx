// The game: a lobby (song, difficulty, mode, seed) and a full-window stage where the glowing
// coach dances to the song, cue cards slide in and a 3-2-1 count-in starts the ball. Playback
// and every visual run on the AudioContext clock (src/game/clock.ts); Stage 4 adds scoring.

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { Analysis } from '@shared/analysis'
import type { Difficulty, Mode } from '@shared/routine'
import { ApiError, listSongs, type SongInfo } from '../api'
import { GameClock } from '../game/clock'
import PlayStage, { type ActiveGame } from '../game/PlayStage'
import { apiSessionDeps, prepareGame, STEP_LABELS, type PreparedGame, type SessionState, type SongChoice } from '../game/session'
import { DriftMeter, SyncMonitor } from '../game/sync'
import { errorMessage, isAbortError } from '../lib/errors'
import { useLatest } from '../lib/useLatest'
import './play.css'

const randomSeed = (): number => Math.floor(Math.random() * 1_000_000)

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
  const [onStage, setOnStage] = useState(false)
  const [session, setSession] = useState<SessionState>({ status: 'idle' })
  const [active, setActive] = useState<ActiveGame | null>(null)
  const [paused, setPaused] = useState(false)
  const [finished, setFinished] = useState(false)
  const [mirrored, setMirrored] = useState(true)
  const [debug, setDebug] = useState(false)
  const sessionRef = useRef<AbortController | null>(null)
  const activeRef = useLatest(active)

  // --- lifecycle -----------------------------------------------------------------------
  // At most one AudioContext, closed on unmount (stops audio, frees the decoded song).
  useEffect(
    () => () => {
      sessionRef.current?.abort()
      sessionRef.current = null
      clock.dispose()
    },
    [clock],
  )

  useEffect(() => {
    clock.setOnEnded(() => {
      setFinished(true)
      setPaused(false)
      const monitor = activeRef.current?.monitor
      if (monitor) console.log(monitor.summary())
    })
    return () => clock.setOnEnded(null)
  }, [clock, activeRef])

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
  const begin = (game: PreparedGame): void => {
    setActive({ game, monitor: new SyncMonitor(game.routine.song.beats) })
    setPaused(false)
    setFinished(false)
    clock.play(-game.timeline.countdown.preRollSec, game.timeline.countInClicks)
  }

  /** Must run inside a click / key handler: it unlocks audio for the autoplay policy. */
  const start = (opts: { seed?: number; reuse?: Analysis } = {}): void => {
    if (!choice) return
    clock.unlock()
    clock.stop()
    sessionRef.current?.abort()
    const ac = new AbortController()
    sessionRef.current = ac
    blurFocus()
    setOnStage(true)
    setActive(null)
    setPaused(false)
    setFinished(false)
    const step = opts.reuse ? 'choreographing' : 'analyzing'
    setSession({ status: 'loading', step, label: STEP_LABELS[step] })
    const req = { song: choice, difficulty, mode, seed: opts.seed ?? seed }
    void prepareGame(req, apiSessionDeps(clock), setSession, ac.signal, { analysis: opts.reuse }).then((game) => {
      if (game && sessionRef.current === ac) begin(game)
    })
  }

  const restart = (): void => {
    if (!active) return
    active.monitor.reset()
    clock.play(-active.game.timeline.countdown.preRollSec, active.game.timeline.countInClicks)
    setPaused(false)
    setFinished(false)
  }

  const togglePause = (): void => {
    if (!active || finished) return
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
    start({ seed: s, reuse: active?.game.analysis })
  }

  const exitToLobby = (): void => {
    sessionRef.current?.abort()
    sessionRef.current = null
    clock.stop()
    setActive(null)
    setSession({ status: 'idle' })
    setPaused(false)
    setFinished(false)
    setOnStage(false)
  }

  const onKey = useLatest((e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const onControl = e.target instanceof Element && e.target.closest('button, input, select, textarea, a') !== null
    switch (e.key) {
      case ' ':
        if (onControl) return
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
  const routine = active?.game.routine
  const stageTitle = active ? active.game.analysis.title : choiceTitle(choice)
  const stageSubtitle = routine
    ? `${routine.difficulty} · ${routine.mode} · seed ${routine.seed}`
    : `${difficulty} · ${mode} · seed ${seed}`

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
          <button type="button" className="start-button" disabled={!choice} onClick={() => start()}>
            ▶ Start the ball
          </button>
          <p className="hint lobby-keys">Space pause · R restart · M mirror · D debug · Esc back here</p>
        </div>
      </div>
      </div>

      {onStage && (
        <PlayStage
          clock={clock}
          active={active}
          mirrored={mirrored}
          debug={debug}
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
          {paused && !finished && (
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
          {finished && (
            <div className="play-overlay dim-bg">
              <div className="play-card finished">
                <p className="lobby-kicker">The last note fades…</p>
                <h2>Finished!</h2>
                <p className="dim">Your slippers are worn right through. What a ball!</p>
                <div className="play-card-actions">
                  <button type="button" className="primary" onClick={restart}>
                    Play again
                  </button>
                  <button type="button" onClick={newRoutine}>
                    New routine
                  </button>
                  <button type="button" onClick={exitToLobby}>
                    Lobby
                  </button>
                </div>
              </div>
            </div>
          )}
        </PlayStage>
      )}
    </section>
  )
}
