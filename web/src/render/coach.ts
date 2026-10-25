// The game's coach dancer: a Just Dance-style glowing silhouette. The body is one Path2D
// (tapered capsule limbs, rounded torso, neck, head ellipse, hands, feet) filled once, so
// overlaps never double up, with a single shadowBlur glow; scored limbs get accent
// "gloves/sleeves", and a tiny tiara crowns the head (storybook theme). Shape building is pure
// (coachShape) and unit-tested; drawCoach only traces and fills it.

import { JOINTS, type JointName, type LimbName, type Pose2D, type Vec2 } from '@shared/skeleton'
import type { Ctx2D } from '../pose/draw'
import { bodyToScreen } from '../pose/normalize'
import type { Coach3dImage } from '../render3d/coach3d'
import { tryRenderCoach3d } from '../render3d/load'
import { figureBodyView, headCircle, highlightedLimbs, type FigureView } from './stickFigure'

export type CoachView = FigureView

export interface CoachTheme {
  /** Main silhouette colour. */
  body: string
  /** Glow / outline colour. */
  glow: string
  /** Accent for UI around the coach (cue cards, beat pulse). */
  accent: string
}

/** Storybook midnight palette: pale, high-luminance bodies with saturated glows (projector-safe). */
export const COACH_THEMES = {
  /** Moonlit silver. */
  intro: { body: '#eef1ff', glow: '#7f9cff', accent: '#ffd27a' },
  /** Royal violet. */
  verse: { body: '#f4eeff', glow: '#9d6bff', accent: '#5fe0ff' },
  /** Rose-gold chorus. */
  chorus: { body: '#fff0eb', glow: '#ff6fa5', accent: '#ffcf66' },
  /** Enchanted teal. */
  bridge: { body: '#e9fffb', glow: '#2fd6c0', accent: '#ff8fd0' },
  /** Dawn amber (the ball ends at sunrise). */
  outro: { body: '#fff6e6', glow: '#ffa14f', accent: '#a98bff' },
} as const satisfies Record<string, CoachTheme>

/** Theme for a section label (intro | verse | chorus | bridge | outro); default = intro. */
export function coachThemeFor(label: string | null | undefined): CoachTheme {
  return label && Object.hasOwn(COACH_THEMES, label) ? COACH_THEMES[label as keyof typeof COACH_THEMES] : COACH_THEMES.intro
}

export interface CoachDrawOptions {
  theme?: CoachTheme
  /** 0..1, 1 right on a beat, decaying after it. */
  beatPulse?: number
  /** Limbs to emphasize (distal-joint rule), e.g. the current move's scoredJoints. */
  highlightJoints?: readonly JointName[]
  /** Tiny tiara on the head. Default true. */
  crown?: boolean
  /** Glow strength multiplier (0 = no glow). Default 1. */
  glow?: number
}

// --- colour helpers ----------------------------------------------------------------------

/** '#rrggbb' (or '#rgb') -> [r, g, b]; black for anything else. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.startsWith('#') ? hex.slice(1) : hex
  if (h.length === 3) h = h.replace(/./g, (c) => c + c)
  const n = /^[0-9a-f]{6}$/i.test(h) ? Number.parseInt(h, 16) : 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** CSS rgba() of a hex colour with alpha. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`
}

/** Hex colour a + (b - a) * t ('#rrggbb'). */
export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  const k = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0))
  const c = (i: number): string => Math.round(x[i] + (y[i] - x[i]) * k).toString(16).padStart(2, '0')
  return `#${c(0)}${c(1)}${c(2)}`
}

// --- shape -------------------------------------------------------------------------------

/** What a primitive belongs to (hands go with forearms, feet with shins for highlighting). */
export type CoachPart = LimbName | 'neck' | 'head' | 'l_hand' | 'r_hand' | 'l_foot' | 'r_foot'

export type CoachPrim =
  | { kind: 'capsule'; part: CoachPart; a: Vec2; b: Vec2; ra: number; rb: number }
  | { kind: 'ellipse'; part: CoachPart; c: Vec2; rx: number; ry: number; rot: number }
  /** Closed outline: smoothed (quadratic curves through the edge midpoints) or sharp (polygon). */
  | { kind: 'blob'; part: CoachPart; pts: Vec2[]; sharp?: boolean }

/** Body-unit proportions of the silhouette (torso length = 1). */
const R = {
  shoulder: 0.122,
  elbow: 0.09,
  wrist: 0.066,
  hip: 0.158,
  knee: 0.108,
  ankle: 0.075,
  neck: 0.08,
  handAlong: 0.1,
  handAcross: 0.078,
  footAlong: 0.125,
  footAcross: 0.062,
} as const

const LIMB_PRIMS: ReadonlyArray<readonly [LimbName, JointName, JointName, number, number]> = [
  ['l_thigh', 'l_hip', 'l_knee', R.hip, R.knee],
  ['r_thigh', 'r_hip', 'r_knee', R.hip, R.knee],
  ['l_shin', 'l_knee', 'l_ankle', R.knee, R.ankle],
  ['r_shin', 'r_knee', 'r_ankle', R.knee, R.ankle],
  ['l_upper_arm', 'l_shoulder', 'l_elbow', R.shoulder, R.elbow],
  ['r_upper_arm', 'r_shoulder', 'r_elbow', R.shoulder, R.elbow],
  ['l_forearm', 'l_elbow', 'l_wrist', R.elbow, R.wrist],
  ['r_forearm', 'r_elbow', 'r_wrist', R.elbow, R.wrist],
]

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const addS = (a: Vec2, d: Vec2, k: number): Vec2 => [a[0] + d[0] * k, a[1] + d[1] * k]
const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const norm = (v: Vec2): number => Math.hypot(v[0], v[1])
function unit(v: Vec2, fallback: Vec2): Vec2 {
  const l = norm(v)
  return l > 1e-9 ? [v[0] / l, v[1] / l] : fallback
}

/** Signed area (screen coords, y down): > 0 = the same turning direction as canvas arcs. */
export function signedArea(pts: readonly Vec2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

/** The coach silhouette for a pose as screen-space primitives (CSS px). Missing joints drop their parts. */
export function coachShape(pose: Pose2D, root: Vec2, view: CoachView): CoachPrim[] {
  const s = view.scale
  if (!(s > 0)) return []
  const bv = figureBodyView(view, root)
  const P: Partial<Record<JointName, Vec2>> = {}
  for (const j of JOINTS) {
    const p = pose[j]
    if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) P[j] = bodyToScreen(p, bv)
  }
  const prims: CoachPrim[] = []

  // Torso: shoulders -> waist -> hips, with minimum widths so a spin never makes it a sliver.
  const { l_shoulder: ls, r_shoulder: rs, l_hip: lh, r_hip: rh } = P
  let ms: Vec2 | null = null
  let up: Vec2 = [0, -1]
  if (ls && rs && lh && rh) {
    const sc = mid(ls, rs)
    ms = sc
    const mh = mid(lh, rh)
    up = unit(sub(sc, mh), [0, -1])
    const across: Vec2 = [-up[1], up[0]]
    const half = (a: Vec2, b: Vec2, min: number): Vec2 => {
      const h: Vec2 = [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2]
      const l = norm(h)
      if (l >= min) return h
      const d = l > 1e-9 ? ([h[0] / l, h[1] / l] as Vec2) : across
      return [d[0] * min, d[1] * min]
    }
    const hs = half(ls, rs, 0.2 * s)
    const hh = half(lh, rh, 0.16 * s)
    const wdir = unit(addS(unit(hs, across), unit(hh, across), 1), across)
    const waist = addS(sc, sub(mh, sc), 0.6)
    const W = 0.255 * s
    // Sloped shoulders, deltoids, armpits, a narrow waist, hips, crotch; then the left side.
    const side = (k: 1 | -1): Vec2[] => [
      addS(addS(sc, hs, 0.8 * k), up, 0.06 * s),
      addS(addS(sc, hs, 1.12 * k), up, -0.08 * s),
      addS(addS(sc, hs, 1.0 * k), up, -0.36 * s),
      addS(waist, wdir, W * k),
      addS(mh, hh, 1.42 * k),
      addS(addS(mh, hh, 0.45 * k), up, -0.2 * s),
    ]
    const pts: Vec2[] = [...side(1), ...side(-1).reverse()]
    if (signedArea(pts) < 0) pts.reverse()
    prims.push({ kind: 'blob', part: 'torso', pts })
  }

  // Neck + head (ellipse sized from nose/ears, tilted with the neck).
  const head = headCircle(pose)
  if (head) {
    const c = bodyToScreen(head.center, bv)
    const r = Math.max(head.radius, 0.2) * s
    if (ms) {
      const dir = sub(c, ms)
      const rot = norm(dir) > 1e-9 ? Math.atan2(dir[0], -dir[1]) : 0
      prims.push({ kind: 'capsule', part: 'neck', a: addS(ms, up, 0.05 * s), b: c, ra: R.neck * s, rb: R.neck * s * 0.9 })
      prims.push({ kind: 'ellipse', part: 'head', c, rx: r * 0.9, ry: r * 1.06, rot })
    } else {
      prims.push({ kind: 'ellipse', part: 'head', c, rx: r * 0.9, ry: r * 1.06, rot: 0 })
    }
  }

  // Limbs: tapered capsules (thick end proximal).
  for (const [part, a, b, ra, rb] of LIMB_PRIMS) {
    const pa = P[a]
    const pb = P[b]
    if (pa && pb) prims.push({ kind: 'capsule', part, a: pa, b: pb, ra: ra * s, rb: rb * s })
  }

  // Hands: small ovals past the wrists, along the forearm.
  for (const [part, e, w] of [
    ['l_hand', 'l_elbow', 'l_wrist'],
    ['r_hand', 'r_elbow', 'r_wrist'],
  ] as const) {
    const pe = P[e]
    const pw = P[w]
    if (!pe || !pw) continue
    const d = unit(sub(pw, pe), [0, 1])
    prims.push({ kind: 'ellipse', part, c: addS(pw, d, 0.07 * s), rx: R.handAlong * s, ry: R.handAcross * s, rot: Math.atan2(d[1], d[0]) })
  }
  // Feet: flat ovals under the ankles, across the shin.
  for (const [part, k, a] of [
    ['l_foot', 'l_knee', 'l_ankle'],
    ['r_foot', 'r_knee', 'r_ankle'],
  ] as const) {
    const pk = P[k]
    const pa = P[a]
    if (!pk || !pa) continue
    const d = unit(sub(pa, pk), [0, 1])
    prims.push({ kind: 'ellipse', part, c: addS(pa, d, 0.05 * s), rx: R.footAlong * s, ry: R.footAcross * s, rot: Math.atan2(d[1], d[0]) - Math.PI / 2 })
  }
  return prims
}

/** The subset of Path2D / CanvasPath used to trace primitives (lets tests record paths). */
export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw?: boolean): void
  closePath(): void
}

/** Traces one primitive as its own closed subpath, always clockwise on screen (nonzero = union). */
export function tracePrim(p: PathSink, prim: CoachPrim): void {
  if (prim.kind === 'ellipse') {
    const { c, rx, ry, rot } = prim
    p.moveTo(c[0] + rx * Math.cos(rot), c[1] + rx * Math.sin(rot))
    p.ellipse(c[0], c[1], rx, ry, rot, 0, Math.PI * 2)
    p.closePath()
    return
  }
  if (prim.kind === 'blob') {
    const pts = prim.pts
    const n = pts.length
    if (n < 3) return
    if (prim.sharp) {
      p.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < n; i++) p.lineTo(pts[i][0], pts[i][1])
      p.closePath()
      return
    }
    const start = mid(pts[n - 1], pts[0])
    p.moveTo(start[0], start[1])
    for (let i = 0; i < n; i++) {
      const q = mid(pts[i], pts[(i + 1) % n])
      p.quadraticCurveTo(pts[i][0], pts[i][1], q[0], q[1])
    }
    p.closePath()
    return
  }
  const { a, b, ra, rb } = prim
  const d = norm(sub(b, a))
  if (d <= Math.abs(ra - rb) + 1e-6) {
    // One end swallows the other: a disc.
    const [c, r] = ra >= rb ? [a, ra] : [b, rb]
    p.moveTo(c[0] + r, c[1])
    p.arc(c[0], c[1], r, 0, Math.PI * 2)
    p.closePath()
    return
  }
  const th = Math.atan2(b[1] - a[1], b[0] - a[0])
  const phi = Math.asin((ra - rb) / d)
  const t1 = th + Math.PI / 2 - phi
  p.moveTo(a[0] + ra * Math.cos(t1), a[1] + ra * Math.sin(t1))
  p.arc(a[0], a[1], ra, t1, th + (3 * Math.PI) / 2 + phi) // back of the thick end
  p.arc(b[0], b[1], rb, th - Math.PI / 2 + phi, t1) // front of the thin end
  p.closePath()
}

/** Glove / sleeve / boot primitives for highlighted limbs (forearm = glove + hand, shin = boot + foot). */
export function highlightPrims(prims: readonly CoachPrim[], joints: readonly JointName[]): CoachPrim[] {
  const hl = highlightedLimbs(joints)
  if (hl.size === 0) return []
  const out: CoachPrim[] = []
  for (const prim of prims) {
    const part = prim.part
    const limb: CoachPart =
      part === 'l_hand' ? 'l_forearm' : part === 'r_hand' ? 'r_forearm' : part === 'l_foot' ? 'l_shin' : part === 'r_foot' ? 'r_shin' : part
    if (!hl.has(limb as LimbName) || limb === 'torso') continue
    if (prim.kind === 'capsule' && (limb.endsWith('upper_arm') || limb.endsWith('thigh'))) {
      // Sleeve: start a little past the shoulder / hip so it doesn't paint over the torso.
      const k = 0.3
      out.push({ ...prim, a: addS(prim.a, sub(prim.b, prim.a), k), ra: prim.ra + (prim.rb - prim.ra) * k })
    } else {
      out.push(prim)
    }
  }
  return out
}

/** A small three-point tiara on top of the head ellipse (screen px). */
function crownPrims(prims: readonly CoachPrim[], s: number): CoachPrim[] {
  const head = prims.find((p) => p.kind === 'ellipse' && p.part === 'head')
  if (!head || head.kind !== 'ellipse') return []
  const upv: Vec2 = [Math.sin(head.rot), -Math.cos(head.rot)]
  const right: Vec2 = [-upv[1], upv[0]]
  const base = addS(head.c, upv, head.ry * 0.78)
  const w = head.rx * 0.62
  const h = 0.1 * s
  const at = (x: number, y: number): Vec2 => addS(addS(base, right, x * w), upv, y * h)
  const pts: Vec2[] = [at(-1, 0), at(-1.1, 0.8), at(-0.5, 0.38), at(0, 1.3), at(0.5, 0.38), at(1.1, 0.8), at(1, 0), at(0, -0.22)]
  if (signedArea(pts) < 0) pts.reverse()
  return [{ kind: 'blob', part: 'head', pts, sharp: true }]
}

/** Seam layers, back to front. */
const LAYERS: ReadonlyArray<{ parts: ReadonlySet<CoachPart> }> = [
  { parts: new Set<CoachPart>(['l_thigh', 'l_shin', 'l_foot']) },
  { parts: new Set<CoachPart>(['r_thigh', 'r_shin', 'r_foot']) },
  { parts: new Set<CoachPart>(['torso', 'neck', 'head']) },
  { parts: new Set<CoachPart>(['l_upper_arm', 'l_forearm', 'l_hand']) },
  { parts: new Set<CoachPart>(['r_upper_arm', 'r_forearm', 'r_hand']) },
]

function makePath(): Path2D | null {
  return typeof Path2D === 'undefined' ? null : new Path2D()
}

/** Pixel ratio of the context's current transform (shadowBlur ignores the transform). */
export function deviceScale(ctx: Ctx2D): number {
  const m = ctx.getTransform?.()
  const k = m ? Math.hypot(m.a, m.b) : 1
  return Number.isFinite(k) && k > 0 ? k : 1
}

export type Layer = HTMLCanvasElement | OffscreenCanvas

/** A scratch canvas (a DOM canvas when possible: it blits much faster than OffscreenCanvas). */
export function createLayer(w: number, h: number): Layer | null {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  return null
}

/** The glow is blurry anyway: render it at 1/GLOW_DOWNSCALE resolution (~16x fewer pixels to blur). */
const GLOW_DOWNSCALE = 4
let glowLayer: { canvas: Layer; ctx: Ctx2D } | null | undefined

function glowContext(w: number, h: number): { canvas: Layer; ctx: Ctx2D } | null {
  if (glowLayer === undefined) {
    const canvas = createLayer(Math.max(64, w), Math.max(64, h))
    const lctx = canvas?.getContext('2d') as Ctx2D | null | undefined
    glowLayer = canvas && lctx ? { canvas, ctx: lctx } : null
  }
  if (!glowLayer) return null
  const c = glowLayer.canvas
  if (c.width < w || c.height < h) {
    // Grow only (resizing also clears).
    c.width = Math.max(c.width, w)
    c.height = Math.max(c.height, h)
  }
  return glowLayer
}

interface GlowPass {
  path: Path2D
  color: string
  /** Blur in CSS px. */
  blur: number
}

/**
 * Draws the passes' shadows (blurred, low resolution) into the glow layer and blits it under
 * the figure. Returns false when no layer is available (the caller uses shadowBlur instead).
 */
function drawGlowLayer(ctx: Ctx2D, passes: readonly GlowPass[], box: { x0: number; y0: number; x1: number; y1: number }, k: number): boolean {
  const pad = Math.max(...passes.map((p) => p.blur)) * 1.6 + 2
  const x0 = box.x0 - pad
  const y0 = box.y0 - pad
  const w = box.x1 - box.x0 + 2 * pad
  const h = box.y1 - box.y0 + 2 * pad
  const f = k / GLOW_DOWNSCALE
  const lw = Math.ceil(w * f)
  const lh = Math.ceil(h * f)
  if (!(lw > 0 && lh > 0) || lw > 4096 || lh > 4096) return false
  const layer = glowContext(lw, lh)
  if (!layer) return false
  const g = layer.ctx
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, lw + 1, lh + 1)
  g.setTransform(f, 0, 0, f, -x0 * f, -y0 * f)
  for (const pass of passes) {
    g.shadowColor = pass.color
    g.shadowBlur = pass.blur * f
    g.fillStyle = pass.color
    g.fill(pass.path)
  }
  g.shadowBlur = 0
  ctx.drawImage(layer.canvas, 0, 0, lw, lh, x0, y0, lw / f, lh / f)
  return true
}

/** The glow an image casts (the 3D coach): its blurred silhouette in `color`, at low resolution, under it. */
function drawImageGlow(ctx: Ctx2D, img: Coach3dImage, color: string, blur: number, k: number): void {
  const pad = blur * 1.6 + 2
  const x0 = img.x - pad
  const y0 = img.y - pad
  const w = img.w + 2 * pad
  const f = k / GLOW_DOWNSCALE
  const lw = Math.ceil(w * f)
  const lh = Math.ceil((img.h + 2 * pad) * f)
  if (!(lw > 0 && lh > 0) || lw > 4096 || lh > 4096) return
  const layer = glowContext(lw, lh)
  if (!layer) return
  const g = layer.ctx
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, lw + 1, lh + 1)
  // Shadow only: draw the image one layer-width off to the left and cast its shadow back into place
  // (shadow offsets ignore the transform: layer pixels).
  g.setTransform(f, 0, 0, f, -x0 * f, -y0 * f)
  g.shadowColor = color
  g.shadowOffsetX = w * f
  // A wide halo plus a tighter core (one shadow alone reads fainter than the 2D glow under a fill).
  for (const b of [blur, blur * 0.45]) {
    g.shadowBlur = b * f
    g.drawImage(img.src, 0, 0, img.sw, img.sh, img.x - w, img.y, img.w, img.h)
  }
  g.shadowOffsetX = 0
  g.shadowBlur = 0
  ctx.drawImage(layer.canvas, 0, 0, lw, lh, x0, y0, lw / f, lh / f)
}

/** Screen bounding box of the primitives. */
function primBounds(prims: readonly CoachPrim[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  const add = (x: number, y: number, r: number): void => {
    if (x - r < x0) x0 = x - r
    if (y - r < y0) y0 = y - r
    if (x + r > x1) x1 = x + r
    if (y + r > y1) y1 = y + r
  }
  for (const p of prims) {
    if (p.kind === 'blob') for (const q of p.pts) add(q[0], q[1], 0)
    else if (p.kind === 'ellipse') add(p.c[0], p.c[1], Math.max(p.rx, p.ry))
    else {
      add(p.a[0], p.a[1], p.ra)
      add(p.b[0], p.b[1], p.rb)
    }
  }
  return { x0, y0, x1, y1 }
}

export function drawCoach(ctx: Ctx2D, pose: Pose2D, root: Vec2, view: CoachView, opts: CoachDrawOptions = {}): void {
  const theme = opts.theme ?? coachThemeFor(null)
  const pulse = Math.max(0, Math.min(1, opts.beatPulse ?? 0))
  const glow = Math.max(0, opts.glow ?? 1)
  const s = view.scale
  const prims = coachShape(pose, root, view)
  const path = makePath()
  const accent = makePath()
  if (prims.length === 0 || !path || !accent) return
  for (const prim of prims) tracePrim(path, prim)
  // Accent gloves / sleeves on scored limbs, and the tiara.
  const hl = highlightPrims(prims, opts.highlightJoints ?? [])
  const crown = opts.crown === false ? [] : crownPrims(prims, s)
  for (const prim of hl) tracePrim(accent, prim)
  for (const prim of crown) tracePrim(accent, prim)
  const hasAccent = hl.length + crown.length > 0

  const box = primBounds(prims)
  const bodyColor = mixHex(theme.body, '#ffffff', 0.35 * pulse)

  const k = deviceScale(ctx)
  const bodyGlow: GlowPass = { path, color: withAlpha(theme.glow, 0.85 + 0.15 * pulse), blur: s * (0.3 + 0.22 * pulse) * glow }
  const accentGlow: GlowPass = { path: accent, color: withAlpha(theme.accent, 0.9), blur: s * 0.12 * glow }

  // The 3D princess (Settings > dancer3d, WebGL, lazily loaded) replaces the silhouette, glowing the same way.
  const img = tryRenderCoach3d(ctx, pose, root, view, { theme, pulse, highlightJoints: opts.highlightJoints ?? [], crown: opts.crown !== false })
  if (img) {
    if (glow > 0) drawImageGlow(ctx, img, bodyGlow.color, bodyGlow.blur, k)
    ctx.drawImage(img.src, 0, 0, img.sw, img.sh, img.x, img.y, img.w, img.h)
    return
  }

  ctx.save()
  // 1) Outer glow (one low-res blurred pass for body + accents), then the silhouette: one fill
  //    of the union path, so overlaps never double up. Without a scratch canvas: shadowBlur.
  const layered = glow > 0 && drawGlowLayer(ctx, hasAccent ? [bodyGlow, accentGlow] : [bodyGlow], box, k)
  if (glow > 0 && !layered) {
    ctx.shadowColor = bodyGlow.color
    ctx.shadowBlur = bodyGlow.blur * k
  }
  ctx.fillStyle = bodyColor
  ctx.fill(path)
  ctx.shadowBlur = 0
  ctx.shadowColor = 'rgba(0, 0, 0, 0)'

  // 2) Thin tinted seams so limbs read where they pass in front of the body or each other
  //    (legs, then torso/head over the thigh tops, then arms): stroke a group, refill it, so
  //    only the outer half of its outline remains (which also gives the silhouette a crisp rim).
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1, s * 0.035)
  ctx.strokeStyle = mixHex(theme.body, theme.glow, 0.62)
  for (const group of LAYERS) {
    const gp = makePath()
    if (!gp) break
    let any = false
    for (const prim of prims) {
      if (!group.parts.has(prim.part)) continue
      tracePrim(gp, prim)
      any = true
    }
    if (!any) continue
    ctx.stroke(gp)
    ctx.fill(gp)
  }

  // Subtle inner shading in one gradient pass: a sheen on the chest, a theme tint towards
  // the extremities and feet.
  const chest = prims.find((p) => p.kind === 'blob' && p.part === 'torso')
  const c: Vec2 = chest && chest.kind === 'blob' ? mid(chest.pts[0], chest.pts[chest.pts.length - 1]) : [(box.x0 + box.x1) / 2, box.y0]
  const shade = ctx.createRadialGradient(c[0], c[1] + 0.3 * s, 0, c[0], c[1] + 0.3 * s, 2.6 * s)
  shade.addColorStop(0, 'rgba(255, 255, 255, 0.4)')
  shade.addColorStop(0.35, withAlpha(theme.glow, 0))
  shade.addColorStop(1, withAlpha(theme.glow, 0.34))
  ctx.fillStyle = shade
  ctx.fill(path)

  // 3) Accents on top.
  if (hasAccent) {
    if (glow > 0 && !layered) {
      ctx.shadowColor = accentGlow.color
      ctx.shadowBlur = accentGlow.blur * k
    }
    ctx.fillStyle = theme.accent
    ctx.fill(accent)
  }
  ctx.restore()
}
