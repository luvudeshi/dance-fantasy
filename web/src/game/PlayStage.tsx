// Full-window play stage: one canvas redrawn every animation frame from the audio clock
// (clock.songTime()), an HTML top bar (song, section, progress) updated from the same frame,
// the D debug overlay and whatever overlays the page passes as children. With a scored run,
// each frame also ticks the run (bot, then scoring) and paints the HUD and the webcam PIP.

import { useEffect, useRef, type ReactNode } from 'react'
import { prepareCanvas } from '../lib/canvas'
import { RateMeter } from '../lib/rateMeter'
import { useLatest } from '../lib/useLatest'
import type { GameClock } from './clock'
import { drawHud, drawPip, pipBox } from './hud'
import { renderIdleStage, renderPlayFrame } from './render'
import type { GameRun } from './run'
import type { PreparedGame } from './session'
import { estimateSongTime, type SyncMonitor, type SyncStats } from './sync'

export interface ActiveGame {
  game: PreparedGame
  monitor: SyncMonitor
  /** The scored play-through (pose source + ScoreKeeper + HUD); null = coach only. */
  run?: GameRun | null
}

interface Props {
  clock: GameClock
  active: ActiveGame | null
  mirrored: boolean
  debug: boolean
  /** Webcam picture-in-picture (C). */
  pip: boolean
  paused: boolean
  title: string
  subtitle: string
  onTogglePause: () => void
  onExit: () => void
  children?: ReactNode
}

const DEBUG_REFRESH_MS = 250

const ms = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`

function debugText(o: {
  fps: number
  frameMs: number
  renderMs: number
  latencyMs: number
  t: number
  playing: boolean
  s: SyncStats | null
}): string {
  const { s } = o
  return [
    `fps      ${o.fps.toFixed(0).padStart(3)}   frame ${o.frameMs.toFixed(1)} ms   draw ${o.renderMs.toFixed(1)} ms`,
    `latency  ${o.latencyMs.toFixed(1)} ms (base + output)`,
    `song t   ${o.t.toFixed(3)} s ${o.playing ? '▶' : '❚❚'}`,
    s
      ? `drift    last ${s.lastDriftMs === null ? '–' : ms(s.lastDriftMs)}  mean ${ms(s.meanDriftMs)}  p95 ${s.p95DriftMs.toFixed(1)}  max ${s.maxDriftMs.toFixed(1)} ms`
      : 'drift    –',
    s ? `         beats ${s.beats}  rejected ${s.rejected}` : '',
    s ? `frames   long ${s.longFrames} / ${s.frames}  (worst ${s.maxFrameMs.toFixed(1)} ms)` : '',
  ].join('\n')
}

export default function PlayStage(props: Props) {
  const { clock, active, mirrored, debug, pip, paused, title, subtitle, onTogglePause, onExit, children } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sectionRef = useRef<HTMLSpanElement>(null)
  const progressRef = useRef<HTMLSpanElement>(null)
  const debugRef = useRef<HTMLPreElement>(null)
  const viewRef = useLatest({ mirrored, debug, pip })

  // The frame loop: everything visual is derived from clock.songTime() each frame.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const monitor = active?.monitor ?? null
    const fps = new RateMeter(1000)
    const drawMs = new RateMeter(1000)
    let raf = 0
    let prevFrame: number | null = null
    let lastDebug = Number.NEGATIVE_INFINITY
    let lastSection = ''
    if (sectionRef.current) sectionRef.current.textContent = ''
    if (progressRef.current) progressRef.current.style.transform = 'scaleX(0)'

    // Hidden tab: rAF stops while the audio plays on; the next frame simply reads the clock
    // again (instant resync). Only the meters need to know the stretch was broken.
    const onVisibility = (): void => {
      monitor?.breakContinuity()
      prevFrame = null
    }
    document.addEventListener('visibilitychange', onVisibility)

    const tick = (frameMs: number): void => {
      raf = requestAnimationFrame(tick)
      const t0 = performance.now()
      const view = viewRef.current
      const prepared = prepareCanvas(canvas)
      let t = 0
      if (active) {
        t = clock.songTime()
        monitor?.frame(frameMs, t, (at) => estimateSongTime(clock.outputTimestamp(), at, clock.startAt))
        // Bot first, then scoring: results finalized up to the time drawn this frame.
        const run = active.run ?? null
        run?.tick(t)
        if (prepared) {
          const { game } = active
          const info = renderPlayFrame(prepared.ctx, prepared.width, prepared.height, {
            t,
            routine: game.routine,
            track: game.track,
            timeline: game.timeline,
            durationSec: game.durationSec,
            mirrored: view.mirrored,
          })
          if (info.section !== lastSection) {
            lastSection = info.section
            if (sectionRef.current) sectionRef.current.textContent = info.section
            rootRef.current?.style.setProperty('--stage-accent', info.theme.accent)
          }
          if (progressRef.current) progressRef.current.style.transform = `scaleX(${info.progress.toFixed(4)})`
          if (run) {
            const hv = run.hud.view(performance.now(), clock.playing)
            if (view.pip) {
              const video = run.source.video
              const aspect = video && video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 4 / 3
              drawPip(prepared.ctx, pipBox(prepared.width, info.layout, aspect), {
                kind: run.source.kind,
                video,
                frame: run.source.latest(),
                tint: hv.tint,
              })
            }
            drawHud(prepared.ctx, { width: prepared.width, height: prepared.height, layout: info.layout, popAnchor: info.popAnchor }, hv)
          }
        }
      } else if (prepared) {
        renderIdleStage(prepared.ctx, prepared.width, prepared.height, frameMs / 1000)
      }

      if (prevFrame !== null && frameMs > prevFrame) fps.add(frameMs, frameMs - prevFrame)
      prevFrame = frameMs
      drawMs.add(frameMs, performance.now() - t0)
      const pre = debugRef.current
      if (view.debug && pre && frameMs - lastDebug >= DEBUG_REFRESH_MS) {
        lastDebug = frameMs
        pre.textContent = debugText({
          fps: fps.rate(frameMs),
          frameMs: fps.mean(frameMs),
          renderMs: drawMs.mean(frameMs),
          latencyMs: clock.outputLatencyMs(),
          t,
          playing: clock.playing,
          s: monitor?.stats() ?? null,
        })
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [clock, active, viewRef])

  const click = (fn: () => void) => (e: { currentTarget: HTMLElement }) => {
    e.currentTarget.blur() // keep Space for pause, not for re-clicking this button
    fn()
  }

  return (
    <div ref={rootRef} className="play-stage">
      <canvas ref={canvasRef} className="play-canvas" aria-label="Dance stage: copy the glowing dancer" />
      <header className="play-topbar">
        <div className="play-title">
          <span className="play-song">{title}</span>
          <span className="play-meta">{subtitle}</span>
        </div>
        <span ref={sectionRef} className="play-section" />
        <div className="play-progress" aria-hidden="true">
          <span ref={progressRef} />
        </div>
        <div className="play-actions">
          <button type="button" className="play-icon" onClick={click(onTogglePause)} disabled={!active} title="Pause / resume (Space)">
            {paused ? '▶' : '❚❚'}
          </button>
          <button type="button" className="play-icon" onClick={click(onExit)} title="Back to the lobby (Esc)">
            ✕
          </button>
        </div>
      </header>
      {debug && <pre ref={debugRef} className="play-debug" />}
      {children}
      <div className="play-keys">
        Space pause · R restart · M mirror ({mirrored ? 'on' : 'off'}) · C camera · D debug · Esc lobby
      </div>
    </div>
  )
}
