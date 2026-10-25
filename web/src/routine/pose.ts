// Pure pose interpolation for routines and library moves (no DOM; unit-tested). Used by the
// move gallery, the analysis preview and (Stage 3) the coach renderer. All poses are in the
// shared body frame (shared/README.md); `root` is the rendering-only mid-hip offset.

import { JOINTS, MIRROR, type JointName, type Pose2D, type Vec2 } from '@shared/skeleton'
import type { Routine } from '@shared/routine'

/** Neutral standing pose (shared/README.md, shared/examples/routine.example.json). */
export const NEUTRAL_POSE: Readonly<Record<JointName, Vec2>> = {
  nose: [0, -1.45],
  l_eye: [-0.07, -1.52],
  r_eye: [0.07, -1.52],
  l_ear: [-0.15, -1.48],
  r_ear: [0.15, -1.48],
  l_shoulder: [-0.45, -1],
  r_shoulder: [0.45, -1],
  l_elbow: [-0.52, -0.42],
  r_elbow: [0.52, -0.42],
  l_wrist: [-0.55, 0.12],
  r_wrist: [0.55, 0.12],
  l_hip: [-0.22, 0],
  r_hip: [0.22, 0],
  l_knee: [-0.22, 0.95],
  r_knee: [0.22, 0.95],
  l_ankle: [-0.22, 1.85],
  r_ankle: [0.22, 1.85],
}

/** Ankle height of the neutral pose: where the floor is, relative to mid-hip at root [0, 0]. */
export const NEUTRAL_ANKLE_Y = 1.85

/** Any keyframe shape: routine keyframes (root optional) and library keyframes (root required). */
export interface KeyframeLike {
  t: number
  pose: Pose2D
  root?: Vec2
}

export interface PoseSample {
  pose: Pose2D
  root: Vec2
}

export interface RoutineSample extends PoseSample {
  /** Move playing at t (startTime <= t < endTime), else -1 (before, between or after moves). */
  moveIndex: number
  /** Progress through moveIndex's move, 0..1 (0 when moveIndex is -1). */
  u: number
  /** The next move to start after t, else -1. */
  nextMoveIndex: number
}

const clamp01 = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : Number.isNaN(u) ? 0 : u)

// --- easing ----------------------------------------------------------------------------

/** Sine ease-in-out on [0, 1] (clamped): 0 -> 0, 0.5 -> 0.5, 1 -> 1, zero slope at both ends. */
export function easeInOutSine(u: number): number {
  return (1 - Math.cos(Math.PI * clamp01(u))) / 2
}

/** Hermite smoothstep on [0, 1] (clamped): 3u^2 - 2u^3. */
export function smoothstep(u: number): number {
  const x = clamp01(u)
  return x * x * (3 - 2 * x)
}

// --- poses -----------------------------------------------------------------------------

export function lerpVec(a: Vec2, b: Vec2, u: number): Vec2 {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
}

/** Joint-wise lerp. A joint present in only one pose is taken from that pose. */
export function lerpPose(a: Pose2D, b: Pose2D, u: number): Pose2D {
  const out: Pose2D = {}
  for (const j of JOINTS) {
    const pa = a[j]
    const pb = b[j]
    if (pa && pb) out[j] = lerpVec(pa, pb, u)
    else if (pa) out[j] = pa
    else if (pb) out[j] = pb
  }
  return out
}

/** Left/right mirror image of a body-frame pose (x negated, l_/r_ joints swapped). */
export function mirrorPose(p: Pose2D): Pose2D {
  const out: Pose2D = {}
  for (const j of JOINTS) {
    const v = p[MIRROR[j]]
    if (v) out[j] = [v[0] === 0 ? 0 : -v[0], v[1]]
  }
  return out
}

/** Largest coordinate difference between two poses (joints missing from either are ignored). */
export function poseDistance(a: Pose2D, b: Pose2D): number {
  let d = 0
  for (const j of JOINTS) {
    const pa = a[j]
    const pb = b[j]
    if (pa && pb) d = Math.max(d, Math.abs(pa[0] - pb[0]), Math.abs(pa[1] - pb[1]))
  }
  return d
}

const ZERO: Vec2 = [0, 0]
const rootOf = (k: KeyframeLike): Vec2 => k.root ?? ZERO

/**
 * Pose at fraction `u` (0..1) of a move: eased (easeInOutSine) interpolation between the
 * neighbouring keyframes; exact at keyframe times; holds the first/last keyframe outside
 * their range. Neutral for an empty keyframe list.
 */
export function poseInMove(keyframes: readonly KeyframeLike[], u: number, ease: (u: number) => number = easeInOutSine): PoseSample {
  const n = keyframes.length
  if (n === 0) return { pose: { ...NEUTRAL_POSE }, root: ZERO }
  const first = keyframes[0]
  if (!(u > first.t)) return { pose: first.pose, root: rootOf(first) }
  const last = keyframes[n - 1]
  if (u >= last.t) return { pose: last.pose, root: rootOf(last) }
  // Last keyframe with t <= u (binary search; keyframes ascend by t).
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (keyframes[mid].t <= u) lo = mid
    else hi = mid
  }
  const a = keyframes[lo]
  const b = keyframes[hi]
  const span = b.t - a.t
  if (!(span > 0)) return { pose: b.pose, root: rootOf(b) }
  const e = ease((u - a.t) / span)
  return { pose: lerpPose(a.pose, b.pose, e), root: lerpVec(rootOf(a), rootOf(b), e) }
}

// --- routines --------------------------------------------------------------------------

type Timed = { startTime: number; endTime: number }

/** Index of the last move with startTime <= t, or -1. Moves are in playback order. */
export function lastStartedIndex(moves: readonly Timed[], t: number): number {
  let lo = 0
  let hi = moves.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (moves[mid].startTime <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** Index of the move playing at song time t (startTime <= t < endTime), or -1. Binary search. */
export function moveIndexAt(routine: Pick<Routine, 'moves'>, t: number): number {
  const i = lastStartedIndex(routine.moves, t)
  return i >= 0 && t < routine.moves[i].endTime ? i : -1
}

/** Below this (body units) a move's start pose counts as equal to the previous end pose. */
export const SAME_POSE_EPS = 1e-4

/**
 * Joint speed (body units / s) that a blend between moves is paced for: about what real dancers do
 * (AIST++ clips move their fastest joint at ~4 u/s median, ~7 u/s p90).
 */
export const BLEND_SPEED = 6

/**
 * Seconds over which move `m` blends in from a different previous end pose: min(0.5 beat, 15% of the
 * move), stretched for a big jump (`gap`: largest joint coordinate change, body units; real-dancer
 * clips chain by distance rather than shared anchor poses) to gap / BLEND_SPEED, never past half a beat.
 */
export function transitionSec(m: Timed & { lengthBeats: number }, gap = 0): number {
  const dur = m.endTime - m.startTime
  if (!(dur > 0)) return 0
  const beatSec = dur / Math.max(1, m.lengthBeats)
  const base = Math.min(0.5 * beatSec, 0.15 * dur)
  return Math.max(base, Math.min(0.5 * beatSec, (gap > 0 ? gap : 0) / BLEND_SPEED))
}

/** The gap transitionSec paces for: largest joint coordinate or root change, body units. */
export function transitionGap(a: PoseSample, b: PoseSample): number {
  return Math.max(poseDistance(a.pose, b.pose), Math.abs(a.root[0] - b.root[0]), Math.abs(a.root[1] - b.root[1]))
}

/**
 * Coach pose at song time t. Inside a move: poseInMove at its progress; if the move's start
 * pose differs from the previous move's end pose it blends in (smoothstep) from that end pose
 * over transitionSec(move, gap), so the figure never jumps. Before the first move the first start
 * pose is held; between moves and after the last, the previous end pose. Neutral when empty.
 */
export function poseAtTime(routine: Pick<Routine, 'moves'>, t: number): RoutineSample {
  const moves = routine.moves
  if (moves.length === 0) return { pose: { ...NEUTRAL_POSE }, root: ZERO, moveIndex: -1, u: 0, nextMoveIndex: -1 }
  const i = lastStartedIndex(moves, t)
  if (i < 0) {
    const first = poseInMove(moves[0].keyframes, 0)
    return { ...first, moveIndex: -1, u: 0, nextMoveIndex: 0 }
  }
  const move = moves[i]
  const next = i + 1 < moves.length ? i + 1 : -1
  if (!(t < move.endTime)) {
    return { ...poseInMove(move.keyframes, 1), moveIndex: -1, u: 0, nextMoveIndex: next }
  }
  const dur = move.endTime - move.startTime
  const u = dur > 0 ? clamp01((t - move.startTime) / dur) : 1
  const sample = poseInMove(move.keyframes, u)
  const out: RoutineSample = { ...sample, moveIndex: i, u, nextMoveIndex: next }
  if (i === 0) return out

  const elapsed = t - move.startTime
  if (!(elapsed < transitionSec(move, Infinity))) return out // past the longest possible window
  const prevEnd = poseInMove(moves[i - 1].keyframes, 1)
  const start = poseInMove(move.keyframes, 0)
  const gap = transitionGap(prevEnd, start)
  if (gap < SAME_POSE_EPS) return out
  const window = transitionSec(move, gap)
  if (!(elapsed < window)) return out
  const b = smoothstep(elapsed / window)
  out.pose = lerpPose(prevEnd.pose, sample.pose, b)
  out.root = lerpVec(prevEnd.root, sample.root, b)
  return out
}
