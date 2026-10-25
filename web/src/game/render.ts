// Draws one play-screen frame on a canvas: ballroom stage, the big coach, the cue strip
// (pictogram cards sliding into the hit marker, "3 · 2 · 1" beat dots) and the count-in
// overlay. Every visual is a function of the song time `t` passed in (the audio clock).

import type { Routine } from '@shared/routine'
import type { Pose2D, Vec2 } from '@shared/skeleton'
import type { Ctx2D } from '../pose/draw'
import { bodyToScreen } from '../pose/normalize'
import { coachThemeFor, drawCoach, type CoachTheme, type CoachView } from '../render/coach'
import { drawPictogram, type Box } from '../render/pictogram'
import { drawStage } from '../render/stage'
import { figureBodyView, fitFigureView } from '../render/stickFigure'
import type { MotionTrack } from '../routine/track'
import {
  beatPulse,
  countdownAt,
  layoutCueStrip,
  moveCountdown,
  sectionAt,
  type CueCard,
  type GameTimeline,
} from './cues'

/** Height of the HTML top bar the canvas leaves room for (CSS px). */
export const TOP_BAR_PX = 64

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export interface PlayLayout {
  coach: CoachView
  /** Region between the top bar and the cue strip (the coach's stage). */
  coachArea: Box
  strip: Box
  card: { w: number; h: number; y: number }
  gap: number
  /** Hit marker centre x. */
  hitX: number
}

export function playLayout(width: number, height: number, mirrored: boolean): PlayLayout {
  const cardH = Math.round(clamp(height * 0.14, 64, 124))
  const cardW = Math.round(cardH * 0.8)
  const gap = Math.round(cardW * 0.18)
  const padTop = 26
  const padBottom = 24
  const stripW = Math.max(0, Math.min(width - 24, 940))
  const stripH = cardH + padTop + padBottom
  const strip: Box = { x: (width - stripW) / 2, y: height - stripH - 12, w: stripW, h: stripH }
  const coachArea: Box = { x: 0, y: TOP_BAR_PX, w: width, h: Math.max(0, strip.y - 8 - TOP_BAR_PX) }
  const fv = fitFigureView(coachArea.w, coachArea.h, mirrored)
  return {
    coach: { ...fv, floorY: fv.floorY + coachArea.y },
    coachArea,
    strip,
    card: { w: cardW, h: cardH, y: strip.y + padTop },
    gap,
    hitX: strip.x + 19 + cardW / 2,
  }
}

export interface PlayFrame {
  /** Song time, seconds (negative during the count-in lead-in). */
  t: number
  routine: Pick<Routine, 'moves' | 'song'>
  track: MotionTrack
  timeline: GameTimeline
  durationSec: number
  mirrored: boolean
}

export interface PlayFrameInfo {
  section: string
  theme: CoachTheme
  /** 0..1 through the song. */
  progress: number
  layout: PlayLayout
  /** Screen point beside the coach's head where judgment pops appear (see popPlacement). */
  popAnchor: Vec2
  /** Which way pop text runs from popAnchor. */
  popAlign: PopPlacement['align']
  /** Move being danced now / up next (-1 = none). */
  moveIndex: number
  nextMoveIndex: number
}

/** Pop text size (px) for a coach area of height `areaH` (drawPops uses the same). */
export const popFontSize = (areaH: number): number => Math.round(Math.max(26, Math.min(64, areaH * 0.075)))

/** Rough width (px) of the widest pop ("PERFECT!" at its 1.15 overshoot) for a font size. */
export const popTextWidth = (size: number): number => size * 0.62 * 8 * 1.15

/** Where judgment pops go and which way their text runs from the anchor. */
export interface PopPlacement {
  anchor: Vec2
  /** 'right': the text ends at the anchor (pops left of the face); 'left': it starts there; 'center': over the head (phones). */
  align: 'left' | 'right' | 'center'
}

/** The coach's head on screen: centre and a radius (face box half-size). */
function headOnScreen(pose: Pose2D, root: Vec2, L: Pick<PlayLayout, 'coach'>): { c: Vec2; r: number } {
  const bv = figureBodyView(L.coach, root)
  const s = L.coach.scale
  const pts = [pose.nose, pose.l_ear, pose.r_ear, pose.l_eye, pose.r_eye].filter((p): p is Vec2 => p !== undefined)
  const body: Vec2 = pts.length > 0 ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length] : [0, -1.45]
  return { c: bodyToScreen(body, bv), r: 0.38 * s }
}

/**
 * Judgment pops sit beside the coach's head, never over the face: right-aligned just left of
 * the face (away from the score panel and webcam PIP on the right), or left-aligned just right
 * of it when the coach has danced too close to the left edge. Vertically at head height, kept
 * inside the coach area.
 */
export function popPlacement(pose: Pose2D, root: Vec2, L: Pick<PlayLayout, 'coach' | 'coachArea'>): PopPlacement {
  const a = L.coachArea
  const { c, r } = headOnScreen(pose, root, L)
  const gap = Math.max(14, 0.22 * L.coach.scale)
  const size = popFontSize(a.h)
  const textW = popTextWidth(size)
  const y = clamp(c[1], a.y + size * 0.9, a.y + Math.max(size * 0.9, a.h - size))
  const leftX = c[0] - r - gap
  // phones: no room beside the head on either side, so centre it above the head
  if (textW > a.w / 2 - 8) return { anchor: [a.x + a.w / 2, clamp(c[1] - r - size * 0.6, a.y + size * 0.9, a.y + Math.max(size * 0.9, a.h - size))], align: 'center' }
  if (leftX - textW >= a.x + 8 || leftX - a.x >= a.x + a.w - (c[0] + r + gap)) {
    return { anchor: [clamp(leftX, a.x + Math.min(textW, a.w / 2), a.x + a.w), y], align: 'right' }
  }
  return { anchor: [clamp(c[0] + r + gap, a.x, a.x + a.w - Math.min(textW, a.w / 2)), y], align: 'left' }
}

/** popPlacement's anchor (kept for callers that only need the point). */
export function popAnchor(pose: Pose2D, root: Vec2, L: Pick<PlayLayout, 'coach' | 'coachArea'>): Vec2 {
  return popPlacement(pose, root, L).anchor
}

export function renderPlayFrame(ctx: Ctx2D, width: number, height: number, f: PlayFrame): PlayFrameInfo {
  const { t, routine, timeline } = f
  const label = sectionAt(routine.song.sections, Math.max(0, t))?.label ?? 'intro'
  const theme = coachThemeFor(label)
  const pulse = beatPulse(timeline.pulseBeats, t)
  const L = playLayout(width, height, f.mirrored)

  drawStage(ctx, { width, height, time: t, beatPulse: pulse, theme, floor: { x: L.coach.cx, y: L.coach.floorY, scale: L.coach.scale } })
  const sample = f.track.sample(t)
  const move = sample.moveIndex >= 0 ? routine.moves[sample.moveIndex] : undefined
  drawCoach(ctx, sample.pose, sample.root, L.coach, { theme, beatPulse: pulse, highlightJoints: move?.scoredJoints })
  drawCueStrip(ctx, L, f, theme, pulse)
  drawCountIn(ctx, L, timeline, t, theme)

  const dur = f.durationSec > 0 ? f.durationSec : routine.song.durationSec
  const pop = popPlacement(sample.pose, sample.root, L)
  return {
    section: label,
    theme,
    progress: dur > 0 ? clamp(t / dur, 0, 1) : 0,
    layout: L,
    popAnchor: pop.anchor,
    popAlign: pop.align,
    moveIndex: sample.moveIndex,
    nextMoveIndex: sample.nextMoveIndex,
  }
}

/** Backdrop while the routine is loading (ambient time from the frame clock; no song yet). */
export function renderIdleStage(ctx: Ctx2D, width: number, height: number, timeSec: number): void {
  drawStage(ctx, { width, height, time: timeSec, beatPulse: 0, theme: coachThemeFor('intro') })
}

// --- cue strip ---------------------------------------------------------------------------

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.min(r, w / 2, h / 2))
}

function drawCueStrip(ctx: Ctx2D, L: PlayLayout, f: PlayFrame, theme: CoachTheme, pulse: number): void {
  const { strip, card, hitX, gap } = L
  const { routine, timeline, t } = f
  if (strip.w <= 0) return
  ctx.save()

  // Panel.
  const bg = ctx.createLinearGradient(0, strip.y, 0, strip.y + strip.h)
  bg.addColorStop(0, 'rgba(248, 240, 222, 0.94)')
  bg.addColorStop(1, 'rgba(234, 223, 199, 0.94)')
  roundRect(ctx, strip.x, strip.y, strip.w, strip.h, 20)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.lineWidth = 4
  ctx.strokeStyle = '#fffaf0'
  ctx.stroke()

  // Cards, clipped to the panel.
  ctx.save()
  roundRect(ctx, strip.x, strip.y, strip.w, strip.h, 20)
  ctx.clip()
  const cards = layoutCueStrip(routine.moves, t, {
    hitX,
    leftX: strip.x,
    rightX: strip.x + strip.w,
    cardW: card.w,
    gap,
    slotSec: timeline.slotSec,
  })
  for (const c of cards) drawCueCard(ctx, c, routine.moves[c.index], L, theme, f.mirrored, pulse)
  ctx.restore()

  // Hit marker (pulses on the beat).
  ctx.shadowColor = '#dbb35e'
  ctx.shadowBlur = 8 + 18 * pulse
  ctx.strokeStyle = '#963248'
  ctx.globalAlpha = 0.6 + 0.4 * pulse
  ctx.lineWidth = 2 + 1.5 * pulse
  roundRect(ctx, hitX - card.w / 2 - 5, card.y - 5, card.w + 10, card.h + 10, 15)
  ctx.stroke()
  ctx.restore()

  // "3 · 2 · 1" before each move change (the first one follows the count-in).
  const cd = countdownAt(timeline.countdown, t)
  const n = cd ? Number(cd.label) || 0 : moveCountdown(routine.song.beats, routine.moves, t)
  drawBeatDots(ctx, hitX, strip.y + 14, n, theme, pulse)
}

function drawCueCard(
  ctx: Ctx2D,
  c: CueCard,
  move: Routine['moves'][number],
  L: PlayLayout,
  theme: CoachTheme,
  mirrored: boolean,
  pulse: number,
): void {
  const { w, h, y } = L.card
  const x0 = c.x - w / 2
  ctx.save()
  ctx.globalAlpha = c.alpha
  // The pictogram paints the themed card itself (one card, not a card inside a card); the
  // border goes on top, matching its corner radius.
  drawPictogram(ctx, move, { x: x0, y, w, h }, { mirrored, theme, active: c.active })
  roundRect(ctx, x0, y, w, h, Math.min(w, h) * 0.17)
  if (c.active) {
    ctx.shadowColor = '#dbb35e'
    ctx.shadowBlur = 12 + 12 * pulse
  }
  ctx.lineWidth = c.active ? 2.5 : 1.25
  ctx.strokeStyle = c.active ? '#963248' : 'rgba(91, 74, 59, 0.3)'
  ctx.stroke()
  ctx.shadowBlur = 0

  if (c.active) {
    ctx.fillStyle = '#963248'
    roundRect(ctx, x0 + 8, y + h - 6, (w - 16) * c.progress, 3, 1.5)
    ctx.fill()
  }
  ctx.font = `700 ${Math.round(clamp(h * 0.12, 12, 16))}px Figtree, system-ui, -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = c.active ? '#2e2421' : '#5b4a3b'
  ctx.fillText(move.name, c.x, y + h + 16, w + L.gap - 6)
  ctx.restore()
}

/** Beat digits "3 · 2 · 1": the current one big and bright, counted ones lit, upcoming ones faint. */
function drawBeatDots(ctx: Ctx2D, cx: number, y: number, n: number, theme: CoachTheme, pulse: number): void {
  if (n <= 0) return
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < 3; i++) {
    const k = 3 - i
    const x = cx + (i - 1) * 24
    if (i > 0) {
      ctx.fillStyle = 'rgba(91, 74, 59, 0.5)'
      ctx.beginPath()
      ctx.arc(x - 12, y, 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
    const current = k === n
    const lit = k >= n
    ctx.font = `800 ${current ? Math.round(15 + 4 * pulse) : 12}px Figtree, system-ui, -apple-system, sans-serif`
    ctx.shadowColor = theme.accent
    ctx.shadowBlur = current ? 10 + 10 * pulse : 0
    ctx.fillStyle = current ? '#963248' : lit ? '#75561f' : 'rgba(91, 74, 59, 0.4)'
    ctx.fillText(String(k), x, y)
  }
  ctx.restore()
}

// --- count-in overlay ----------------------------------------------------------------------

/** Count-in overlay ("Get ready…", then "3 · 2 · 1 · Dance!" over the coach's chest). */
export function drawCountIn(ctx: Ctx2D, L: Pick<PlayLayout, 'coachArea'>, timeline: Pick<GameTimeline, 'countdown'>, t: number, theme: CoachTheme): void {
  const area = L.coachArea
  if (area.w <= 0 || area.h <= 0) return
  const cx = area.x + area.w / 2
  const times = timeline.countdown.times
  const cd = countdownAt(timeline.countdown, t)
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = theme.glow
  if (!cd) {
    if (times.length > 0 && t < times[0]) {
      ctx.globalAlpha = 0.9
      ctx.shadowBlur = 18
      ctx.fillStyle = '#fffaf0'
      ctx.font = `italic 600 ${Math.round(clamp(area.h * 0.06, 20, 40))}px Fraunces, Georgia, 'Times New Roman', serif`
      ctx.fillText('Get ready…', cx, area.y + area.h * 0.12)
    }
    ctx.restore()
    return
  }
  const go = cd.label === 'Dance!'
  const base = Math.min(area.w, area.h) * (go ? 0.17 : 0.32)
  const pop = 1 + 0.35 * Math.pow(1 - cd.phase, 3)
  ctx.globalAlpha = go ? 1 - cd.phase * cd.phase : 1 - 0.7 * cd.phase * cd.phase
  const size = Math.round(base * pop)
  const y = area.y + area.h * 0.42
  ctx.font = go ? `italic 800 ${size}px Fraunces, Georgia, serif` : `800 ${size}px Figtree, system-ui, sans-serif`
  // Dark outline first: the digits sit over the (white) coach's chest and must still read.
  ctx.shadowBlur = 36
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(3, size * 0.09)
  ctx.strokeStyle = 'rgba(150, 50, 72, 0.95)'
  ctx.strokeText(cd.label, cx, y)
  ctx.shadowBlur = 0
  ctx.fillStyle = '#fffaf0'
  ctx.fillText(cd.label, cx, y)
  ctx.restore()
}
