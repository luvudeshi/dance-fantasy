import { describe, expect, it } from 'vitest'
import { JOINTS, type JointName, type Pose2D } from '@shared/skeleton'
import { NEUTRAL_POSE } from '../routine/pose'
import { BONE_LENGTH, bodySection, estimateYaw, liftPose, type Vec3 } from './lift'

/** The neutral pose in 3D (face depths as in server/app/moves/fk.py). */
function neutral3(): Record<JointName, Vec3> {
  const face: Partial<Record<JointName, number>> = { nose: 0.15, l_eye: 0.1, r_eye: 0.1, l_ear: -0.02, r_ear: -0.02 }
  const out = {} as Record<JointName, Vec3>
  for (const j of JOINTS) out[j] = [NEUTRAL_POSE[j][0], NEUTRAL_POSE[j][1], face[j] ?? 0]
  return out
}

/** Turns about the vertical axis through mid-hip (FK convention: + brings the front toward +x) and projects. */
function project(p3: Record<JointName, Vec3>, yawDeg = 0): { pose: Pose2D; z: Record<JointName, number> } {
  const a = (yawDeg * Math.PI) / 180
  const pose: Pose2D = {}
  const z = {} as Record<JointName, number>
  for (const j of JOINTS) {
    const [x, y, d] = p3[j]
    pose[j] = [x * Math.cos(a) + d * Math.sin(a), y]
    z[j] = -x * Math.sin(a) + d * Math.cos(a)
  }
  return { pose, z }
}

/** Pitches a leg forward: thigh by `thigh` deg, shin by `shin` deg (from straight down). */
function leg(p3: Record<JointName, Vec3>, side: 'l' | 'r', thigh: number, shin: number): void {
  const hip = p3[`${side}_hip`]
  const t = (thigh * Math.PI) / 180
  const s = (shin * Math.PI) / 180
  const knee: Vec3 = [hip[0], hip[1] + BONE_LENGTH.thigh * Math.cos(t), hip[2] + BONE_LENGTH.thigh * Math.sin(t)]
  p3[`${side}_knee`] = knee
  p3[`${side}_ankle`] = [knee[0], knee[1] + BONE_LENGTH.shin * Math.cos(s), knee[2] + BONE_LENGTH.shin * Math.sin(s)]
}

const deg = (r: number): number => (r * 180) / Math.PI

describe('estimateYaw', () => {
  it('reads the body turn from shoulder/hip width and the nose', () => {
    expect(estimateYaw(NEUTRAL_POSE)).toBeCloseTo(0, 6)
    for (const turn of [25, 50, -40, 150, -120]) {
      expect(deg(estimateYaw(project(neutral3(), turn).pose))).toBeCloseTo(turn, 0)
    }
  })

  it('ignores a torso lean and survives missing joints', () => {
    const leaned: Pose2D = { ...NEUTRAL_POSE }
    const a = (30 * Math.PI) / 180
    for (const j of ['nose', 'l_eye', 'r_eye', 'l_ear', 'r_ear', 'l_shoulder', 'r_shoulder'] as const) {
      const [x, y] = NEUTRAL_POSE[j]
      leaned[j] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]
    }
    expect(Math.abs(deg(estimateYaw(leaned)))).toBeLessThan(1)
    expect(estimateYaw({})).toBe(0)
    expect(estimateYaw({ l_hip: [-0.22, 0], r_hip: [0.22, 0] })).toBeCloseTo(0, 6)
  })
})

describe('liftPose', () => {
  it('keeps a neutral pose flat and drops missing joints', () => {
    const { joints, yaw } = liftPose(NEUTRAL_POSE)
    expect(yaw).toBeCloseTo(0, 6)
    for (const j of JOINTS) expect(joints[j]?.[2]).toBeCloseTo(0, 6)
    const upper = liftPose({ l_shoulder: [-0.45, -1], r_shoulder: [0.45, -1], l_elbow: [-0.5, -0.5] }).joints
    expect(upper.l_elbow).toBeDefined()
    expect(upper.l_knee).toBeUndefined()
  })

  it('brings a raised knee forward and keeps the shin hanging under it', () => {
    const p3 = neutral3()
    leg(p3, 'r', 80, 0) // knee up, shin straight down
    const { joints } = liftPose(project(p3).pose)
    expect(joints.r_knee?.[2]).toBeCloseTo(p3.r_knee[2], 3)
    expect(joints.r_ankle?.[2]).toBeCloseTo(p3.r_ankle[2], 3)
    expect(joints.l_knee?.[2]).toBeCloseTo(0, 6)
  })

  it('puts a squatting foot back under the hip and lets a kicking foot continue forward', () => {
    const squat = neutral3()
    leg(squat, 'l', 50, -40)
    leg(squat, 'r', 50, -40)
    const s = liftPose(project(squat).pose).joints
    expect(s.l_knee?.[2]).toBeGreaterThan(0.6)
    expect(s.l_ankle?.[2]).toBeCloseTo(squat.l_ankle[2], 3) // behind the knee, near the hip line
    const kick = neutral3()
    leg(kick, 'r', 60, 60)
    const k = liftPose(project(kick).pose).joints
    expect(k.r_ankle?.[2]).toBeCloseTo(kick.r_ankle[2], 3)
    expect(k.r_ankle?.[2]).toBeGreaterThan(k.r_knee?.[2] ?? 0)
  })

  it('swings a turned body: the leading side goes back, arms stay in the turned plane', () => {
    const p3 = neutral3()
    // Arms straight out to the sides.
    p3.l_elbow = [-0.45 - BONE_LENGTH.upperArm, -1, 0]
    p3.r_elbow = [0.45 + BONE_LENGTH.upperArm, -1, 0]
    p3.l_wrist = [-0.45 - BONE_LENGTH.upperArm - BONE_LENGTH.forearm, -1, 0]
    p3.r_wrist = [0.45 + BONE_LENGTH.upperArm + BONE_LENGTH.forearm, -1, 0]
    const { pose, z } = project(p3, 50)
    const { joints, yaw } = liftPose(pose)
    expect(deg(yaw)).toBeCloseTo(50, 0)
    for (const j of ['l_shoulder', 'r_shoulder', 'l_elbow', 'r_elbow', 'l_wrist', 'r_wrist', 'l_hip', 'r_hip'] as const) {
      expect(joints[j]?.[2]).toBeCloseTo(z[j], 1)
    }
    expect(joints.r_wrist?.[2]).toBeLessThan(-0.5)
    expect(joints.l_wrist?.[2]).toBeGreaterThan(0.5)
  })

  it('brings an arm crossing the body out in front of the bodice and skirt', () => {
    // Hand on the belly, other hand on the hip (planar FK arms would pass through the torso).
    const pose: Pose2D = { ...NEUTRAL_POSE, l_elbow: [-0.62, -0.45], l_wrist: [-0.05, -0.35], r_elbow: [0.66, -0.3], r_wrist: [0.32, -0.02] }
    const { joints } = liftPose(pose)
    const belly = bodySection(0.35)
    expect(belly).not.toBeNull()
    expect(joints.l_wrist?.[2]).toBeGreaterThan(belly?.[1] ?? 1)
    expect(joints.r_wrist?.[2]).toBeGreaterThan(0.1)
    // Seen from behind, the same arms go behind the back (away from the viewer).
    const back = liftPose(project(Object.fromEntries(JOINTS.map((j) => [j, [...(pose[j] ?? [0, 0]), 0]])) as Record<JointName, Vec3>, 180).pose)
    expect(back.joints.l_wrist?.[2]).toBeLessThan(-0.1)
    // Arms out to the sides are left alone.
    expect(liftPose(NEUTRAL_POSE).joints.l_wrist?.[2]).toBeCloseTo(0, 6)
    expect(bodySection(1.2)).toBeNull()
  })
})
