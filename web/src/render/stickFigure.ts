// Coach-style figure renderer: thick round-capped limbs, filled torso, head circle, optional
// glow, L/R debug colours and highlighted (scored) limbs. Body-frame poses are mapped with
// bodyToScreen (shared/README.md "Drawing a body-frame pose"); `root` moves the whole body,
// and the floor is the neutral ankle height. View math is pure and unit-tested.

import { LIMBS, type JointName, type LimbName, type Pose2D, type Vec2 } from '@shared/skeleton'
import type { Ctx2D } from '../pose/draw'
import { bodyToScreen, type BodyView } from '../pose/normalize'
import { NEUTRAL_ANKLE_Y } from '../routine/pose'

export interface FigureView {
  /** Screen x of mid-hip at root [0, 0]. */
  cx: number
  /** Screen y of the floor (where neutral ankles stand at root [0, 0]). */
  floorY: number
  /** Screen pixels per body unit (torso length). */
  scale: number
  /** true: the player's reflection (coach view, screenX = cx + x*s); false: true view. */
  mirrored: boolean
}

export interface FigureStyle {
  /** Limb thickness in CSS px. */
  lineWidth: number
  color: string
  /** Colours for the dancer's anatomical left / right limbs (debugging mirroring). */
  leftColor?: string
  rightColor?: string
  /** Glow (canvas shadow blur) in CSS px; 0/undefined = none. */
  glow?: number
  glowColor?: string
  /** Scored joints: limbs whose distal joint is listed are highlighted. */
  highlightJoints?: readonly JointName[]
  /** Default '#facc15'. */
  highlightColor?: string
}

/** Body-frame -> screen mapping for a figure displaced by `root` (body units). */
export function figureBodyView(view: FigureView, root: Vec2): BodyView {
  const cy = view.floorY - NEUTRAL_ANKLE_Y * view.scale
  const [cx, cyRoot] = bodyToScreen(root, { cx: view.cx, cy, scale: view.scale, mirrored: view.mirrored })
  return { cx, cy: cyRoot, scale: view.scale, mirrored: view.mirrored }
}

/**
 * View that fits a dancing figure in a width x height box: room for arms overhead plus a
 * jump above the head, arms out sideways plus some travel, feet on a floor near the bottom.
 */
export function fitFigureView(width: number, height: number, mirrored = true): FigureView {
  const scale = Math.max(0, Math.min(height / 4.75, width / 4.1))
  return { cx: width / 2, floorY: height - 0.2 * scale, scale, mirrored }
}

/** Limbs to highlight for a scoredJoints list: distal-joint rule; torso when a shoulder is listed. */
export function highlightedLimbs(joints: readonly JointName[]): Set<LimbName> {
  const set = new Set<string>(joints)
  const out = new Set<LimbName>()
  for (const [name, [, distal]] of Object.entries(LIMBS) as Array<[LimbName, readonly [string, string]]>) {
    if (set.has(distal)) out.add(name)
  }
  if (set.has('l_shoulder') || set.has('r_shoulder')) out.add('torso')
  return out
}

export interface HeadCircle {
  /** Body units. */
  center: Vec2
  radius: number
}

const FACE: readonly JointName[] = ['nose', 'l_eye', 'r_eye', 'l_ear', 'r_ear']

/** Head circle (body units) from the face joints: centred on them, sized by ear span / nose offset. */
export function headCircle(pose: Pose2D): HeadCircle | null {
  let sx = 0
  let sy = 0
  let n = 0
  for (const j of FACE) {
    const p = pose[j]
    if (!p) continue
    sx += p[0]
    sy += p[1]
    n++
  }
  if (n === 0) return null
  const center: Vec2 = [sx / n, sy / n]
  const le = pose.l_ear
  const re = pose.r_ear
  const nose = pose.nose
  let radius = 0.22
  if (le && re) {
    const span = Math.hypot(le[0] - re[0], le[1] - re[1])
    const mid: Vec2 = [(le[0] + re[0]) / 2, (le[1] + re[1]) / 2]
    const noseOff = nose ? Math.hypot(nose[0] - mid[0], nose[1] - mid[1]) : 0
    radius = Math.min(0.4, Math.max(0.17, 0.75 * span, 2.2 * noseOff))
  }
  return { center, radius }
}

const ARM_LEG_LIMBS: readonly LimbName[] = [
  'l_upper_arm',
  'l_forearm',
  'r_upper_arm',
  'r_forearm',
  'l_thigh',
  'l_shin',
  'r_thigh',
  'r_shin',
]

const DEFAULT_HIGHLIGHT = '#facc15'

/** Draws one figure. Joints missing from `pose` are skipped. */
export function drawFigure(ctx: Ctx2D, pose: Pose2D, root: Vec2, view: FigureView, style: FigureStyle): void {
  const bv = figureBodyView(view, root)
  const at = (j: JointName): Vec2 | null => {
    const p = pose[j]
    return p ? bodyToScreen(p, bv) : null
  }
  const lw = style.lineWidth
  const hl = highlightedLimbs(style.highlightJoints ?? [])
  const hlColor = style.highlightColor ?? DEFAULT_HIGHLIGHT
  const sided = style.leftColor !== undefined || style.rightColor !== undefined
  const limbColor = (limb: LimbName): string => {
    if (!sided && hl.has(limb)) return hlColor
    if (limb.startsWith('l_')) return style.leftColor ?? style.color
    if (limb.startsWith('r_')) return style.rightColor ?? style.color
    return style.color
  }

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (style.glow && style.glow > 0) {
    ctx.shadowBlur = style.glow
    ctx.shadowColor = style.glowColor ?? style.color
  }

  // Torso: filled quad with rounded corners (stroke in the same colour).
  const ls = at('l_shoulder')
  const rs = at('r_shoulder')
  const lh = at('l_hip')
  const rh = at('r_hip')
  if (ls && rs && lh && rh) {
    const torsoColor = !sided && hl.has('torso') ? hlColor : style.color
    if (sided && hl.has('torso')) {
      ctx.strokeStyle = hlColor
      ctx.lineWidth = lw * 1.9
      ctx.globalAlpha = 0.6
      quad(ctx, ls, rs, rh, lh)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = torsoColor
    ctx.strokeStyle = torsoColor
    ctx.lineWidth = lw
    quad(ctx, ls, rs, rh, lh)
    ctx.fill()
    ctx.stroke()
  }

  // Head + neck.
  const head = headCircle(pose)
  if (head) {
    const c = bodyToScreen(head.center, bv)
    const r = head.radius * view.scale
    if (ls && rs) {
      const ms: Vec2 = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2]
      const d = Math.hypot(ms[0] - c[0], ms[1] - c[1])
      if (d > r) {
        ctx.strokeStyle = style.color
        ctx.lineWidth = lw * 0.9
        ctx.beginPath()
        ctx.moveTo(ms[0], ms[1])
        ctx.lineTo(c[0] + ((ms[0] - c[0]) / d) * r, c[1] + ((ms[1] - c[1]) / d) * r)
        ctx.stroke()
      }
    }
    ctx.fillStyle = style.color
    ctx.beginPath()
    ctx.arc(c[0], c[1], Math.max(1, r), 0, Math.PI * 2)
    ctx.fill()
  }

  // Limbs: highlight halos first (when sided colours are on), then the limbs.
  const segments: Array<[LimbName, Vec2, Vec2]> = []
  for (const limb of ARM_LEG_LIMBS) {
    const [a, b] = LIMBS[limb] as readonly [JointName, JointName]
    const pa = at(a)
    const pb = at(b)
    if (pa && pb) segments.push([limb, pa, pb])
  }
  if (sided) {
    ctx.strokeStyle = hlColor
    ctx.lineWidth = lw * 1.9
    ctx.globalAlpha = 0.6
    for (const [limb, pa, pb] of segments) if (hl.has(limb)) line(ctx, pa, pb)
    ctx.globalAlpha = 1
  }
  ctx.lineWidth = lw
  for (const [limb, pa, pb] of segments) {
    ctx.strokeStyle = limbColor(limb)
    line(ctx, pa, pb)
  }
  // Hands: small discs make the wrists readable.
  for (const [j, limb] of [
    ['l_wrist', 'l_forearm'],
    ['r_wrist', 'r_forearm'],
  ] as const) {
    const p = at(j)
    if (!p) continue
    ctx.fillStyle = limbColor(limb)
    ctx.beginPath()
    ctx.arc(p[0], p[1], lw * 0.85, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function line(ctx: Ctx2D, a: Vec2, b: Vec2): void {
  ctx.beginPath()
  ctx.moveTo(a[0], a[1])
  ctx.lineTo(b[0], b[1])
  ctx.stroke()
}

function quad(ctx: Ctx2D, a: Vec2, b: Vec2, c: Vec2, d: Vec2): void {
  ctx.beginPath()
  ctx.moveTo(a[0], a[1])
  ctx.lineTo(b[0], b[1])
  ctx.lineTo(c[0], c[1])
  ctx.lineTo(d[0], d[1])
  ctx.closePath()
}

/** Faint floor line under a figure. */
export function drawFloor(ctx: Ctx2D, view: FigureView, halfWidthUnits = 1.6, color = 'rgba(148, 163, 255, 0.25)'): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(view.cx - halfWidthUnits * view.scale, view.floorY + 0.5)
  ctx.lineTo(view.cx + halfWidthUnits * view.scale, view.floorY + 0.5)
  ctx.stroke()
  ctx.restore()
}

/** Debug colours for the dancer's anatomical left / right limbs. */
export const LEFT_COLOR = '#22d3ee'
export const RIGHT_COLOR = '#fb923c'

/** The coach look (glowing lilac silhouette) at a given view scale. */
export function coachStyle(
  view: FigureView,
  opts: { lrColors?: boolean; highlightJoints?: readonly JointName[]; glow?: boolean } = {},
): FigureStyle {
  return {
    lineWidth: Math.max(2.5, view.scale * 0.15),
    color: '#ede9fe',
    glow: opts.glow === false ? 0 : Math.max(4, view.scale * 0.18),
    glowColor: '#a78bfa',
    ...(opts.lrColors ? { leftColor: LEFT_COLOR, rightColor: RIGHT_COLOR } : {}),
    highlightJoints: opts.highlightJoints,
  }
}
