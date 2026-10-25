// The 3D coach's rig (pure, unit-tested): a lifted pose -> one transform per body part and the gown's
// skirt vertices, in "world" = CSS px with y up and z toward the viewer, so an orthographic camera over
// the screen box draws every joint exactly where the 2D coach would. Mirroring is a reflection in x
// (bodyToScreen); the parts are symmetric, so their frames stay right-handed either way.

import type { JointName, Pose2D, Vec2 } from '@shared/skeleton'
import { bodyToScreen } from '../pose/normalize'
import { figureBodyView, headCircle, type FigureView } from '../render/stickFigure'
import { liftPose, type Vec3 } from './lift'

/** A part's frame: origin plus axes scaled to the part's size (columns of its matrix). */
export interface Basis {
  o: Vec3
  x: Vec3
  y: Vec3
  z: Vec3
}

export type LimbPart = 'l_upper_arm' | 'r_upper_arm' | 'l_forearm' | 'r_forearm' | 'l_thigh' | 'r_thigh' | 'l_shin' | 'r_shin'
export type JointPart = 'l_shoulder' | 'r_shoulder' | 'l_elbow' | 'r_elbow' | 'l_hip' | 'r_hip' | 'l_knee' | 'r_knee' | 'l_ankle' | 'r_ankle'
/**
 * Limbs: unit cylinder along +y (0..1, taper baked in body units). Joints, hands, feet: unit sphere.
 * torso: lathe along +y (0 = mid-hip, 1 = mid-shoulder). head: frame of radius 1. neck: like a limb.
 * sash: unit torus in the xz plane at the waist.
 */
export type RigPart = LimbPart | JointPart | 'l_hand' | 'r_hand' | 'l_foot' | 'r_foot' | 'torso' | 'neck' | 'head' | 'sash'

export interface Rig {
  parts: Partial<Record<RigPart, Basis>>
  /** SKIRT_RINGS x SKIRT_SEGMENTS vertices (xyz), ring 0 at the waist; null without hips. */
  skirt: Float32Array | null
  /** Screen box (CSS px, y down) holding everything. */
  box: { x0: number; y0: number; x1: number; y1: number }
}

export const SKIRT_SEGMENTS = 96
export const SKIRT_RINGS = 7

/** Body-unit radii (torso length = 1), matching the 2D silhouette. */
export const RADIUS = {
  shoulder: 0.13,
  elbow: 0.098,
  wrist: 0.072,
  hip: 0.165,
  knee: 0.115,
  ankle: 0.08,
  neck: 0.085,
  puff: 0.165,
  head: 0.25,
} as const

const LIMBS: ReadonlyArray<readonly [LimbPart, JointName, JointName]> = [
  ['l_upper_arm', 'l_shoulder', 'l_elbow'],
  ['r_upper_arm', 'r_shoulder', 'r_elbow'],
  ['l_forearm', 'l_elbow', 'l_wrist'],
  ['r_forearm', 'r_elbow', 'r_wrist'],
  ['l_thigh', 'l_hip', 'l_knee'],
  ['r_thigh', 'r_hip', 'r_knee'],
  ['l_shin', 'l_knee', 'l_ankle'],
  ['r_shin', 'r_knee', 'r_ankle'],
]

const JOINT_SPHERES: ReadonlyArray<readonly [JointPart, number]> = [
  ['l_shoulder', RADIUS.puff],
  ['r_shoulder', RADIUS.puff],
  ['l_elbow', RADIUS.elbow],
  ['r_elbow', RADIUS.elbow],
  ['l_hip', RADIUS.hip],
  ['r_hip', RADIUS.hip],
  ['l_knee', RADIUS.knee],
  ['r_knee', RADIUS.knee],
  ['l_ankle', RADIUS.ankle],
  ['r_ankle', RADIUS.ankle],
]

// --- vectors -------------------------------------------------------------------------------
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export function normalize(a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 {
  const l = len(a)
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : fallback
}
/** `v` minus its component along unit `n`, normalized (fallback when parallel). */
function orthoTo(v: Vec3, n: Vec3, fallback: Vec3): Vec3 {
  return normalize(sub(v, mul(n, dot(v, n))), fallback)
}
/** Two unit vectors perpendicular to unit `d`, preferring `hint` (projected) for the second (right-handed: x, d, z). */
function perp(d: Vec3, hint: Vec3): [Vec3, Vec3] {
  const alt: Vec3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const z = orthoTo(hint, d, orthoTo(alt, d, [1, 0, 0]))
  return [cross(d, z), z]
}

const UP: Vec3 = [0, 1, 0]
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Builds the rig for a body-frame pose at `root` in `view`; `time` (s) animates the gown. */
export function buildRig(pose: Pose2D, root: Vec2, view: FigureView, time = 0, pulse = 0): Rig {
  const s = view.scale
  const bv = figureBodyView(view, root)
  const lifted = liftPose(pose)
  const W: Partial<Record<JointName, Vec3>> = {}
  for (const [j, p] of Object.entries(lifted.joints) as Array<[JointName, Vec3]>) {
    const [sx, sy] = bodyToScreen([p[0], p[1]], bv)
    W[j] = [sx, -sy, p[2] * s]
  }
  const m = view.mirrored ? 1 : -1
  const facing: Vec3 = normalize([m * Math.sin(lifted.yaw), 0, Math.cos(lifted.yaw)], [0, 0, 1])
  const parts: Rig['parts'] = {}
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  const grow = (p: Vec3, r: number): void => {
    box.x0 = Math.min(box.x0, p[0] - r)
    box.x1 = Math.max(box.x1, p[0] + r)
    box.y0 = Math.min(box.y0, -p[1] - r)
    box.y1 = Math.max(box.y1, -p[1] + r)
  }
  const segment = (a: Vec3, b: Vec3, r: number): Basis => {
    const d = sub(b, a)
    const [x, z] = perp(normalize(d), facing)
    grow(a, r * s)
    grow(b, r * s)
    return { o: a, x: mul(x, s), y: d, z: mul(z, s) }
  }

  for (const [part, a, b] of LIMBS) {
    const pa = W[a]
    const pb = W[b]
    if (pa && pb) parts[part] = segment(pa, pb, RADIUS.hip)
  }
  for (const [part, r] of JOINT_SPHERES) {
    const p = W[part]
    if (!p) continue
    parts[part] = { o: p, x: [r * s, 0, 0], y: [0, r * s, 0], z: [0, 0, r * s] }
    grow(p, r * s)
  }
  // Hands: mitten ellipsoids past the wrists, flat side to the viewer.
  for (const [part, e, w] of [
    ['l_hand', 'l_elbow', 'l_wrist'],
    ['r_hand', 'r_elbow', 'r_wrist'],
  ] as const) {
    const pe = W[e]
    const pw = W[w]
    if (!pe || !pw) continue
    const d = normalize(sub(pw, pe))
    const [x, z] = perp(d, [0, 0, 1])
    const o = add(pw, mul(d, 0.075 * s))
    parts[part] = { o, x: mul(x, 0.085 * s), y: mul(d, 0.115 * s), z: mul(z, 0.058 * s) }
    grow(o, 0.11 * s)
  }
  // Feet: slippers pointing forward with a little turnout; a lifted foot points its toe along the shin.
  const fh = orthoTo(facing, UP, [0, 0, 1])
  const lowest = Math.min(W.l_ankle?.[1] ?? Infinity, W.r_ankle?.[1] ?? Infinity)
  for (const [part, k, a, side] of [
    ['l_foot', 'l_knee', 'l_ankle', -1],
    ['r_foot', 'r_knee', 'r_ankle', 1],
  ] as const) {
    const pk = W[k]
    const pa = W[a]
    if (!pk || !pa) continue
    const shin = normalize(sub(pa, pk), [0, -1, 0])
    const lift = clamp((pa[1] - lowest) / (0.5 * s), 0, 1)
    const out = mul(cross(UP, fh), side * m * 0.4)
    const toe = normalize(add(mul(normalize(add(fh, out)), 1 - 0.75 * lift), mul(shin, 0.95 * lift)), fh)
    const [x, z] = perp(toe, UP)
    const o = add(add(pa, mul(toe, 0.06 * s)), [0, -0.035 * s * (1 - lift), 0])
    parts[part] = { o, x: mul(x, 0.068 * s), y: mul(toe, 0.135 * s), z: mul(z, 0.062 * s) }
    grow(o, 0.14 * s)
  }

  // Torso frame: mid-hip -> mid-shoulder, facing the turn.
  const { l_shoulder: ls, r_shoulder: rs, l_hip: lh, r_hip: rh } = W
  let skirt: Float32Array | null = null
  let ms: Vec3 | null = null
  let up = UP
  if (ls && rs && lh && rh) {
    ms = mul(add(ls, rs), 0.5)
    const mh = mul(add(lh, rh), 0.5)
    const ty = sub(ms, mh)
    up = normalize(ty)
    const tz = orthoTo(facing, up, [0, 0, 1])
    const tx = cross(up, tz)
    parts.torso = { o: mh, x: mul(tx, s), y: ty, z: mul(tz, s) }
    grow(mh, 0.45 * s)
    grow(ms, 0.45 * s)
    const waist = add(mh, mul(ty, 0.4))
    parts.sash = { o: waist, x: mul(tx, 0.245 * s), y: mul(up, 0.05 * s), z: mul(tz, 0.165 * s) }
    skirt = skirtVertices(waist, W, fh, s, time, pulse)
    for (let i = 0; i < skirt.length; i += 3) grow([skirt[i], skirt[i + 1], skirt[i + 2]], 2)
  }

  // Neck + head (frame tilted with the neck, facing the turn).
  const head = headCircle(pose)
  if (head) {
    const [hx, hy] = bodyToScreen(head.center, bv)
    const hc: Vec3 = [hx, -hy, 0]
    const r = RADIUS.head * s
    const hy3 = ms ? normalize(add(normalize(sub(hc, ms), up), up)) : up
    const hz = orthoTo(facing, hy3, [0, 0, 1])
    parts.head = { o: hc, x: mul(cross(hy3, hz), r), y: mul(hy3, r), z: mul(hz, r) }
    grow(add(hc, mul(hy3, 0.35 * r)), 1.5 * r)
    if (ms) parts.neck = segment(add(ms, mul(up, 0.02 * s)), sub(hc, mul(hy3, 0.4 * r)), RADIUS.neck)
  }
  return { parts, skirt, box }
}

/**
 * The gown's skirt: panels hang from the waist and flare to a scalloped hem above the knees; a
 * panel opens up to clear a thigh swinging out under it (knee lifts, kicks, side steps), and the
 * hem ripples gently over time (+ a little extra flare on the beat).
 */
export function skirtVertices(waist: Vec3, W: Partial<Record<JointName, Vec3>>, fh: Vec3, s: number, time: number, pulse: number): Float32Array {
  const right = cross(UP, fh)
  const down: Vec3 = [0, -1, 0]
  const legs: Array<{ az: number; angle: number }> = []
  for (const [h, k] of [
    ['l_hip', 'l_knee'],
    ['r_hip', 'r_knee'],
  ] as const) {
    const ph = W[h]
    const pk = W[k]
    if (!ph || !pk) continue
    const u = normalize(sub(pk, ph), down)
    legs.push({ az: Math.atan2(dot(u, fh), dot(u, right)), angle: Math.acos(clamp(dot(u, down), -1, 1)) })
  }
  const out = new Float32Array(SKIRT_RINGS * SKIRT_SEGMENTS * 3)
  const drop = 1.02 * s
  for (let j = 0; j < SKIRT_SEGMENTS; j++) {
    const th = (j / SKIRT_SEGMENTS) * Math.PI * 2
    const c = Math.cos(th)
    const sn = Math.sin(th)
    const radial = normalize(add(mul(right, c * 1), mul(fh, sn * 0.86)), right)
    const top = add(waist, add(mul(right, c * 0.25 * s), mul(fh, sn * 0.165 * s)))
    const flare = (0.38 + 0.03 * Math.cos(2 * th)) * s
    const base = Math.atan2(flare, drop)
    let phi = base
    for (const leg of legs) {
      // Capped: a knee lift pokes through the front instead of hoisting the whole panel.
      const target = Math.min(leg.angle + 0.3, 1.0)
      if (target <= base) continue
      const w = Math.max(0, Math.cos(th - leg.az)) ** 6
      phi = Math.max(phi, base + (target - base) * w)
    }
    phi += 0.03 * Math.sin(3 * th + 2.1 * time) + 0.02 * Math.sin(5 * th - 2.9 * time) + 0.05 * pulse
    const length = Math.hypot(flare, drop) * (1 + 0.045 * Math.cos(12 * th))
    const dir = add(mul(down, Math.cos(phi)), mul(radial, Math.sin(phi)))
    const bell = mul(radial, 0.05 * s)
    for (let i = 0; i < SKIRT_RINGS; i++) {
      const t = i / (SKIRT_RINGS - 1)
      const p = add(add(top, mul(dir, length * t)), mul(bell, Math.sin(Math.PI * t) * (1 - t * 0.5)))
      const o = (i * SKIRT_SEGMENTS + j) * 3
      out[o] = p[0]
      out[o + 1] = p[1]
      out[o + 2] = p[2]
    }
  }
  return out
}
