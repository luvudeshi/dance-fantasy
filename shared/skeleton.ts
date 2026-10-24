// Skeleton definition shared by the web app. Mirrors shared/skeleton.json
// (a test in web/src/pose/skeleton.test.ts keeps them identical).

export const JOINTS = [
  'nose',
  'l_eye',
  'r_eye',
  'l_ear',
  'r_ear',
  'l_shoulder',
  'r_shoulder',
  'l_elbow',
  'r_elbow',
  'l_wrist',
  'r_wrist',
  'l_hip',
  'r_hip',
  'l_knee',
  'r_knee',
  'l_ankle',
  'r_ankle',
] as const

export type JointName = (typeof JOINTS)[number]

/** [x, y] in the normalized body frame (see shared/README.md). */
export type Vec2 = [number, number]

/** Joint name -> position. Partial: a pose may omit joints. */
export type Pose2D = Partial<Record<JointName, Vec2>>

/** Index of each joint in MediaPipe's 33-landmark pose model. */
export const MEDIAPIPE_INDEX: Readonly<Record<JointName, number>> = {
  nose: 0,
  l_eye: 2,
  r_eye: 5,
  l_ear: 7,
  r_ear: 8,
  l_shoulder: 11,
  r_shoulder: 12,
  l_elbow: 13,
  r_elbow: 14,
  l_wrist: 15,
  r_wrist: 16,
  l_hip: 23,
  r_hip: 24,
  l_knee: 25,
  r_knee: 26,
  l_ankle: 27,
  r_ankle: 28,
}

/** Left/right counterpart of each joint (nose maps to itself). */
export const MIRROR: Readonly<Record<JointName, JointName>> = {
  nose: 'nose',
  l_eye: 'r_eye',
  r_eye: 'l_eye',
  l_ear: 'r_ear',
  r_ear: 'l_ear',
  l_shoulder: 'r_shoulder',
  r_shoulder: 'l_shoulder',
  l_elbow: 'r_elbow',
  r_elbow: 'l_elbow',
  l_wrist: 'r_wrist',
  r_wrist: 'l_wrist',
  l_hip: 'r_hip',
  r_hip: 'l_hip',
  l_knee: 'r_knee',
  r_knee: 'l_knee',
  l_ankle: 'r_ankle',
  r_ankle: 'l_ankle',
}

/** Segments to draw for a stick figure. */
export const BONES: ReadonlyArray<readonly [JointName, JointName]> = [
  ['l_shoulder', 'r_shoulder'],
  ['l_hip', 'r_hip'],
  ['l_shoulder', 'l_hip'],
  ['r_shoulder', 'r_hip'],
  ['l_shoulder', 'l_elbow'],
  ['l_elbow', 'l_wrist'],
  ['r_shoulder', 'r_elbow'],
  ['r_elbow', 'r_wrist'],
  ['l_hip', 'l_knee'],
  ['l_knee', 'l_ankle'],
  ['r_hip', 'r_knee'],
  ['r_knee', 'r_ankle'],
  ['nose', 'l_eye'],
  ['nose', 'r_eye'],
  ['l_eye', 'l_ear'],
  ['r_eye', 'r_ear'],
]

/** Virtual points derived from joint pairs (used by the torso limb). */
export type VirtualPoint = 'mid_hip' | 'mid_shoulder'
export type LimbEnd = JointName | VirtualPoint

/** Limbs whose direction vectors are scored. A limb is scored when its distal (second) joint is in a move's scoredJoints. */
export const LIMBS = {
  l_upper_arm: ['l_shoulder', 'l_elbow'],
  l_forearm: ['l_elbow', 'l_wrist'],
  r_upper_arm: ['r_shoulder', 'r_elbow'],
  r_forearm: ['r_elbow', 'r_wrist'],
  l_thigh: ['l_hip', 'l_knee'],
  l_shin: ['l_knee', 'l_ankle'],
  r_thigh: ['r_hip', 'r_knee'],
  r_shin: ['r_knee', 'r_ankle'],
  torso: ['mid_hip', 'mid_shoulder'],
} as const satisfies Record<string, readonly [LimbEnd, LimbEnd]>

export type LimbName = keyof typeof LIMBS

/** Joints ignored in seated mode. */
export const LEG_JOINTS: ReadonlyArray<JointName> = ['l_hip', 'r_hip', 'l_knee', 'r_knee', 'l_ankle', 'r_ankle']
