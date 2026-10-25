// Continuous motion track for a whole routine: sample(t) gives the coach's pose at song time t.
//
// All keyframes of the routine go on one global timeline (a move's last keyframe and the next
// move's first keyframe merge when they meet with the same pose; a different start pose
// blends in over transitionSec like poseAtTime). Each knot pose is decomposed into a rigid
// kinematic tree rooted at mid-hip, one (angle, length) pair per bone, and every channel is
// interpolated with a monotone cubic (PCHIP, Fritsch-Carlson/Butland slopes): C1, exact at
// every knot, no overshoot (lengths and angles stay within their neighbouring knots), zero
// velocity at local extrema and holds, and non-zero velocity where the motion continues
// through a keyframe (e.g. across move boundaries). sample(t) is a binary search plus a few
// dozen precomputed cubics: O(log n), allocation-light.
//
// 2D-projected spins shrink a bone to zero length and flip it by 180 degrees. Rotating
// through that would swing the bone sideways, so such a step is encoded as a signed length
// passing through zero instead (the bone slides through its parent like the projection does).

import type { Routine } from '@shared/routine'
import { JOINTS, type JointName, type Pose2D, type Vec2 } from '@shared/skeleton'
import { lastStartedIndex, NEUTRAL_POSE, poseAtTime, poseDistance, SAME_POSE_EPS, transitionSec, type KeyframeLike, type RoutineSample } from './pose'

export interface MotionTrack {
  /** Pose + root at song time t (seconds), plus which move is playing / next. */
  sample(t: number): RoutineSample
}

type FullPose = Record<JointName, Vec2>
type MoveLike = Routine['moves'][number]

interface Knot {
  time: number
  pose: FullPose
  root: Vec2
}

// --- kinematic tree ----------------------------------------------------------------------

/**
 * Bones as [child, parent]. 'sh' / 'hp' are half-vectors from mid-shoulder to r_shoulder and
 * from mid-hip to r_hip (the left joint is the mirror through the midpoint), so mid-points stay
 * exact. Everything else hangs off a joint.
 */
const BONES = [
  'torso', // mid-hip -> mid-shoulder
  'sh', // mid-shoulder -> r_shoulder (l_shoulder = ms - sh)
  'hp', // mid-hip -> r_hip (l_hip = mh - hp)
  'l_elbow',
  'l_wrist',
  'r_elbow',
  'r_wrist',
  'l_knee',
  'l_ankle',
  'r_knee',
  'r_ankle',
  'nose',
  'l_eye',
  'r_eye',
  'l_ear',
  'r_ear',
] as const
const NB = BONES.length
/** Channels: mid-hip x/y, root x/y, then (angle, length) per bone. */
const NC = 4 + 2 * NB
const A0 = 4

/** Parent of each joint bone ('ms' = mid-shoulder). */
const PARENT: Record<Exclude<(typeof BONES)[number], 'torso' | 'sh' | 'hp'>, JointName | 'ms'> = {
  l_elbow: 'l_shoulder',
  l_wrist: 'l_elbow',
  r_elbow: 'r_shoulder',
  r_wrist: 'r_elbow',
  l_knee: 'l_hip',
  l_ankle: 'l_knee',
  r_knee: 'r_hip',
  r_ankle: 'r_knee',
  nose: 'ms',
  l_eye: 'nose',
  r_eye: 'nose',
  l_ear: 'nose',
  r_ear: 'nose',
}

/** Bone vectors (dx, dy) of a full pose, NB pairs, plus mid-hip. */
function boneVectors(p: FullPose, out: Float64Array): void {
  const mhx = (p.l_hip[0] + p.r_hip[0]) / 2
  const mhy = (p.l_hip[1] + p.r_hip[1]) / 2
  const msx = (p.l_shoulder[0] + p.r_shoulder[0]) / 2
  const msy = (p.l_shoulder[1] + p.r_shoulder[1]) / 2
  out[0] = mhx
  out[1] = mhy
  for (let b = 0; b < NB; b++) {
    const name = BONES[b]
    let dx: number
    let dy: number
    if (name === 'torso') {
      dx = msx - mhx
      dy = msy - mhy
    } else if (name === 'sh') {
      dx = (p.r_shoulder[0] - p.l_shoulder[0]) / 2
      dy = (p.r_shoulder[1] - p.l_shoulder[1]) / 2
    } else if (name === 'hp') {
      dx = (p.r_hip[0] - p.l_hip[0]) / 2
      dy = (p.r_hip[1] - p.l_hip[1]) / 2
    } else {
      const par = PARENT[name]
      const [px, py] = par === 'ms' ? [msx, msy] : p[par]
      dx = p[name][0] - px
      dy = p[name][1] - py
    }
    out[2 + 2 * b] = dx
    out[3 + 2 * b] = dy
  }
}

/** Rebuilds the 17 joints from channel values (angles + signed lengths). */
function poseFromChannels(c: Float64Array): Pose2D {
  const v = (b: number): Vec2 => {
    const a = c[A0 + 2 * b]
    const l = c[A0 + 2 * b + 1]
    return [l * Math.cos(a), l * Math.sin(a)]
  }
  const add = (p: Vec2, d: Vec2): Vec2 => [p[0] + d[0], p[1] + d[1]]
  const sub = (p: Vec2, d: Vec2): Vec2 => [p[0] - d[0], p[1] - d[1]]
  const mh: Vec2 = [c[0], c[1]]
  const ms = add(mh, v(0))
  const sh = v(1)
  const hp = v(2)
  const l_shoulder = sub(ms, sh)
  const r_shoulder = add(ms, sh)
  const l_hip = sub(mh, hp)
  const r_hip = add(mh, hp)
  const l_elbow = add(l_shoulder, v(3))
  const r_elbow = add(r_shoulder, v(5))
  const l_knee = add(l_hip, v(7))
  const r_knee = add(r_hip, v(9))
  const nose = add(ms, v(11))
  return {
    nose,
    l_eye: add(nose, v(12)),
    r_eye: add(nose, v(13)),
    l_ear: add(nose, v(14)),
    r_ear: add(nose, v(15)),
    l_shoulder,
    r_shoulder,
    l_elbow,
    r_elbow,
    l_wrist: add(l_elbow, v(4)),
    r_wrist: add(r_elbow, v(6)),
    l_hip,
    r_hip,
    l_knee,
    r_knee,
    l_ankle: add(l_knee, v(8)),
    r_ankle: add(r_knee, v(10)),
  }
}

const TAU = Math.PI * 2
const wrapPi = (x: number): number => x - TAU * Math.round(x / TAU)
/** Below this a bone has no direction. */
const ZERO_LEN = 1e-9

/**
 * Unwrapped channel values for every knot. Angles take the shortest rotation from the previous
 * knot, except a foreshortened 180-degree flip, which becomes a signed length through zero.
 */
function knotChannels(knots: readonly Knot[]): Float64Array {
  const n = knots.length
  const y = new Float64Array(n * NC)
  const vec = new Float64Array(2 + 2 * NB)
  const prevVec = new Float64Array(2 + 2 * NB)
  for (let k = 0; k < n; k++) {
    boneVectors(knots[k].pose, vec)
    const o = k * NC
    const po = o - NC
    y[o] = vec[0]
    y[o + 1] = vec[1]
    y[o + 2] = knots[k].root[0]
    y[o + 3] = knots[k].root[1]
    for (let b = 0; b < NB; b++) {
      const dx = vec[2 + 2 * b]
      const dy = vec[3 + 2 * b]
      const len = Math.hypot(dx, dy)
      const ia = o + A0 + 2 * b
      if (k === 0) {
        y[ia] = len > ZERO_LEN ? Math.atan2(dy, dx) : -Math.PI / 2
        y[ia + 1] = len
        continue
      }
      const pa = y[po + A0 + 2 * b]
      const pl = y[po + A0 + 2 * b + 1]
      if (dx === prevVec[2 + 2 * b] && dy === prevVec[3 + 2 * b]) {
        // Same bone as the previous knot: copy exactly so holds stay perfectly still.
        y[ia] = pa
        y[ia + 1] = pl
        continue
      }
      const raw = len > ZERO_LEN ? Math.atan2(dy, dx) : pl >= 0 ? pa : pa + Math.PI
      const d1 = wrapPi(raw - pa)
      const d2 = wrapPi(raw + Math.PI - pa)
      const apl = Math.abs(pl)
      const cost1 = Math.abs(d1) * (apl + len) * 0.5 + 2 * Math.abs(len - pl)
      const cost2 = Math.abs(d2) * (apl + len) * 0.5 + 2 * Math.abs(-len - pl)
      // "Keep" leaves the length's sign alone (the bone rotates); "flip" slides it through zero.
      const keepPos = pl >= 0
      const dKeep = keepPos ? d1 : d2
      const dFlip = keepPos ? d2 : d1
      const foreshortened = Math.min(apl, len) <= 0.25 * Math.max(apl, len)
      // A spin's side-on step (widths clamped, server fk.TURN_MIN_WIDTH): x changes sign, y stays.
      // Bones nearer horizontal than vertical slide through zero instead of swinging round.
      const pdx = prevVec[2 + 2 * b]
      const mirrorStep =
        dx * pdx < 0 && Math.abs(dy - prevVec[3 + 2 * b]) <= 0.1 * (Math.abs(dx) + Math.abs(pdx)) && Math.abs(dFlip) < Math.abs(dKeep)
      const flip = (foreshortened && (keepPos ? cost2 < cost1 : cost1 < cost2)) || mirrorStep
      if (keepPos === flip) {
        y[ia] = pa + d2
        y[ia + 1] = -len
      } else {
        y[ia] = pa + d1
        y[ia + 1] = len
      }
    }
    prevVec.set(vec)
  }
  return y
}

// --- knots -------------------------------------------------------------------------------

const ZERO: Vec2 = [0, 0]
const T_EPS = 1e-9

function fillPose(p: Pose2D, fallback: FullPose): FullPose {
  const out = {} as FullPose
  for (const j of JOINTS) out[j] = p[j] ?? fallback[j]
  return out
}

function samePose(a: Knot, b: Knot): boolean {
  return (
    poseDistance(a.pose, b.pose) < SAME_POSE_EPS &&
    Math.abs(a.root[0] - b.root[0]) < SAME_POSE_EPS &&
    Math.abs(a.root[1] - b.root[1]) < SAME_POSE_EPS
  )
}

/** One move's keyframes as timed knots covering [startTime, endTime] (first/last held). */
function moveKnots(m: MoveLike, fallback: FullPose): Knot[] {
  const dur = m.endTime - m.startTime
  const kfs: readonly KeyframeLike[] = m.keyframes.length > 0 ? m.keyframes : [{ t: 0, pose: NEUTRAL_POSE }]
  const out: Knot[] = []
  let prev = fallback
  for (const k of kfs) {
    const u = k.t <= 0 ? 0 : k.t >= 1 ? 1 : Number.isFinite(k.t) ? k.t : 0
    const pose = fillPose(k.pose, prev)
    prev = pose
    const knot: Knot = { time: m.startTime + u * dur, pose, root: k.root ?? ZERO }
    const last = out[out.length - 1]
    if (last && !(knot.time > last.time + T_EPS)) out[out.length - 1] = { ...knot, time: last.time }
    else out.push(knot)
  }
  const first = out[0]
  if (first.time > m.startTime + T_EPS) out.unshift({ ...first, time: m.startTime })
  const last = out[out.length - 1]
  if (last.time < m.endTime - T_EPS) out.push({ ...last, time: m.endTime })
  return out
}

/** The routine's global knot list (strictly increasing times). */
export function routineKnots(moves: readonly MoveLike[]): Knot[] {
  const knots: Knot[] = []
  const push = (k: Knot): void => {
    const last = knots[knots.length - 1]
    if (last && !(k.time > last.time + T_EPS)) knots[knots.length - 1] = { ...k, time: last.time }
    else knots.push(k)
  }
  for (const m of moves) {
    if (!(m.endTime > m.startTime)) continue
    const prev = knots[knots.length - 1]
    const ks = moveKnots(m, prev ? prev.pose : { ...NEUTRAL_POSE })
    if (!prev) {
      ks.forEach(push)
      continue
    }
    const first = ks[0]
    if (samePose(prev, first)) {
      // Seamless: merge (contiguous) or hold through the gap.
      if (first.time > prev.time + T_EPS) push(first)
    } else {
      // Gap: hold the previous end pose until the move starts.
      if (first.time > prev.time + T_EPS) push({ ...prev, time: first.time })
      // Then blend into the move's start pose over transitionSec (poseAtTime's window).
      const blendEnd = first.time + transitionSec(m)
      if (ks.length < 2 || blendEnd < ks[1].time - T_EPS) push({ ...first, time: blendEnd })
    }
    for (let i = 1; i < ks.length; i++) push(ks[i])
  }
  return knots
}

// --- PCHIP -------------------------------------------------------------------------------

/** Per segment and channel: [a, b, c, d] of a + b s + c s^2 + d s^3, s = t - t_k. */
function pchipCoefficients(times: Float64Array, y: Float64Array, n: number): Float64Array {
  const coef = new Float64Array(Math.max(0, n - 1) * NC * 4)
  const m = new Float64Array(n)
  for (let ch = 0; ch < NC; ch++) {
    // Slopes: zero at both ends (the track holds before/after), harmonic-mean inside.
    m[0] = 0
    m[n - 1] = 0
    for (let k = 1; k < n - 1; k++) {
      const h0 = times[k] - times[k - 1]
      const h1 = times[k + 1] - times[k]
      const d0 = (y[k * NC + ch] - y[(k - 1) * NC + ch]) / h0
      const d1 = (y[(k + 1) * NC + ch] - y[k * NC + ch]) / h1
      if (d0 === 0 || d1 === 0 || d0 > 0 !== d1 > 0) {
        m[k] = 0
      } else {
        const w1 = 2 * h1 + h0
        const w2 = h1 + 2 * h0
        m[k] = (w1 + w2) / (w1 / d0 + w2 / d1)
      }
    }
    for (let k = 0; k < n - 1; k++) {
      const h = times[k + 1] - times[k]
      const y0 = y[k * NC + ch]
      const y1 = y[(k + 1) * NC + ch]
      const delta = (y1 - y0) / h
      const o = (k * NC + ch) * 4
      coef[o] = y0
      if (y0 === y1) continue // hold: constant (b = c = d = 0)
      coef[o + 1] = m[k]
      coef[o + 2] = (3 * delta - 2 * m[k] - m[k + 1]) / h
      coef[o + 3] = (m[k] + m[k + 1] - 2 * delta) / (h * h)
    }
  }
  return coef
}

// --- track -------------------------------------------------------------------------------

const clamp01 = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : Number.isNaN(u) ? 0 : u)

export function buildMotionTrack(routine: Pick<Routine, 'moves'>): MotionTrack {
  const moves = routine.moves
  const knots = routineKnots(moves)
  const n = knots.length
  if (n === 0) return { sample: (t) => poseAtTime(routine, t) }

  const times = new Float64Array(n)
  for (let k = 0; k < n; k++) times[k] = knots[k].time
  const y = knotChannels(knots)
  const coef = pchipCoefficients(times, y, n)
  const ch = new Float64Array(NC)

  const evalAt = (t: number): void => {
    if (!(t > times[0])) {
      for (let c = 0; c < NC; c++) ch[c] = y[c]
      return
    }
    if (t >= times[n - 1]) {
      const o = (n - 1) * NC
      for (let c = 0; c < NC; c++) ch[c] = y[o + c]
      return
    }
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (times[mid] <= t) lo = mid
      else hi = mid
    }
    const s = t - times[lo]
    const base = lo * NC
    for (let c = 0; c < NC; c++) {
      const o = (base + c) * 4
      let v = coef[o] + s * (coef[o + 1] + s * (coef[o + 2] + s * coef[o + 3]))
      // Monotone cubics never leave [y0, y1]; clamp away rounding anyway (no stretching).
      const y0 = y[base + c]
      const y1 = y[base + NC + c]
      if (y0 <= y1) v = v < y0 ? y0 : v > y1 ? y1 : v
      else v = v < y1 ? y1 : v > y0 ? y0 : v
      ch[c] = v
    }
  }

  return {
    sample(t: number): RoutineSample {
      evalAt(t)
      const pose = poseFromChannels(ch)
      const root: Vec2 = [ch[2], ch[3]]
      // Move bookkeeping: identical to poseAtTime.
      const i = lastStartedIndex(moves, t)
      if (i < 0) return { pose, root, moveIndex: -1, u: 0, nextMoveIndex: moves.length > 0 ? 0 : -1 }
      const move = moves[i]
      const next = i + 1 < moves.length ? i + 1 : -1
      if (!(t < move.endTime)) return { pose, root, moveIndex: -1, u: 0, nextMoveIndex: next }
      const dur = move.endTime - move.startTime
      return { pose, root, moveIndex: i, u: dur > 0 ? clamp01((t - move.startTime) / dur) : 1, nextMoveIndex: next }
    },
  }
}
