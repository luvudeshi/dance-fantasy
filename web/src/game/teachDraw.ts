// Draws one teach-mode frame: the ballroom stage, the big coach (the current move's scored limbs
// in accent, the limbs the player just got wrong glowing red), the "5 6 7 8" count-in, the
// 8-count bar (move blocks over beats 1..8, the current beat lit) and the webcam PIP. Every
// visual is a function of the song time `t` (TeachClock) plus wall-clock fades.

import type { Routine } from '@shared/routine'
import { LIMBS, type LimbEnd, type LimbName, type Pose2D, type Vec2 } from '@shared/skeleton'
import type { Ctx2D } from '../pose/draw'
import { bodyToScreen } from '../pose/normalize'
import { coachThemeFor, drawCoach, withAlpha, type CoachTheme, type CoachView } from '../render/coach'
import type { Box } from '../render/pictogram'
import { drawStage } from '../render/stage'
import { figureBodyView, fitFigureView } from '../render/stickFigure'
import type { MotionTrack } from '../routine/track'
import { beatPulse, sectionAt } from './cues'
import { drawPip, type PipFrame } from './hud'
import { beatInSegment, countInAt, type TeachSegment } from './teach'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'
const SERIF = "Georgia, 'Times New Roman', serif"
export const WRONG_COLOR = '#ff4d6d'

export interface TeachLayout {
  coachArea: Box
  coach: CoachView
  /** The 8-count bar along the bottom. */
  bar: Box
}

export function teachLayout(width: number, height: number): TeachLayout {
  const barH = Math.round(clamp(height * 0.15, 64, 104))
  const bar: Box = { x: 12, y: height - barH - 12, w: Math.max(0, width - 24), h: barH }
  const coachArea: Box = { x: 0, y: 0, w: width, h: Math.max(0, bar.y - 6) }
  const fv = fitFigureView(coachArea.w, coachArea.h, true)
  return { coachArea, coach: { ...fv, floorY: fv.floorY + coachArea.y }, bar }
}

/** PIP box: bottom-right above the 8-count bar. */
export function teachPipBox(width: number, L: Pick<TeachLayout, 'bar' | 'coachArea'>, aspect = 4 / 3): Box {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 4 / 3
  let w = clamp(width * 0.22, 120, 280)
  let h = w / a
  const room = L.coachArea.h - 24
  if (room > 40 && h > room * 0.5) {
    h = room * 0.5
    w = h * a
  }
  return { x: width - w - 16, y: L.bar.y - h - 10, w, h }
}

export interface TeachFrame {
  /** Song time (s). */
  t: number
  routine: Pick<Routine, 'moves' | 'song'>
  track: MotionTrack
  segment: TeachSegment
  /** Limb -> red tint strength 0..1 (fading). */
  wrong: ReadonlyMap<LimbName, number>
  pip: (PipFrame & { aspect: number }) | null
}

function endPoint(p: Pose2D, e: LimbEnd): Vec2 | undefined {
  const mid = (a: Vec2 | undefined, b: Vec2 | undefined): Vec2 | undefined => (a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : undefined)
  if (e === 'mid_hip') return mid(p.l_hip, p.r_hip)
  if (e === 'mid_shoulder') return mid(p.l_shoulder, p.r_shoulder)
  return p[e]
}

/** Red glow along the limbs the player got wrong (over the coach; same mirrored mapping). */
export function drawWrongLimbs(ctx: Ctx2D, pose: Pose2D, root: Vec2, view: CoachView, wrong: ReadonlyMap<LimbName, number>): void {
  if (wrong.size === 0) return
  const bv = figureBodyView(view, root)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.shadowColor = WRONG_COLOR
  for (const [limb, alpha] of wrong) {
    if (!(alpha > 0)) continue
    const [a, b] = LIMBS[limb]
    const pa = endPoint(pose, a)
    const pb = endPoint(pose, b)
    if (!pa || !pb) continue
    const [x0, y0] = bodyToScreen(pa, bv)
    const [x1, y1] = bodyToScreen(pb, bv)
    ctx.globalAlpha = clamp(alpha, 0, 1)
    ctx.shadowBlur = view.scale * 0.35
    ctx.strokeStyle = withAlpha(WRONG_COLOR, 0.75)
    ctx.lineWidth = Math.max(4, view.scale * (limb === 'torso' ? 0.32 : 0.2))
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
  }
  ctx.restore()
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, Math.min(r, w / 2, h / 2)))
}

/** "5 · 6 · 7 · 8" over the coach's chest before each pass. */
function drawCountIn(ctx: Ctx2D, area: Box, seg: TeachSegment, t: number, theme: CoachTheme): void {
  const c = countInAt(seg, t)
  if (!c || area.w <= 0 || area.h <= 0) return
  const pop = 1 + 0.3 * Math.pow(1 - c.phase, 3)
  const size = Math.round(Math.min(area.w, area.h) * 0.26 * pop)
  const x = area.x + area.w / 2
  const y = area.y + area.h * 0.42
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.globalAlpha = 1 - 0.6 * c.phase * c.phase
  ctx.font = `800 ${size}px ${SERIF}`
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(3, size * 0.09)
  ctx.shadowColor = theme.glow
  ctx.shadowBlur = 30
  ctx.strokeStyle = 'rgba(22, 12, 58, 0.9)'
  ctx.strokeText(c.label, x, y)
  ctx.shadowBlur = 0
  ctx.fillStyle = '#ffffff'
  ctx.fillText(c.label, x, y)
  ctx.restore()
}

/** Move blocks over numbered beat cells; the current beat (and move) lit. */
function drawCountBar(ctx: Ctx2D, bar: Box, f: TeachFrame, theme: CoachTheme, pulse: number): void {
  const { segment: seg, routine, t } = f
  const beats = routine.song.beats
  const n = Math.max(1, Math.min(16, seg.endBeat - seg.startBeat))
  if (bar.w <= 0 || bar.h <= 0) return
  ctx.save()
  roundRect(ctx, bar.x, bar.y, bar.w, bar.h, 16)
  ctx.fillStyle = 'rgba(14, 12, 44, 0.74)'
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(196, 181, 253, 0.22)'
  ctx.stroke()

  const pad = 10
  const cellW = (bar.w - pad * 2) / n
  const moveH = Math.round((bar.h - pad * 2) * 0.48)
  const beatY = bar.y + pad + moveH + 6
  const beatH = bar.y + bar.h - pad - beatY
  const pos = beatInSegment(beats, seg, t) > 0 ? beatIndexIn(beats, seg, t) - seg.startBeat : -1
  const playingIdx = t >= seg.start && t < seg.end ? f.track.sample(t).moveIndex : -1

  // Move blocks.
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const mi of seg.moveIndices) {
    const m = routine.moves[mi]
    const b0 = clamp(m.startBeat - seg.startBeat, 0, n)
    const b1 = clamp(m.startBeat - seg.startBeat + m.lengthBeats, 0, n)
    if (b1 <= b0) continue
    const x = bar.x + pad + b0 * cellW + 2
    const w = (b1 - b0) * cellW - 4
    const active = mi === playingIdx
    roundRect(ctx, x, bar.y + pad, w, moveH, 8)
    ctx.fillStyle = active ? withAlpha(theme.accent, 0.3) : 'rgba(196, 181, 253, 0.1)'
    ctx.fill()
    ctx.lineWidth = active ? 2 : 1
    ctx.strokeStyle = active ? theme.accent : 'rgba(196, 181, 253, 0.28)'
    ctx.stroke()
    ctx.font = `600 ${Math.round(clamp(moveH * 0.36, 10, 15))}px ${FONT}`
    ctx.fillStyle = active ? '#ffffff' : 'rgba(226, 232, 255, 0.78)'
    ctx.fillText(m.name, x + w / 2, bar.y + pad + moveH / 2, w - 10)
  }

  // Beat cells "1 .. 8".
  for (let i = 0; i < n; i++) {
    const cx = bar.x + pad + (i + 0.5) * cellW
    const num = (i % 8) + 1
    const isNow = i === pos
    const done = i < pos
    const r = Math.min(cellW * 0.36, beatH * 0.5)
    ctx.beginPath()
    ctx.arc(cx, beatY + beatH / 2, isNow ? r * (1 + 0.15 * pulse) : r * 0.82, 0, Math.PI * 2)
    ctx.fillStyle = isNow ? theme.accent : done ? withAlpha(theme.accent, 0.28) : 'rgba(196, 181, 253, 0.08)'
    if (isNow) {
      ctx.shadowColor = theme.accent
      ctx.shadowBlur = 10 + 12 * pulse
    }
    ctx.fill()
    ctx.shadowBlur = 0
    ctx.font = `800 ${Math.round(clamp(r * 0.95, 10, 18))}px ${FONT}`
    ctx.fillStyle = isNow ? '#1b1036' : 'rgba(226, 232, 255, 0.75)'
    ctx.fillText(String(num), cx, beatY + beatH / 2 + 1)
  }
  ctx.restore()
}

function beatIndexIn(beats: readonly number[], seg: TeachSegment, t: number): number {
  let i = seg.startBeat
  while (i + 1 < seg.endBeat && i + 1 < beats.length && beats[i + 1] <= t + 0.02) i++
  return i
}

export function drawTeachFrame(ctx: Ctx2D, width: number, height: number, f: TeachFrame): TeachLayout {
  const { t, routine, segment } = f
  const L = teachLayout(width, height)
  const label = sectionAt(routine.song.sections, Math.max(0, t))?.label ?? segment.section
  const theme = coachThemeFor(label)
  const pulse = beatPulse(routine.song.beats, t)
  drawStage(ctx, { width, height, time: t, beatPulse: pulse, theme, floor: { x: L.coach.cx, y: L.coach.floorY, scale: L.coach.scale } })
  const sample = f.track.sample(t)
  const move = sample.moveIndex >= 0 ? routine.moves[sample.moveIndex] : undefined
  drawCoach(ctx, sample.pose, sample.root, L.coach, { theme, beatPulse: pulse, highlightJoints: move?.scoredJoints })
  drawWrongLimbs(ctx, sample.pose, sample.root, L.coach, f.wrong)
  drawCountIn(ctx, L.coachArea, segment, t, theme)
  drawCountBar(ctx, L.bar, f, theme, pulse)
  if (f.pip) drawPip(ctx, teachPipBox(width, L, f.pip.aspect), f.pip)
  return L
}
