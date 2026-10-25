// Stage 1 debug page: song analysis (beats, downbeats, onsets, energy, sections) on a
// zoomable timeline, with audio-clock playback. Every visual is derived per animation
// frame from SongPlayer.currentTime() (the AudioContext clock), never from timers.
// Stage 2: a Choreography panel generates a routine (POST /api/choreograph); its moves get
// a timeline row and a live preview figure driven by poseAtTime(routine, audio time). Every
// generated routine goes on the "Your routines" shelf, and "Play this routine" opens it in
// the game (#/play?routine=<id>).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type MouseEvent } from 'react'
import type { Difficulty, Mode, Routine } from '@shared/routine'
import {
  analyzeLibrarySong,
  analyzeUpload,
  ApiError,
  choreograph,
  fetchAudio,
  listSongs,
  type Analysis,
  type SongInfo,
} from '../api'
import { drawTimeline } from '../analysis/drawTimeline'
import {
  barBeatAt,
  beatIndexAt,
  clampScroll,
  followScroll,
  formatTime,
  groupColor,
  isDownbeatIndex,
  MAX_ZOOM,
  MIN_ZOOM,
  pxPerSec,
  sectionIndexAt,
  timeToX,
  visibleSec,
  xToTime,
  zoomAround,
  type TimelineView,
} from '../analysis/timeline'
import { SongPlayer } from '../audio/songPlayer'
import { rememberRoutine, shelfEntryFor } from '../game/routineShelf'
import { prepareCanvas } from '../lib/canvas'
import { errorMessage, isAbortError } from '../lib/errors'
import { isRoutineId, playRoutineHash } from '../lib/hashRoute'
import { useLatest } from '../lib/useLatest'
import { coachStyle, drawFigure, drawFloor, fitFigureView } from '../render/stickFigure'
import { DEMO_LIBRARY, demoRoutine } from '../routine/demo'
import { routineSummary } from '../routine/library'
import { poseAtTime } from '../routine/pose'

type Source = { kind: 'library'; file: string } | { kind: 'upload'; file: File }

interface Loaded {
  analysis: Analysis
  source: Source
  filled: ReadonlySet<number>
}

type Transport = 'paused' | 'loading' | 'playing'

interface Generated {
  analysisId: string
  routine: Routine
  /** Built in the browser from the demo library (server endpoint missing). */
  demo: boolean
  /** Server cache hit (X-Routine-Cache); null when unknown. */
  cached: boolean | null
}

const randomSeed = (): number => Math.floor(Math.random() * 1_000_000)

const FLASH_DECAY_SEC = 0.12

const sameSource = (a: Source, b: Source): boolean => a.kind === b.kind && a.file === b.file

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
}

/** Readable message for analysis/playback failures (server down, 4xx detail, decode errors). */
function friendlyError(what: string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.unreachable) return err.message
    if (err.status === 404 && err.message === 'Not Found') {
      return `${what}: the server has no Stage 1 analysis endpoint yet (404). Is it up to date?`
    }
    if (err.status === 413) return `${what}: file too large (${err.message})`
    return `${what} failed (${err.status}): ${err.message}`
  }
  return `${what}: ${errorMessage(err)}`
}

export default function AnalysisDebug() {
  const [songs, setSongs] = useState<SongInfo[] | null>(null)
  const [songsError, setSongsError] = useState<string | null>(null)
  const [songsReload, setSongsReload] = useState(0)
  const [selected, setSelected] = useState('')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [transport, setTransport] = useState<Transport>('paused')
  const [metronome, setMetronome] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [activeSection, setActiveSection] = useState(-1)
  const [player] = useState(() => new SongPlayer())
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const [mode, setMode] = useState<Mode>('standing')
  const [seed, setSeed] = useState(1)
  const [gen, setGen] = useState<Generated | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const requestRef = useRef<AbortController | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pulseRef = useRef<HTMLDivElement>(null)
  const barBeatRef = useRef<HTMLSpanElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const rafRef = useRef(0)
  /** Song time at the timeline's left edge (source of truth; the scrollbar mirrors it). */
  const scrollSecRef = useRef(0)
  const lastViewRef = useRef<TimelineView | null>(null)
  const activeSectionRef = useRef(-1)
  const autoLoadedRef = useRef(false)
  const genRequestRef = useRef<AbortController | null>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const nowNextRef = useRef<HTMLSpanElement>(null)

  /** The generated routine, only while it belongs to the loaded analysis. */
  const routine = gen && loaded && gen.analysisId === loaded.analysis.id ? gen.routine : null

  // --- view helpers ------------------------------------------------------------------
  const currentView = (): TimelineView | null => {
    const a = loaded?.analysis
    const scroller = scrollerRef.current
    if (!a || !scroller) return null
    return { durationSec: a.durationSec, widthPx: scroller.clientWidth, zoom, scrollSec: scrollSecRef.current }
  }

  /** Moves the native scrollbar to match scrollSecRef. */
  const syncScrollbar = (view: TimelineView): void => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollLeft = view.scrollSec * pxPerSec(view)
  }

  /** Draws the timeline + live readouts for the current song time. Returns true to keep animating. */
  const renderFrame = (): boolean => {
    const playing = player.playing
    const t = player.currentTime()
    const a = loaded?.analysis
    const canvas = canvasRef.current
    const sample = routine ? poseAtTime(routine, t) : null
    let view = currentView()
    if (a && canvas && view) {
      if (playing) {
        const s = followScroll(view, t)
        if (s !== view.scrollSec) {
          scrollSecRef.current = s
          view = { ...view, scrollSec: s }
          syncScrollbar(view)
        }
      }
      const idx = sectionIndexAt(a.sections, t)
      if (idx !== activeSectionRef.current) {
        activeSectionRef.current = idx
        setActiveSection(idx)
      }
      lastViewRef.current = drawTimeline(canvas, {
        analysis: a,
        filled: loaded.filled,
        zoom,
        scrollSec: view.scrollSec,
        playhead: t,
        activeSection: idx,
        moves: routine?.moves,
        activeMove: sample?.moveIndex ?? -1,
      })
    } else if (canvas) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    }

    // Live preview of the routine (mirrored coach view).
    const preview = previewRef.current ? prepareCanvas(previewRef.current) : null
    if (preview && routine && sample) {
      const fv = fitFigureView(preview.width, preview.height, true)
      const current = routine.moves[sample.moveIndex]
      drawFloor(preview.ctx, fv)
      drawFigure(preview.ctx, sample.pose, sample.root, fv, coachStyle(fv, { highlightJoints: current?.scoredJoints }))
    }
    if (nowNextRef.current) {
      const name = (i: number | undefined): string => (routine && i !== undefined && i >= 0 ? routine.moves[i].name : '–')
      nowNextRef.current.textContent = routine ? `now: ${name(sample?.moveIndex)} · next: ${name(sample?.nextMoveIndex)}` : ''
    }

    const bb = a ? barBeatAt(a, t) : null
    if (barBeatRef.current) barBeatRef.current.textContent = bb ? `Bar ${bb.bar} · beat ${bb.beat}` : '–'
    if (timeRef.current) timeRef.current.textContent = `${formatTime(t)} / ${formatTime(player.durationSec)}`
    const pulse = pulseRef.current
    if (pulse) {
      const i = a ? beatIndexAt(a.beats, t) : -1
      const flash = playing && a && i >= 0 ? Math.exp(-(t - a.beats[i]) / FLASH_DECAY_SEC) : 0
      const down = a !== undefined && i >= 0 && isDownbeatIndex(i, a.downbeatPhase, a.beatsPerBar)
      pulse.style.transform = `scale(${(1 + (down ? 0.28 : 0.15) * flash).toFixed(4)})`
      pulse.style.setProperty('--flash', flash.toFixed(4))
      pulse.classList.toggle('downbeat', down)
    }
    return playing
  }

  const renderRef = useLatest(renderFrame)
  /** Schedules one frame; frames keep coming while the player is playing. */
  const requestFrame = useCallback((): void => {
    if (rafRef.current) return
    const tick = (): void => {
      rafRef.current = 0
      if (renderRef.current()) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [renderRef])

  // --- lifecycle -----------------------------------------------------------------------
  useEffect(() => {
    player.setOnEnded(() => {
      // Back to the start (the player rewinds to 0), so the playhead is on screen.
      setTransport('paused')
      scrollSecRef.current = 0
      if (scrollerRef.current) scrollerRef.current.scrollLeft = 0
      requestFrame()
    })
    return () => {
      requestRef.current?.abort()
      genRequestRef.current?.abort()
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      player.dispose() // stops audio + clicks, closes the AudioContext
    }
  }, [player, requestFrame])

  // Redraw on resize (keeping the scrollbar in step with scrollSecRef).
  const resizeRef = useLatest((): void => {
    const view = currentView()
    if (view) {
      scrollSecRef.current = clampScroll(view, view.scrollSec)
      syncScrollbar({ ...view, scrollSec: scrollSecRef.current })
    }
    requestFrame()
  })
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const ro = new ResizeObserver(() => resizeRef.current())
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [resizeRef])

  // After a zoom change the track has its new width: place the scrollbar, redraw.
  useLayoutEffect(() => {
    resizeRef.current()
  }, [zoom, loaded, resizeRef])

  // A new routine (or none): redraw once; while playing the running loop picks it up.
  useLayoutEffect(() => {
    requestFrame()
  }, [routine, requestFrame])

  // --- analysis ------------------------------------------------------------------------
  const analyze = async (source: Source, refresh = false): Promise<void> => {
    player.pause()
    setTransport('paused')
    requestRef.current?.abort()
    const ac = new AbortController()
    requestRef.current = ac
    setError(null)
    genRequestRef.current?.abort()
    genRequestRef.current = null
    setGenBusy(false)
    setGenError(null)
    if (loaded && !sameSource(loaded.source, source)) {
      setLoaded(null)
      player.setSong(null)
    }
    const name = source.kind === 'library' ? source.file : source.file.name
    setBusy(refresh ? `Re-analyzing ${name}…` : source.kind === 'upload' ? `Uploading and analyzing ${name}…` : `Analyzing ${name}…`)
    try {
      const analysis =
        source.kind === 'library'
          ? await analyzeLibrarySong(source.file, { refresh, signal: ac.signal })
          : await analyzeUpload(source.file, { refresh, signal: ac.signal })
      // Uploads play from the local file (same bytes); library songs from analysis.audioUrl.
      player.setSong({
        key: analysis.id,
        loadBytes: (signal) => (source.kind === 'upload' ? source.file.arrayBuffer() : fetchAudio(analysis.audioUrl, signal)),
        beats: analysis.beats,
        isDownbeat: (i) => isDownbeatIndex(i, analysis.downbeatPhase, analysis.beatsPerBar),
        durationSec: analysis.durationSec,
      })
      scrollSecRef.current = 0
      activeSectionRef.current = -1
      setActiveSection(-1)
      setLoaded({ analysis, source, filled: new Set(analysis.filledBeats) })
    } catch (err) {
      if (!ac.signal.aborted && !isAbortError(err)) setError(friendlyError('Analysis', err))
    } finally {
      if (requestRef.current === ac) {
        requestRef.current = null
        setBusy(null)
      }
    }
  }

  // --- choreography -------------------------------------------------------------------
  /** POST /api/choreograph. Never touches playback: the frame loop reads the new routine. */
  const generate = async (withSeed: number = seed): Promise<void> => {
    const a = loaded?.analysis
    if (!a) return
    genRequestRef.current?.abort()
    const ac = new AbortController()
    genRequestRef.current = ac
    setGenBusy(true)
    setGenError(null)
    try {
      const res = await choreograph({ analysisId: a.id, difficulty, mode, seed: withSeed }, ac.signal)
      setGen({ analysisId: a.id, routine: res.routine, demo: false, cached: res.cached })
      const entry = shelfEntryFor(res.routine, a, 'analysis')
      if (entry) rememberRoutine(entry)
    } catch (err) {
      if (ac.signal.aborted || isAbortError(err)) return
      const missingEndpoint = err instanceof ApiError && err.status === 404 && err.message === 'Not Found'
      setGenError(missingEndpoint ? 'The server has no POST /api/choreograph yet (404).' : friendlyError('Choreography', err))
    } finally {
      if (genRequestRef.current === ac) {
        genRequestRef.current = null
        setGenBusy(false)
      }
    }
  }

  const newSeed = (): void => {
    const s = randomSeed()
    setSeed(s)
    void generate(s)
  }

  /**
   * The server routine for exactly these settings is already shown: asking again would return
   * the same cached routine, so the button regenerates with a new random seed instead.
   */
  const showingCurrent =
    routine !== null && gen !== null && !gen.demo && routine.difficulty === difficulty && routine.mode === mode && routine.seed === seed
  const onGenerate = (): void => {
    if (showingCurrent) newSeed()
    else void generate()
  }

  /** The shown server routine's id (not the offline demo's): playable in the game. */
  const playableId = routine && gen && !gen.demo && isRoutineId(routine.meta?.routineId) ? routine.meta.routineId : null
  const playInGame = (): void => {
    const a = loaded?.analysis
    if (!playableId || !routine || !a) return
    player.pause()
    setTransport('paused')
    const entry = shelfEntryFor(routine, a, 'analysis')
    if (entry) rememberRoutine(entry)
    window.location.hash = playRoutineHash(playableId)
  }

  const applyDemoRoutine = (): void => {
    const a = loaded?.analysis
    if (!a) return
    setGen({ analysisId: a.id, routine: demoRoutine(a, DEMO_LIBRARY, { difficulty, mode, seed }), demo: true, cached: null })
    setGenError(null)
  }

  // --- song list -----------------------------------------------------------------------
  const analyzeRef = useLatest(analyze)
  useEffect(() => {
    const ac = new AbortController()
    listSongs(ac.signal).then(
      (list) => {
        setSongs(list)
        setSongsError(null)
        const first = list[0]?.file
        setSelected((cur) => (cur && list.some((s) => s.file === cur) ? cur : (first ?? '')))
        // First list: show something right away.
        if (first && !autoLoadedRef.current) {
          autoLoadedRef.current = true
          void analyzeRef.current({ kind: 'library', file: first })
        }
      },
      (err: unknown) => {
        if (!isAbortError(err)) setSongsError(friendlyError('Loading the song list', err))
      },
    )
    return () => ac.abort()
  }, [songsReload, analyzeRef])

  const onSelect = (e: ChangeEvent<HTMLSelectElement>): void => {
    const file = e.target.value
    setSelected(file)
    if (file) void analyze({ kind: 'library', file })
  }

  const onUpload = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again
    if (file) void analyze({ kind: 'upload', file })
  }

  // --- playback ------------------------------------------------------------------------
  const play = async (from?: number): Promise<void> => {
    setError(null)
    setTransport('loading')
    try {
      if (await player.play(from)) {
        setTransport('playing')
        requestFrame()
      }
    } catch (err) {
      setTransport('paused')
      setError(friendlyError('Playback', err))
    }
  }

  const pause = (): void => {
    player.pause()
    setTransport('paused')
    requestFrame()
  }

  const seek = (t: number): void => {
    player.seek(t)
    requestFrame()
  }

  const onCanvasClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    const view = lastViewRef.current
    if (!view || !loaded) return
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left
    seek(xToTime(view, x))
  }

  const onScroll = (): void => {
    const view = currentView()
    const scroller = scrollerRef.current
    if (!view || !scroller) return
    const pps = pxPerSec(view)
    // Ignore the echo of our own syncScrollbar(); take real user scrolls.
    if (pps > 0 && Math.abs(scroller.scrollLeft - view.scrollSec * pps) > 1) {
      scrollSecRef.current = clampScroll(view, scroller.scrollLeft / pps)
      requestFrame()
    }
  }

  const onZoom = (e: ChangeEvent<HTMLInputElement>): void => {
    const next = Number(e.target.value)
    const view = currentView()
    if (view) {
      // Keep the playhead put when it is on screen (always while playing), else the center.
      const t = player.currentTime()
      const x = timeToX(view, t)
      const anchor = player.playing || (x >= 0 && x <= view.widthPx) ? t : view.scrollSec + visibleSec(view) / 2
      scrollSecRef.current = zoomAround(view, next, anchor).scrollSec
    }
    setZoom(next)
  }

  const onMetronome = (e: ChangeEvent<HTMLInputElement>): void => {
    setMetronome(e.target.checked)
    player.setMetronome(e.target.checked)
  }

  // --- render --------------------------------------------------------------------------
  const a = loaded?.analysis
  const uploadName = loaded?.source.kind === 'upload' ? loaded.source.file.name : null
  const section = a && activeSection >= 0 ? a.sections[activeSection] : undefined
  const summary = routine ? routineSummary(routine) : null

  return (
    <section className="page analysis-debug">
      <div className="toolbar">
        <label>
          Song
          <select value={uploadName ? '' : selected} onChange={onSelect} disabled={!songs?.length}>
            {uploadName && <option value="">Upload: {uploadName}</option>}
            {!songs?.length && <option value="">{songs ? 'no songs in assets/songs/' : songsError ? 'unavailable' : 'loading…'}</option>}
            {songs?.map((s) => (
              <option key={s.file} value={s.file}>
                {s.title} ({formatBytes(s.sizeBytes)})
              </option>
            ))}
          </select>
        </label>
        <label className={`file${busy !== null ? ' disabled' : ''}`}>
          Upload audio…
          <input type="file" accept="audio/*" onChange={onUpload} disabled={busy !== null} />
        </label>
        <button type="button" disabled={!loaded || busy !== null} onClick={() => loaded && void analyze(loaded.source, true)}>
          Re-analyze
        </button>
        {busy && <span className="status">{busy}</span>}
      </div>

      {songsError && (
        <p className="error">
          {songsError}{' '}
          <button type="button" className="link" onClick={() => setSongsReload((n) => n + 1)}>
            Retry
          </button>
        </p>
      )}
      {error && <p className="error">{error}</p>}

      <div className="panel">
        <h2 className="analysis-title">
          {a ? a.title : busy ? 'Analyzing…' : 'No analysis yet'}
          {a?.artist && <span className="dim"> · {a.artist}</span>}
          {a && <span className={`badge ${a.cached ? 'cached' : 'fresh'}`}>{a.cached ? 'cached' : 'fresh'}</span>}
        </h2>
        <dl className="analysis-stats">
          <dt>bpm</dt>
          <dd>{a ? a.bpm.toFixed(1) : '–'}</dd>
          <dt>beats</dt>
          <dd>{a ? `${a.beats.length} (${a.filledBeats.length} filled)` : '–'}</dd>
          <dt>downbeat phase</dt>
          <dd>{a ? a.downbeatPhase : '–'}</dd>
          <dt>duration</dt>
          <dd>{a ? formatTime(a.durationSec) : '–'}</dd>
          <dt>sections</dt>
          <dd>{a ? a.sections.length : '–'}</dd>
          <dt>analysis</dt>
          <dd>{a ? `${a.elapsedMs.toFixed(0)} ms` : '–'}</dd>
        </dl>

        <div ref={scrollerRef} className="timeline-scroller" onScroll={onScroll}>
          <div className="timeline-track" style={{ width: `${zoom * 100}%` }}>
            <canvas
              ref={canvasRef}
              className="analysis-timeline"
              style={{ width: `${100 / zoom}%` }}
              onClick={onCanvasClick}
              aria-label="Analysis timeline: click to seek"
            />
          </div>
        </div>

        <div className="transport">
          {transport === 'paused' ? (
            <button type="button" className="primary" disabled={!loaded} onClick={() => void play()}>
              Play
            </button>
          ) : (
            <button type="button" onClick={pause}>
              {transport === 'loading' ? 'Loading audio… (stop)' : 'Pause'}
            </button>
          )}
          <span className="mono">
            <span ref={timeRef}>{formatTime(0)}</span>
          </span>
          <label className="check">
            <input type="checkbox" checked={metronome} onChange={onMetronome} />
            Metronome (accented downbeat)
          </label>
          <label className="zoom">
            Zoom
            <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={0.5} value={zoom} onChange={onZoom} disabled={!loaded} />
            <span className="mono">{zoom.toFixed(1)}×</span>
          </label>
        </div>

        <div className="live-view">
          <div ref={pulseRef} className="beat-circle small" />
          {routine && <canvas ref={previewRef} className="preview-figure" aria-label="Routine preview (mirrored coach view)" />}
          <div>
            <div className="live-section" style={section ? { color: groupColor(section.group) } : undefined}>
              {section ? section.label : '–'}
              {section && <span className="live-group">{section.group}</span>}
            </div>
            <div className="live-barbeat mono">
              <span ref={barBeatRef}>–</span>
            </div>
            <div className="live-moves">
              <span ref={nowNextRef} />
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Choreography</h2>
        <div className="toolbar">
          <label>
            Difficulty
            <select value={difficulty} onChange={(e) => setDifficulty(e.target.value as Difficulty)}>
              <option value="easy">easy</option>
              <option value="normal">normal</option>
              <option value="hard">hard</option>
            </select>
          </label>
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="standing">standing</option>
              <option value="seated">seated</option>
            </select>
          </label>
          <label>
            Seed
            <input
              type="number"
              className="seed"
              step={1}
              value={seed}
              onChange={(e) => setSeed(Math.trunc(Number(e.target.value)) || 0)}
            />
          </label>
          <button type="button" disabled={!a || busy !== null} onClick={newSeed} title="Pick a random seed and generate">
            New seed
          </button>
          <button
            type="button"
            className="primary"
            disabled={!a || busy !== null}
            onClick={onGenerate}
            title={showingCurrent ? 'Shown already: roll a new random seed and generate' : 'Generate with these settings'}
          >
            {genBusy ? 'Generating…' : showingCurrent ? 'Regenerate' : 'Generate'}
          </button>
          <button
            type="button"
            disabled={!playableId || genBusy}
            onClick={playInGame}
            title={playableId ? 'Open this routine in the game' : 'Generate a server routine first'}
          >
            ▶ Play this routine
          </button>
          {routine && <span className="dim mono">seed {routine.seed}</span>}
          {gen?.demo && routine && <span className="badge fresh">offline demo routine</span>}
        </div>
        {genError && (
          <p className="error">
            {genError}{' '}
            <button type="button" className="link" onClick={applyDemoRoutine}>
              Use an offline demo routine
            </button>
          </p>
        )}
        <dl className="choreo-stats">
          <dt>routine</dt>
          <dd>{summary?.routineId ?? '–'}</dd>
          <dt>moves</dt>
          <dd>{summary ? `${summary.moves} (${summary.distinct} distinct)` : '–'}</dd>
          <dt>cached</dt>
          <dd>{gen && routine ? (gen.demo ? 'demo' : gen.cached === null ? 'n/a' : gen.cached ? 'yes' : 'no') : '–'}</dd>
          <dt>setup</dt>
          <dd>{routine ? `${routine.difficulty} · ${routine.mode} · seed ${routine.seed}` : '–'}</dd>
        </dl>
      </div>

      {a && (
        <div className="panel">
          <h2>Sections</h2>
          <div className="table-scroll">
          <table className="sections-table">
            <thead>
              <tr>
                <th>#</th>
                <th>label</th>
                <th>group</th>
                <th>start–end</th>
                <th>bars</th>
                <th>energy</th>
              </tr>
            </thead>
            <tbody>
              {a.sections.map((s, i) => (
                <tr
                  key={`${s.start}-${i}`}
                  className={i === activeSection ? 'active' : undefined}
                  onClick={() => void play(s.start)}
                  title="Play from here"
                >
                  <td className="dim">{i + 1}</td>
                  <td>{s.label}</td>
                  <td>
                    <span className="group-chip" style={{ background: groupColor(s.group) }}>
                      {s.group}
                    </span>
                  </td>
                  <td className="mono">
                    {formatTime(s.start)}–{formatTime(s.end)}
                  </td>
                  <td className="mono">{s.bars}</td>
                  <td>
                    <span className="energy-bar">
                      <span style={{ width: `${Math.round(s.energy * 100)}%`, background: groupColor(s.group) }} />
                    </span>
                    <span className="mono dim"> {s.energy.toFixed(2)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </section>
  )
}
