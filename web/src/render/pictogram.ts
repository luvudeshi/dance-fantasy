// Move pictograms for the upcoming-move cue strip, Just Dance style: a rounded card with a
// theme gradient, the mini coach in the move's key pose and motion-trail arrows showing how
// the scored hands / feet travel through the move. Layout math is pure and unit-tested.

import type { Move } from '@shared/routine'
import type { JointName, Vec2 } from '@shared/skeleton'
import type { Ctx2D } from '../pose/draw'
import { bodyToScreen } from '../pose/normalize'
import { NEUTRAL_ANKLE_Y } from '../routine/pose'
import { buildMotionTrack } from '../routine/track'
import { coach3dActive } from '../render3d/load'
import { coachThemeFor, createLayer, deviceScale, drawCoach, mixHex, withAlpha, type CoachTheme, type Layer } from './coach'
import { figureBodyView, type FigureView } from './stickFigure'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface PictogramOptions {
  mirrored: boolean
  theme?: CoachTheme
  /** true for the card whose move is about to start / playing (drawn brighter). */
  active?: boolean
  /** Draw the move's name along the bottom of the card. Default false. */
  label?: boolean
  /** Draw the card itself (gradient background + border). Default true; false = figure and trails only. */
  card?: boolean
}

export type PictogramMove = Pick<Move, 'keyframes' | 'scoredJoints' | 'name'>

const ZERO: Vec2 = [0, 0]
const world = (p: Vec2, root: Vec2 | undefined): Vec2 => [p[0] + (root ?? ZERO)[0], p[1] + (root ?? ZERO)[1]]

/**
 * Index of the keyframe that best represents the move: the one farthest from its start
 * (anchor) pose, measured on the scored joints (all joints when none are listed) plus the
 * root offset (jumps, squats). Earliest wins ties; 0 for an empty move.
 */
export function keyFrameIndex(move: Pick<Move, 'keyframes'> & Partial<Pick<Move, 'scoredJoints'>>): number {
  const kfs = move.keyframes
  const first = kfs[0]
  if (!first) return 0
  const scored = move.scoredJoints && move.scoredJoints.length > 0 ? move.scoredJoints : (Object.keys(first.pose) as JointName[])
  let best = 0
  let bestD = 0
  kfs.forEach((k, i) => {
    let d = 0
    let n = 0
    for (const j of scored) {
      const a = first.pose[j]
      const b = k.pose[j]
      if (!a || !b) continue
      d += Math.hypot(b[0] - a[0], b[1] - a[1])
      n++
    }
    const r0 = first.root ?? ZERO
    const r1 = k.root ?? ZERO
    const score = (n > 0 ? d / n : 0) + Math.hypot(r1[0] - r0[0], r1[1] - r0[1])
    if (score > bestD + 1e-9) {
      bestD = score
      best = i
    }
  })
  return best
}

/** Distal joint chains: the trail follows the most distal scored joint that actually travels. */
const CHAINS: ReadonlyArray<readonly JointName[]> = [
  ['l_wrist', 'l_elbow'],
  ['r_wrist', 'r_elbow'],
  ['l_ankle', 'l_knee'],
  ['r_ankle', 'r_knee'],
]
/** Shorter paths (body units) are not worth an arrow. */
const MIN_TRAIL = 0.3

function pathLength(pts: readonly Vec2[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return l
}

export interface Trail {
  joint: JointName
  /** World body units (pose + root), sampled along the coach's actual (rigid-limb) motion. */
  points: Vec2[]
}

const near = (a: Vec2, b: Vec2, d: number): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) < d
/** Samples per keyframe interval along a trail. */
const TRAIL_STEPS = 12
const trailCache = new WeakMap<object, { key: string; trails: Trail[] }>()

/**
 * Motion trails of the scored distal joints through the move (world body units), sampled from
 * the same motion track the coach dances, so a raised arm draws an arc. The trail starts where
 * the joint starts moving and stops before a final return to the start anchor, so an arm that
 * goes up and comes back shows one arrow up. Cached per keyframes array.
 */
export function moveTrails(move: Pick<Move, 'keyframes' | 'scoredJoints'>): Trail[] {
  const key = move.scoredJoints.join(',')
  const hit = trailCache.get(move.keyframes)
  if (hit && hit.key === key) return hit.trails
  const trails = computeTrails(move)
  trailCache.set(move.keyframes, { key, trails })
  return trails
}

function computeTrails(move: Pick<Move, 'keyframes' | 'scoredJoints'>): Trail[] {
  const kfs = move.keyframes
  const scored = new Set(move.scoredJoints)
  const out: Trail[] = []
  if (kfs.length < 2) return out
  const unit: Move = { id: 'pictogram', name: '', startBeat: 0, lengthBeats: 1, startTime: 0, endTime: 1, intensity: 1, scoredJoints: [], keyframes: kfs }
  const track = buildMotionTrack({ moves: [unit] })
  for (const chain of CHAINS) {
    if (!chain.some((j) => scored.has(j))) continue
    for (const joint of chain) {
      const P = kfs.map((k) => {
        const p = k.pose[joint]
        return p ? world(p, k.root) : null
      })
      if (P.some((p) => p === null)) continue
      const at = (i: number): Vec2 => P[i] as Vec2
      let i0 = 0
      while (i0 + 1 < P.length && near(at(i0 + 1), at(0), 0.04)) i0++
      let i1 = P.length - 1
      while (i1 > i0 + 1 && (near(at(i1), at(0), 0.15) || near(at(i1), at(i1 - 1), 0.04))) i1--
      if (i1 <= i0) continue
      const points: Vec2[] = []
      for (let i = i0; i < i1; i++) {
        for (let k = 0; k < TRAIL_STEPS; k++) {
          const u = kfs[i].t + ((kfs[i + 1].t - kfs[i].t) * k) / TRAIL_STEPS
          const smp = track.sample(u)
          const p = smp.pose[joint]
          if (p) points.push(world(p, smp.root))
        }
      }
      points.push(at(i1))
      if (pathLength(points) >= MIN_TRAIL) {
        out.push({ joint, points })
        break
      }
    }
  }
  return out
}

/** Figure view that fits `pts` (world body units, padded) centred in `box`, never larger than a standing body would allow. */
export function fitPointsView(pts: readonly Vec2[], box: Box, mirrored: boolean, pad = 0.32): FigureView {
  // Always include a standing body's extent so cards share a similar scale.
  let x0 = -0.75
  let x1 = 0.75
  let y0 = -1.75
  let y1 = NEUTRAL_ANKLE_Y + 0.08
  for (const [x, y] of pts) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  x0 -= pad
  x1 += pad
  y0 -= pad
  y1 += pad * 0.5
  const scale = Math.max(0, Math.min(box.w / (x1 - x0), box.h / (y1 - y0)))
  const midX = (x0 + x1) / 2
  const midY = (y0 + y1) / 2
  const cx = box.x + box.w / 2 + (mirrored ? -midX : midX) * scale
  const floorY = box.y + box.h / 2 + (NEUTRAL_ANKLE_Y - midY) * scale
  return { cx, floorY, scale, mirrored }
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** A trail that fades in from its start, with an arrowhead whose tip is the last point. */
function drawTrail(ctx: Ctx2D, pts: readonly Vec2[], width: number, color: string, head: number): void {
  const n = pts.length
  const end = pts[n - 1]
  // Direction at the end: from a point a little way back (stable on dense samples).
  let back = pts[0]
  for (let i = n - 2; i >= 0; i--) {
    back = pts[i]
    if (Math.hypot(end[0] - back[0], end[1] - back[1]) > head) break
  }
  const dx = end[0] - back[0]
  const dy = end[1] - back[1]
  const l = Math.hypot(dx, dy) || 1
  const ux = dx / l
  const uy = dy / l
  const fade = ctx.createLinearGradient(pts[0][0], pts[0][1], end[0], end[1])
  fade.addColorStop(0, withAlpha(color, 0))
  fade.addColorStop(0.45, withAlpha(color, 1))
  fade.addColorStop(1, withAlpha(color, 1))
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  // Stop the line under the arrowhead so the tip stays sharp.
  for (let i = 1; i < n - 1; i++) {
    if (Math.hypot(end[0] - pts[i][0], end[1] - pts[i][1]) < head * 0.7) break
    ctx.lineTo(pts[i][0], pts[i][1])
  }
  ctx.lineTo(end[0] - ux * head * 0.7, end[1] - uy * head * 0.7)
  ctx.lineWidth = width
  ctx.strokeStyle = fade
  ctx.stroke()
  const bx = end[0] - ux * head
  const by = end[1] - uy * head
  ctx.beginPath()
  ctx.moveTo(end[0], end[1])
  ctx.lineTo(bx - uy * head * 0.6, by + ux * head * 0.6)
  ctx.lineTo(bx + uy * head * 0.6, by - ux * head * 0.6)
  ctx.closePath()
  ctx.fillStyle = withAlpha(color, 1)
  ctx.fill()
}

const pictogramCache = new WeakMap<object, Map<string, Layer>>()

/**
 * Draws a move's cue card into `box`. Cards are static, so each (move, size, look) is painted
 * once into a scratch canvas and blitted afterwards (cheap enough for a strip every frame).
 */
export function drawPictogram(ctx: Ctx2D, move: PictogramMove, box: Box, opts: PictogramOptions): void {
  if (!(box.w > 0 && box.h > 0)) return
  const theme = opts.theme ?? coachThemeFor(null)
  const k = deviceScale(ctx)
  const pad = Math.ceil(Math.min(box.w, box.h) * 0.2) // room for the active glow
  const key = [box.w, box.h, k, theme.body, theme.glow, theme.accent, opts.mirrored, opts.active === true, opts.label === true, opts.card !== false, move.name, move.scoredJoints.join(','), coach3dActive()].join('|')
  let byMove = pictogramCache.get(move.keyframes)
  let layer = byMove?.get(key)
  if (!layer) {
    const canvas = createLayer(Math.ceil((box.w + 2 * pad) * k), Math.ceil((box.h + 2 * pad) * k))
    const lctx = canvas?.getContext('2d') as Ctx2D | null | undefined
    if (!canvas || !lctx) {
      paintPictogram(ctx, move, box, opts)
      return
    }
    lctx.setTransform(k, 0, 0, k, pad * k, pad * k)
    paintPictogram(lctx, move, { x: 0, y: 0, w: box.w, h: box.h }, opts)
    if (!byMove) {
      byMove = new Map()
      pictogramCache.set(move.keyframes, byMove)
    }
    if (byMove.size >= 16) byMove.clear()
    byMove.set(key, canvas)
    layer = canvas
  }
  ctx.drawImage(layer, box.x - pad, box.y - pad, box.w + 2 * pad, box.h + 2 * pad)
}

function paintPictogram(ctx: Ctx2D, move: PictogramMove, box: Box, opts: PictogramOptions): void {
  const theme = opts.theme ?? coachThemeFor(null)
  const active = opts.active === true
  const k = move.keyframes[keyFrameIndex(move)]
  const m = Math.min(box.w, box.h)
  const radius = m * 0.17
  const labelH = opts.label ? Math.max(9, Math.round(m * 0.15)) : 0

  ctx.save()
  // Card: deep base + theme gradient, clipped so nothing spills into neighbouring cards.
  roundRect(ctx, box.x, box.y, box.w, box.h, radius)
  ctx.save()
  ctx.clip()
  const card = opts.card !== false
  if (card) {
    const g = ctx.createLinearGradient(box.x, box.y, box.x + box.w * 0.4, box.y + box.h)
    g.addColorStop(0, mixHex('#1a1240', theme.glow, active ? 0.62 : 0.42))
    g.addColorStop(1, active ? '#1b1446' : '#0f0b2a')
    ctx.fillStyle = g
    ctx.fillRect(box.x, box.y, box.w, box.h)
    const shine = ctx.createRadialGradient(box.x + box.w / 2, box.y + box.h * 0.38, 0, box.x + box.w / 2, box.y + box.h * 0.38, m * 0.6)
    shine.addColorStop(0, withAlpha(theme.body, active ? 0.22 : 0.12))
    shine.addColorStop(1, withAlpha(theme.body, 0))
    ctx.fillStyle = shine
    ctx.fillRect(box.x, box.y, box.w, box.h)
  }

  if (k) {
    const trails = moveTrails(move)
    const pts: Vec2[] = []
    for (const p of Object.values(k.pose)) pts.push(world(p, k.root))
    for (const t of trails) pts.push(...t.points)
    const inner: Box = { x: box.x + m * 0.06, y: box.y + m * 0.06, w: box.w - m * 0.12, h: box.h - m * 0.1 - labelH }
    const view = fitPointsView(pts, inner, opts.mirrored)
    drawCoach(ctx, k.pose, k.root ?? ZERO, view, { theme, highlightJoints: move.scoredJoints, glow: active ? 0.9 : 0.6 })
    // Trails on top: dark casing + accent line + arrowhead.
    const bv = figureBodyView(view, ZERO)
    const w = Math.max(1.6, view.scale * 0.085)
    const casing = Math.max(1.2, w * 0.7)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const t of trails) {
      const screen = t.points.map((p) => bodyToScreen(p, bv))
      drawTrail(ctx, screen, w + 2 * casing, '#0a061e', w * 3.2 + casing * 1.6)
      drawTrail(ctx, screen, w, theme.accent, w * 3.2)
    }
  }

  if (labelH > 0) {
    const band = ctx.createLinearGradient(0, box.y + box.h - labelH * 1.6, 0, box.y + box.h)
    band.addColorStop(0, 'rgba(8, 6, 24, 0)')
    band.addColorStop(1, 'rgba(8, 6, 24, 0.85)')
    ctx.fillStyle = band
    ctx.fillRect(box.x, box.y + box.h - labelH * 1.6, box.w, labelH * 1.6)
    ctx.font = `600 ${Math.round(labelH * 0.78)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = active ? '#ffffff' : theme.body
    ctx.fillText(move.name, box.x + box.w / 2, box.y + box.h - labelH * 0.62, box.w - m * 0.1)
  }
  ctx.restore()

  if (!card) {
    ctx.restore()
    return
  }
  // Border (+ glow when active).
  roundRect(ctx, box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1, radius)
  if (active) {
    ctx.shadowColor = withAlpha(theme.accent, 0.9)
    ctx.shadowBlur = m * 0.12
    ctx.lineWidth = Math.max(2, m * 0.03)
    ctx.strokeStyle = theme.accent
  } else {
    ctx.lineWidth = 1
    ctx.strokeStyle = withAlpha(theme.glow, 0.55)
  }
  ctx.stroke()
  ctx.restore()
}
