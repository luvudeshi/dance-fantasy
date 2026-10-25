// 2D -> 3D pose lifting for the 3D coach (pure, unit-tested). The client only gets 2D body-frame
// joints (shared/README.md); this recovers a plausible depth per joint so knee lifts, arm swings and
// spins read as 3D:
//   - body turn (yaw) from shoulder + hip width vs the neutral pose, direction from the nose offset;
//   - limb depth from foreshortening, |dz| = sqrt(L^2 - l^2) with L the neutral bone length;
//   - the sign from simple priors: elbows/wrists stay in the turned frontal plane (with a slight
//     forward bias), knees go forward, a planted foot comes back under the hip, a lifted one follows
//     the thigh (front kick).
// Output frame: body frame + z toward the viewer (= the dancer's front when facing the camera).

import type { JointName, Pose2D, Vec2 } from '@shared/skeleton'
import { NEUTRAL_POSE } from '../routine/pose'

export type Vec3 = [number, number, number]

export interface LiftedPose {
  /** x = dancer's right, y = down, z = toward the viewer (body units). Face joints keep z = 0. */
  joints: Partial<Record<JointName, Vec3>>
  /** Body turn in radians, FK convention: + turns toward the dancer's right; |yaw| > pi/2 = back to the viewer. */
  yaw: number
}

const N = NEUTRAL_POSE
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1])
const midOf = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

const SHOULDER_SPAN = dist(N.l_shoulder, N.r_shoulder)
const HIP_SPAN = dist(N.l_hip, N.r_hip)

/** Neutral bone lengths (body units): the 3D lengths every lifted limb keeps. */
export const BONE_LENGTH = {
  upperArm: dist(N.r_shoulder, N.r_elbow),
  forearm: dist(N.r_elbow, N.r_wrist),
  thigh: dist(N.r_hip, N.r_knee),
  shin: dist(N.r_knee, N.r_ankle),
} as const

/** Signed span (r - l): negative when the right joint is on the left (seen from behind). */
function span(l: Vec2 | undefined, r: Vec2 | undefined): number | null {
  if (!l || !r) return null
  const d = dist(l, r)
  return r[0] - l[0] >= 0 ? d : -d
}

/** Body turn (radians) from shoulder/hip widths and the face direction; 0 when the torso is missing. */
export function estimateYaw(pose: Pose2D): number {
  const s = span(pose.l_shoulder, pose.r_shoulder)
  const h = span(pose.l_hip, pose.r_hip)
  if (s === null && h === null) return 0
  const c = Math.max(-1, Math.min(1, ((s ?? 0) + (h ?? 0)) / ((s === null ? 0 : SHOULDER_SPAN) + (h === null ? 0 : HIP_SPAN))))
  // Direction: the nose sits in front of the ear midpoint, so it moves toward +x when turning + (x = 0.17 sin yaw).
  let off = 0
  const { nose, l_ear: le, r_ear: re, l_shoulder: ls, r_shoulder: rs, l_hip: lh, r_hip: rh } = pose
  if (nose) {
    const ref = le && re ? midOf(le, re) : ls && rs ? midOf(ls, rs) : null
    if (ref) {
      // Measure across the torso axis so a lean doesn't read as a turn.
      let across: Vec2 = [1, 0]
      if (ls && rs && lh && rh) {
        const ms = midOf(ls, rs)
        const mh = midOf(lh, rh)
        const ux = ms[0] - mh[0]
        const uy = ms[1] - mh[1]
        const l = Math.hypot(ux, uy)
        if (l > 1e-9) across = [-uy / l, ux / l]
      }
      off = (nose[0] - ref[0]) * across[0] + (nose[1] - ref[1]) * across[1]
    }
  }
  const sin = Math.sqrt(Math.max(0, 1 - c * c))
  return Math.atan2(off < 0 ? -sin : sin, c)
}

/** |dz| for a bone of 3D length `len` whose 2D projection is `a`->`b`. */
function depthOf(a: Vec2, b: Vec2, len: number): number {
  const l = dist(a, b)
  return l >= len ? 0 : Math.sqrt(len * len - l * l)
}

/** Lifts a 2D body-frame pose to 3D. Missing joints stay missing. */
export function liftPose(pose: Pose2D): LiftedPose {
  const yaw = estimateYaw(pose)
  const sin = Math.sin(yaw)
  const cos = Math.cos(yaw)
  // In-plane depth per unit of x for a vector lying in the turned frontal plane: dz = -dx * tan(yaw).
  const tan = Math.max(-4, Math.min(4, Math.abs(cos) > 1e-6 ? sin / cos : Math.sign(sin) * 4))
  const joints: Partial<Record<JointName, Vec3>> = {}
  const put = (j: JointName, z: number): void => {
    const p = pose[j]
    if (p) joints[j] = [p[0], p[1], z]
  }
  for (const j of ['nose', 'l_eye', 'r_eye', 'l_ear', 'r_ear'] as const) put(j, 0)
  // Torso joints sit on the turned shoulder / hip line (mid-shoulder and mid-hip at z = 0).
  put('l_shoulder', (SHOULDER_SPAN / 2) * sin)
  put('r_shoulder', -(SHOULDER_SPAN / 2) * sin)
  put('l_hip', (HIP_SPAN / 2) * sin)
  put('r_hip', -(HIP_SPAN / 2) * sin)

  /** Child z = parent z +- |dz|, the sign picked to agree with `prior` (the expected dz). */
  const chain = (parent: JointName, child: JointName, len: number, prior: (dx: number) => number): void => {
    const pp = pose[parent]
    const pc = pose[child]
    const pz = joints[parent]?.[2]
    if (!pp || !pc || pz === undefined) return
    const dz = depthOf(pp, pc, len)
    put(child, pz + (prior(pc[0] - pp[0]) < 0 ? -dz : dz))
  }
  const arm = (dx: number): number => -dx * tan + 0.12 * cos
  for (const side of ['l', 'r'] as const) {
    chain(`${side}_shoulder`, `${side}_elbow`, BONE_LENGTH.upperArm, arm)
    chain(`${side}_elbow`, `${side}_wrist`, BONE_LENGTH.forearm, arm)
    chain(`${side}_hip`, `${side}_knee`, BONE_LENGTH.thigh, () => cos)
  }
  // Ankles: a supporting foot (the lower one, or level with it) comes back under its hip; a lifted
  // foot continues the thigh's direction (front kick).
  const la = pose.l_ankle
  const ra = pose.r_ankle
  const lowest = Math.max(la?.[1] ?? Number.NEGATIVE_INFINITY, ra?.[1] ?? Number.NEGATIVE_INFINITY)
  for (const side of ['l', 'r'] as const) {
    const hip = joints[`${side}_hip`]
    const knee = joints[`${side}_knee`]
    const ankle = pose[`${side}_ankle`]
    if (!hip || !knee || !ankle) continue
    const planted = ankle[1] >= lowest - 0.25
    const prior = planted ? hip[2] - knee[2] : knee[2] - hip[2] + 0.1 * cos
    chain(`${side}_knee`, `${side}_ankle`, BONE_LENGTH.shin, () => prior)
  }
  clearBody(pose, joints, yaw)
  return { joints, yaw }
}

/**
 * The dressed body's cross-section at height t along the torso (0 = mid-hip, 1 = mid-shoulder; below
 * the waist at 0.4 the skirt flares): [half-width, half-depth] in body units, null outside it.
 */
export function bodySection(t: number): [number, number] | null {
  if (!(t >= -0.62 && t <= 1.05)) return null
  if (t < 0.4) {
    const h = 0.4 - t
    return [0.29 + h * 0.37, 0.2 + h * 0.32]
  }
  const a = t < 0.75 ? 0.25 + ((t - 0.4) / 0.35) * 0.09 : 0.34 + Math.min(1, (t - 0.75) / 0.2) * 0.04
  return [a, a * 0.62]
}

/**
 * FK arms are planar, so an arm crossing the body (hands on the belly or hips, folded arms) would
 * pass through the torso or the skirt: push elbows and wrists out to the body's front surface (its
 * back, for a dancer facing away), testing the joints and the bones' midpoints.
 */
function clearBody(pose: Pose2D, joints: Partial<Record<JointName, Vec3>>, yaw: number): void {
  const { l_shoulder: ls, r_shoulder: rs, l_hip: lh, r_hip: rh } = pose
  if (!ls || !rs || !lh || !rh) return
  const mh = midOf(lh, rh)
  const ms = midOf(ls, rs)
  const ux = ms[0] - mh[0]
  const uy = ms[1] - mh[1]
  const l2 = ux * ux + uy * uy
  if (!(l2 > 1e-9)) return
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const front = cos >= 0 ? 1 : -1
  /** Depth (toward the dancer's front, as seen) a point must reach to sit on the body's surface; -Infinity outside it. */
  const surface = (x: number, y: number, margin: number): number => {
    const t = ((x - mh[0]) * ux + (y - mh[1]) * uy) / l2
    const d = ((x - mh[0]) * -uy + (y - mh[1]) * ux) / Math.sqrt(l2)
    const sec = bodySection(t)
    if (!sec) return Number.NEGATIVE_INFINITY
    const [a, b] = sec
    const w = Math.hypot(a * cos, b * sin)
    const depth = Math.hypot(b * cos, a * sin)
    return Math.abs(d) >= w ? Number.NEGATIVE_INFINITY : depth * Math.sqrt(1 - (d / w) ** 2) + margin
  }
  for (const side of ['l', 'r'] as const) {
    const s3 = joints[`${side}_shoulder`]
    const e3 = joints[`${side}_elbow`]
    const w3 = joints[`${side}_wrist`]
    if (!s3 || !e3) continue
    // Upper arm (the shoulder stays put), then the elbow itself.
    const lift = (need: number, have: number): number => Math.max(0, need - front * have)
    e3[2] += front * 2 * lift(surface((s3[0] + e3[0]) / 2, (s3[1] + e3[1]) / 2, 0.08), (s3[2] + e3[2]) / 2)
    e3[2] += front * lift(surface(e3[0], e3[1], 0.09), e3[2])
    if (!w3) continue
    // Forearm (both ends move), then the wrist / hand.
    const k = lift(surface((e3[0] + w3[0]) / 2, (e3[1] + w3[1]) / 2, 0.08), (e3[2] + w3[2]) / 2)
    e3[2] += front * k
    w3[2] += front * k
    w3[2] += front * lift(surface(w3[0], w3[1], 0.1), w3[2])
  }
}
