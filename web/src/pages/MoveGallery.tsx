// Move gallery (#/moves): every library move looping at a chosen BPM. One shared
// requestAnimationFrame loop draws only the cards on screen; click a card for a detail view
// with a scrubber and per-beat thumbnails.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Difficulty } from '@shared/routine'
import { ApiError, getMoves, type LibraryMove, type MoveLibraryResponse } from '../api'
import { prepareCanvas } from '../lib/canvas'
import { errorMessage, isAbortError } from '../lib/errors'
import { useLatest } from '../lib/useLatest'
import { CanvasLoop } from '../render/canvasLoop'
import { COACH_THEMES, coachThemeFor, drawCoach } from '../render/coach'
import { drawPictogram } from '../render/pictogram'
import { drawStage } from '../render/stage'
import { coachStyle, drawFigure, drawFloor, fitFigureView, LEFT_COLOR, RIGHT_COLOR } from '../render/stickFigure'
import { DEMO_LIBRARY } from '../routine/demo'
import { allStyles, filterMoves, intensityColor, libraryStats, NO_FILTERS, type MoveFilters } from '../routine/library'
import { poseInMove } from '../routine/pose'
import { signatureEnabled } from '../signature/flag'
import { signatureLabel, withSignatureMoves } from '../signature/dances'

interface ViewSettings {
  bpm: number
  mirrored: boolean
  lrColors: boolean
  /** Draw the Stage 3 coach (glowing silhouette) instead of the stick figure. */
  coachLook: boolean
  /** Section label picking the coach theme (coachThemeFor). */
  theme: string
}

const THEME_NAMES = Object.keys(COACH_THEMES)

const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard']
const NO_MOVES: LibraryMove[] = []

/** Fraction of `move` at time `nowSec` when looping at `bpm` (all cards share one phase). */
function loopU(nowSec: number, move: LibraryMove, bpm: number): number {
  const beats = (nowSec * bpm) / 60
  const len = Math.max(1, move.lengthBeats)
  return (((beats % len) + len) % len) / len
}

/** Draws `move` at fraction `u` into `canvas` (sized by CSS), with beat dots along the top. */
function drawMove(canvas: HTMLCanvasElement, move: LibraryMove, u: number, s: ViewSettings, beatDots = true, stage = false): void {
  const prepared = prepareCanvas(canvas)
  if (!prepared) return
  const { ctx, width, height } = prepared
  const view = fitFigureView(width, height, s.mirrored)
  const { pose, root } = poseInMove(move.keyframes, u)
  if (s.coachLook) {
    const theme = coachThemeFor(s.theme)
    // Beat pulse: 1 on each beat of the move, decaying over the beat.
    const beatPhase = (u * Math.max(1, move.lengthBeats)) % 1
    const beatPulse = (1 - beatPhase) ** 3
    if (stage) {
      drawStage(ctx, { width, height, time: performance.now() / 1000, beatPulse, theme, floor: { x: view.cx, y: view.floorY, scale: view.scale } })
    } else {
      drawFloor(ctx, view)
    }
    drawCoach(ctx, pose, root, view, { theme, beatPulse, highlightJoints: move.scoredJoints })
  } else {
    drawFloor(ctx, view)
    drawFigure(ctx, pose, root, view, coachStyle(view, { lrColors: s.lrColors, highlightJoints: move.scoredJoints }))
  }
  if (beatDots) {
    const n = Math.max(1, move.lengthBeats)
    const cur = Math.min(n - 1, Math.floor(u * n))
    const r = Math.max(2, Math.min(4, width / 60))
    for (let i = 0; i < n; i++) {
      ctx.beginPath()
      ctx.arc(8 + r + i * (r * 3), 8 + r, r, 0, Math.PI * 2)
      ctx.fillStyle = i === cur ? '#facc15' : 'rgba(148, 163, 255, 0.35)'
      ctx.fill()
    }
  }
}

function IntensityDots({ value }: { value: number }) {
  return (
    <span className="intensity" title={`intensity ${value}/5`} aria-label={`intensity ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="idot" style={i <= value ? { background: intensityColor(value) } : undefined} />
      ))}
    </span>
  )
}

function MoveMeta({ move }: { move: LibraryMove }) {
  return (
    <>
      <div className="move-meta">
        <span className="mono">{move.lengthBeats} beat{move.lengthBeats === 1 ? '' : 's'}</span>
        <IntensityDots value={move.intensity} />
        <span className={`diff diff-${move.difficulty}`}>{move.difficulty}</span>
      </div>
      <div className="move-tags">
        {move.upperBodyOnly && <span className="tag seated">seated ok</span>}
        {signatureLabel(move) && <span className="tag">★ {signatureLabel(move)}</span>}
        {move.styles.map((s) => (
          <span key={s} className="tag">
            {s}
          </span>
        ))}
      </div>
    </>
  )
}

interface CardProps {
  move: LibraryMove
  loop: CanvasLoop
  settings: RefObject<ViewSettings>
  onOpen: (id: string) => void
}

function MoveCard({ move, loop, settings, onOpen }: CardProps) {
  const canvasRef = useCallback(
    (el: HTMLCanvasElement | null) => {
      if (!el) return
      return loop.add(el, (now) => drawMove(el, move, loopU(now, move, settings.current.bpm), settings.current))
    },
    [loop, move, settings],
  )
  return (
    <button type="button" className="move-card" onClick={() => onOpen(move.id)} title="Open detail view">
      <canvas ref={canvasRef} className="move-canvas" aria-label={`${move.name} animation`} />
      <div className="move-name">{move.name}</div>
      <div className="move-id mono">{move.id}</div>
      <MoveMeta move={move} />
    </button>
  )
}

/** Static pose thumbnail, redrawn when the view settings change. */
function PoseThumb({ move, u, settings, label, onPick, active }: {
  move: LibraryMove
  u: number
  settings: ViewSettings
  label: string
  onPick: () => void
  active: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    if (ref.current) drawMove(ref.current, move, u, settings, false)
  }, [move, u, settings])
  return (
    <button type="button" className={`thumb${active ? ' active' : ''}`} onClick={onPick}>
      <canvas ref={ref} />
      <span className="mono">{label}</span>
    </button>
  )
}

/** The move's cue-card pictogram (Stage 3), drawn at its real in-game size. */
function Pictogram({ move, settings, active, size }: { move: LibraryMove; settings: ViewSettings; active: boolean; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const prepared = el ? prepareCanvas(el) : null
    if (!prepared) return
    const { ctx, width, height } = prepared
    drawPictogram(ctx, move, { x: 2, y: 2, w: width - 4, h: height - 4 }, { mirrored: settings.mirrored, theme: coachThemeFor(settings.theme), active, label: size >= 110 })
  }, [move, settings, active, size])
  return <canvas ref={ref} style={{ width: size, height: size, display: 'block' }} aria-label={`${move.name} pictogram${active ? ' (active)' : ''}`} />
}

function MoveDetail({ move, loop, settings, onClose }: {
  move: LibraryMove
  loop: CanvasLoop
  settings: ViewSettings
  onClose: () => void
}) {
  const settingsRef = useLatest(settings)
  const [playing, setPlaying] = useState(true)
  const [scrub, setScrub] = useState(0)
  const stateRef = useLatest({ playing, scrub })
  const rangeRef = useRef<HTMLInputElement>(null)
  const uRef = useRef(0)
  /** Close on backdrop clicks only when the press also started there (not a scrub drag ending outside). */
  const downOnBackdrop = useRef(false)

  const canvasRef = useCallback(
    (el: HTMLCanvasElement | null) => {
      if (!el) return
      return loop.add(el, (now) => {
        const st = stateRef.current
        const u = st.playing ? loopU(now, move, settingsRef.current.bpm) : st.scrub
        uRef.current = u
        if (st.playing && rangeRef.current) rangeRef.current.value = String(u)
        drawMove(el, move, u, settingsRef.current, true, true)
      })
    },
    [loop, move, settingsRef, stateRef],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pick = (u: number): void => {
    setPlaying(false)
    setScrub(u)
    if (rangeRef.current) rangeRef.current.value = String(u)
  }
  const keyTimes = new Set(move.keyframes.map((k) => k.t.toFixed(4)))
  const beats = Array.from({ length: move.lengthBeats + 1 }, (_, b) => b / move.lengthBeats)

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="panel move-detail" role="dialog" aria-label={`${move.name} detail`}>
        <div className="detail-head">
          <div>
            <h2 className="detail-title">{move.name}</h2>
            <div className="move-id mono">
              {move.id}
              {move.mirrorOf && <span className="dim"> · mirror of {move.mirrorOf}</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="detail-body">
          <canvas ref={canvasRef} className="detail-canvas" aria-label={`${move.name} animation`} />
          <div className="detail-info">
            <MoveMeta move={move} />
            <dl>
              <dt>side</dt>
              <dd>{move.side}</dd>
              <dt>body</dt>
              <dd>{move.bodyParts.join(', ') || '–'}</dd>
              <dt>anchors</dt>
              <dd>
                {move.startAnchor} → {move.endAnchor}
              </dd>
              <dt>scored</dt>
              <dd>{move.scoredJoints.join(', ') || '–'}</dd>
              <dt>keyframes</dt>
              <dd>{move.keyframes.map((k) => k.t.toFixed(3).replace(/\.?0+$/, '')).join(' · ')}</dd>
            </dl>
            <div>
              <div className="hint">Pictogram (90 px, 90 px active, 120 px with label)</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 4 }}>
                <Pictogram move={move} settings={settings} active={false} size={90} />
                <Pictogram move={move} settings={settings} active size={90} />
                <Pictogram move={move} settings={settings} active={false} size={120} />
              </div>
            </div>
          </div>
        </div>
        <div className="transport">
          <button type="button" className={playing ? undefined : 'primary'} onClick={() => (playing ? pick(uRef.current) : setPlaying(true))}>
            {playing ? 'Pause' : 'Loop'}
          </button>
          <input
            ref={rangeRef}
            className="scrubber"
            type="range"
            min={0}
            max={1}
            step={0.001}
            defaultValue={0}
            onChange={(e) => pick(Number(e.target.value))}
            aria-label="Scrub through the move"
          />
          <span className="mono dim">{playing ? `${settings.bpm} BPM` : `u = ${scrub.toFixed(3)}`}</span>
        </div>
        <div className="thumbs">
          {beats.map((u, b) => (
            <PoseThumb
              key={b}
              move={move}
              u={u}
              settings={settings}
              label={`${b === move.lengthBeats ? 'end' : `beat ${b + 1}`}${keyTimes.has(u.toFixed(4)) ? ' ◆' : ''}`}
              onPick={() => pick(u)}
              active={!playing && Math.abs(scrub - u) < 1e-6}
            />
          ))}
        </div>
        <p className="hint">◆ = a keyframe falls on this beat. Highlighted limbs are scored.</p>
      </div>
    </div>
  )
}

type LibState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; lib: MoveLibraryResponse; demo: boolean }

export default function MoveGallery() {
  const [state, setState] = useState<LibState>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const [filters, setFilters] = useState<MoveFilters>(NO_FILTERS)
  const [bpm, setBpm] = useState(110)
  const [mirrored, setMirrored] = useState(true)
  const [lrColors, setLrColors] = useState(false)
  const [coachLook, setCoachLook] = useState(true)
  const [theme, setTheme] = useState('intro')
  const [openId, setOpenId] = useState<string | null>(null)
  const [loop] = useState(() => new CanvasLoop())

  const settings = useMemo<ViewSettings>(() => ({ bpm, mirrored, lrColors, coachLook, theme }), [bpm, mirrored, lrColors, coachLook, theme])
  const settingsRef = useLatest(settings)

  useEffect(() => () => loop.dispose(), [loop])

  useEffect(() => {
    const ac = new AbortController()
    getMoves(ac.signal).then(
      (lib) => void (signatureEnabled() ? withSignatureMoves(lib, ac.signal) : Promise.resolve(lib)).then((l) => setState({ kind: 'ok', lib: l, demo: false }), () => undefined),
      (err: unknown) => {
        if (isAbortError(err)) return
        const message =
          err instanceof ApiError && err.status === 404 && err.message === 'Not Found'
            ? 'The server has no GET /api/moves yet (404). Is it up to date?'
            : errorMessage(err)
        setState({ kind: 'error', message })
      },
    )
    return () => ac.abort()
  }, [reload])

  const moves = state.kind === 'ok' ? state.lib.moves : NO_MOVES
  const shown = useMemo(() => filterMoves(moves, filters), [moves, filters])
  const styles = useMemo(() => allStyles(moves), [moves])
  const stats = useMemo(() => libraryStats(moves), [moves])
  const open = openId ? moves.find((m) => m.id === openId) : undefined
  const onOpen = useCallback((id: string) => setOpenId(id), [])
  const onClose = useCallback(() => setOpenId(null), [])
  const setFilter = <K extends keyof MoveFilters>(k: K, v: MoveFilters[K]): void => setFilters((f) => ({ ...f, [k]: v }))

  return (
    <section className="page move-gallery df-screen">
      <h2 className="page-title">
        Move Book <span className="dim">every step the princesses know · click one for a closer look</span>
      </h2>
      <div className="panel gallery-head">
        <h2 className="analysis-title">
          Move library
          {state.kind === 'ok' && (
            <>
              <span className="mono dim">v{state.lib.version}</span>
              {state.demo && <span className="badge fresh">demo data</span>}
            </>
          )}
        </h2>
        {state.kind === 'ok' && (
          <p className="gallery-stats">
            <b>{stats.moves}</b> moves (<b>{stats.base}</b> base) · <b>{stats.seated}</b> seated ok · easy {stats.byDifficulty.easy} /
            normal {stats.byDifficulty.normal} / hard {stats.byDifficulty.hard} · showing <b>{shown.length}</b>
          </p>
        )}
        <div className="toolbar">
          <input
            type="search"
            className="search"
            placeholder="Search name, id, style…"
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
          />
          <label>
            Style
            <select value={filters.style} onChange={(e) => setFilter('style', e.target.value)}>
              <option value="">any</option>
              {styles.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Difficulty
            <select value={filters.difficulty} onChange={(e) => setFilter('difficulty', e.target.value as Difficulty | '')}>
              <option value="">any</option>
              {DIFFICULTIES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            Intensity
            <select value={filters.intensity} onChange={(e) => setFilter('intensity', Number(e.target.value))}>
              <option value={0}>any</option>
              {[1, 2, 3, 4, 5].map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={filters.seatedOnly} onChange={(e) => setFilter('seatedOnly', e.target.checked)} />
            Seated only
          </label>
          {filters !== NO_FILTERS && (
            <button type="button" className="link" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
          )}
        </div>
        <div className="toolbar">
          <label className="zoom">
            BPM
            <input type="range" min={60} max={180} step={1} value={bpm} onChange={(e) => setBpm(Number(e.target.value))} />
            <span className="mono">{bpm}</span>
          </label>
          <label className="check" title="Mirrored = the coach view: the dancer's right arm is on screen right">
            <input type="checkbox" checked={mirrored} onChange={(e) => setMirrored(e.target.checked)} />
            Mirrored (coach view)
          </label>
          <label className="check" title="Stage 3 coach renderer (glowing silhouette) instead of the stick figure">
            <input type="checkbox" checked={coachLook} onChange={(e) => setCoachLook(e.target.checked)} />
            Coach look
          </label>
          {coachLook && (
            <label>
              Theme
              <select value={theme} onChange={(e) => setTheme(e.target.value)}>
                {THEME_NAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!coachLook && (
            <label className="check">
              <input type="checkbox" checked={lrColors} onChange={(e) => setLrColors(e.target.checked)} />
              L/R colours
            </label>
          )}
          {coachLook && <span className="hint">accent gloves = scored</span>}
          {!coachLook && lrColors && (
            <span className="hint">
              <span style={{ color: LEFT_COLOR }}>■ dancer's left</span> · <span style={{ color: RIGHT_COLOR }}>■ dancer's right</span> · gold halo = scored
            </span>
          )}
          {!coachLook && !lrColors && <span className="hint">gold limbs = scored</span>}
        </div>
      </div>

      {state.kind === 'loading' && <p className="status">Loading moves…</p>}
      {state.kind === 'error' && (
        <p className="error">
          Couldn't load the move library: {state.message}{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              setState({ kind: 'loading' })
              setReload((n) => n + 1)
            }}
          >
            Retry
          </button>{' '}
          ·{' '}
          <button type="button" className="link" onClick={() => setState({ kind: 'ok', lib: DEMO_LIBRARY, demo: true })}>
            Show built-in demo moves
          </button>
        </p>
      )}
      {state.kind === 'ok' && shown.length === 0 && <p className="status">No moves match these filters.</p>}

      <div className="move-grid">
        {shown.map((m) => (
          <MoveCard key={m.id} move={m} loop={loop} settings={settingsRef} onOpen={onOpen} />
        ))}
      </div>

      {open && <MoveDetail move={open} loop={loop} settings={settings} onClose={onClose} />}
    </section>
  )
}
