// Canvas renderer for the analysis debug timeline. Rows (top to bottom): sections, routine
// moves, beat energy, onset envelope, beats, time axis; plus the playhead. All x math in
// timeline.ts.

import type { Analysis } from '@shared/analysis'
import type { Move } from '@shared/routine'
import { prepareCanvas } from '../lib/canvas'
import { intensityColor } from '../routine/library'
import { lastStartedIndex } from '../routine/pose'
import {
  beatIndexAt,
  formatTime,
  groupColor,
  isDownbeatIndex,
  niceTimeStep,
  pxPerSec,
  timeToX,
  withAlpha,
  type TimelineView,
} from './timeline'

/** CSS height the canvas must have (see .analysis-timeline). */
export const TIMELINE_HEIGHT = 268

const ROW = {
  sections: { top: 0, h: 36 },
  moves: { top: 42, h: 26 },
  energy: { top: 74, h: 58 },
  onset: { top: 138, h: 48 },
  beats: { top: 192, h: 52 },
  axis: { top: 246, h: 22 },
} as const

export type TimelineMove = Pick<Move, 'startTime' | 'endTime' | 'name' | 'intensity'>

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const BAR_LABEL_EVERY = 4

export interface TimelineFrame {
  analysis: Analysis
  /** analysis.filledBeats as a set. */
  filled: ReadonlySet<number>
  /** zoom + scrollSec (durationSec/widthPx are filled in from the analysis/canvas). */
  zoom: number
  scrollSec: number
  playhead: number
  activeSection: number
  /** Routine moves in playback order (Moves row); empty/undefined = no routine. */
  moves?: readonly TimelineMove[]
  /** Index of the move playing at the playhead, or -1. */
  activeMove?: number
}

/** Draws one frame; returns the view used (for hit-testing clicks), or null if hidden. */
export function drawTimeline(canvas: HTMLCanvasElement, f: TimelineFrame): TimelineView | null {
  const prepared = prepareCanvas(canvas)
  if (!prepared) return null
  const { ctx, width, height } = prepared
  const a = f.analysis
  const view: TimelineView = { durationSec: a.durationSec, widthPx: width, zoom: f.zoom, scrollSec: f.scrollSec }
  const pps = pxPerSec(view)
  const t0 = view.scrollSec
  const t1 = t0 + (pps > 0 ? width / pps : 0)
  const x = (t: number): number => timeToX(view, t)

  ctx.fillStyle = 'rgba(148, 163, 255, 0.05)'
  ctx.fillRect(0, 0, width, height)
  if (!(pps > 0)) return view

  // Time grid behind everything.
  const step = niceTimeStep(pps)
  ctx.font = `11px ${MONO}`
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 1
  for (let s = Math.floor(t0 / step) * step; s <= t1; s += step) {
    const gx = Math.round(x(s)) + 0.5
    ctx.strokeStyle = 'rgba(203, 213, 255, 0.08)'
    ctx.beginPath()
    ctx.moveTo(gx, ROW.energy.top)
    ctx.lineTo(gx, ROW.axis.top + 4)
    ctx.stroke()
    ctx.fillStyle = 'rgba(203, 213, 255, 0.55)'
    ctx.fillText(formatTime(s), gx + 3, ROW.axis.top + ROW.axis.h / 2)
  }

  // Sections: bands colored by group.
  ctx.font = `600 12px system-ui, -apple-system, sans-serif`
  a.sections.forEach((s, i) => {
    const x0 = x(s.start)
    const x1 = x(s.end)
    if (x1 < 0 || x0 > width) return
    const color = groupColor(s.group)
    const { top, h } = ROW.sections
    ctx.fillStyle = withAlpha(color, i === f.activeSection ? 0.42 : 0.22)
    ctx.fillRect(x0, top, x1 - x0, h)
    ctx.fillStyle = color
    ctx.fillRect(x0, top, x1 - x0, 3)
    ctx.fillRect(x0, top, 1.5, h)
    ctx.save()
    ctx.beginPath()
    ctx.rect(x0 + 2, top, x1 - x0 - 4, h)
    ctx.clip()
    ctx.fillStyle = '#eef0fb'
    ctx.fillText(`${s.label} · ${s.group}`, Math.max(x0, 0) + 7, top + h / 2 + 2)
    ctx.restore()
  })

  // Moves: blocks spanning their beats, coloured by intensity, a divider at each start.
  if (f.moves && f.moves.length > 0) {
    const { top, h } = ROW.moves
    ctx.font = `600 11px system-ui, -apple-system, sans-serif`
    ctx.textBaseline = 'middle'
    for (let i = Math.max(0, lastStartedIndex(f.moves, t0)); i < f.moves.length; i++) {
      const m = f.moves[i]
      if (m.startTime > t1) break
      const x0 = x(m.startTime)
      const x1 = x(m.endTime)
      const color = intensityColor(m.intensity)
      ctx.fillStyle = withAlpha(color, i === f.activeMove ? 0.62 : 0.3)
      ctx.fillRect(x0, top, x1 - x0, h)
      ctx.fillStyle = color
      ctx.fillRect(x0, top, 1.5, h)
      if (x1 - x0 > 34) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x0 + 3, top, x1 - x0 - 6, h)
        ctx.clip()
        ctx.fillStyle = '#eef0fb'
        ctx.fillText(m.name, Math.max(x0, 0) + 6, top + h / 2 + 1)
        ctx.restore()
      }
    }
  }

  const beats = a.beats
  const first = Math.max(0, beatIndexAt(beats, t0))
  const last = Math.min(beats.length - 1, beatIndexAt(beats, t1) + 1)
  const beatEnd = (i: number): number => beats[i + 1] ?? Math.max(a.durationSec, beats[i])

  // Beat energy: one bar per beat interval.
  {
    const { top, h } = ROW.energy
    for (let i = first; i <= last; i++) {
      const e = a.beatEnergy[i]
      if (e === undefined) continue
      const x0 = x(beats[i])
      const w = x(beatEnd(i)) - x0
      const bh = Math.max(1, e * h)
      ctx.fillStyle = f.filled.has(i) ? 'rgba(125, 211, 252, 0.25)' : 'rgba(125, 211, 252, 0.6)'
      ctx.fillRect(x0, top + h - bh, Math.max(1, w > 6 ? w - 1.5 : w), bh)
    }
  }

  // Onset envelope: line over the visible samples.
  {
    const { top, h } = ROW.onset
    const { hopSec, values } = a.onsetEnvelope
    if (hopSec > 0 && values.length > 0) {
      const i0 = Math.max(0, Math.floor(t0 / hopSec) - 1)
      const i1 = Math.min(values.length - 1, Math.ceil(t1 / hopSec) + 1)
      ctx.strokeStyle = '#c4b5fd'
      ctx.lineWidth = 1.25
      ctx.lineJoin = 'round'
      ctx.beginPath()
      for (let i = i0; i <= i1; i++) {
        const px = x(i * hopSec)
        const py = top + h - Math.min(1, Math.max(0, values[i])) * h
        if (i === i0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.stroke()
    }
  }

  // Beats: thin ticks, filled beats dimmed + dashed, downbeats thick with bar numbers.
  {
    const { top, h } = ROW.beats
    const barSec = a.bpm > 0 ? (60 / a.bpm) * a.beatsPerBar : 2
    let labelEvery = BAR_LABEL_EVERY
    while (labelEvery * barSec * pps < 30 && labelEvery < 1024) labelEvery *= 2
    ctx.font = `10px ${MONO}`
    ctx.textBaseline = 'top'
    for (let i = first; i <= last; i++) {
      const bx = Math.round(x(beats[i])) + 0.5
      const down = isDownbeatIndex(i, a.downbeatPhase, a.beatsPerBar)
      const filled = f.filled.has(i)
      ctx.setLineDash(filled ? [3, 3] : [])
      ctx.lineWidth = down ? 2.5 : 1
      ctx.strokeStyle = down
        ? filled
          ? 'rgba(238, 240, 251, 0.4)'
          : '#eef0fb'
        : filled
          ? 'rgba(125, 211, 252, 0.3)'
          : 'rgba(125, 211, 252, 0.75)'
      ctx.beginPath()
      ctx.moveTo(bx, down ? top + 12 : top + h * 0.45)
      ctx.lineTo(bx, top + h)
      ctx.stroke()
      if (down) {
        const bar = (i - a.downbeatPhase) / a.beatsPerBar + 1
        if ((bar - 1) % labelEvery === 0) {
          ctx.fillStyle = 'rgba(238, 240, 251, 0.85)'
          ctx.fillText(String(bar), bx + 3, top)
        }
      }
    }
    ctx.setLineDash([])
  }

  // Row labels on a dark backing so the data never hides them.
  ctx.font = `10px ${MONO}`
  ctx.textBaseline = 'top'
  const rowLabel = (text: string, y: number): void => {
    ctx.fillStyle = 'rgba(7, 10, 24, 0.75)'
    ctx.fillRect(2, y - 1, ctx.measureText(text).width + 6, 13)
    ctx.fillStyle = 'rgba(143, 151, 191, 0.95)'
    ctx.fillText(text, 5, y + 1)
  }
  if (!f.moves?.length) rowLabel('MOVES · generate a routine below', ROW.moves.top + 6)
  rowLabel('ENERGY', ROW.energy.top)
  rowLabel('ONSET', ROW.onset.top)
  rowLabel('BEATS', ROW.beats.top + ROW.beats.h - 13) // bottom: bar numbers sit at the top

  // Playhead.
  const px = x(f.playhead)
  if (px >= -2 && px <= width + 2) {
    ctx.strokeStyle = '#facc15'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, ROW.axis.top)
    ctx.stroke()
  }
  return view
}
