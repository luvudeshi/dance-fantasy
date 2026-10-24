import { describe, expect, it } from 'vitest'
import { JOINTS, MEDIAPIPE_INDEX, type JointName, type Pose2D, type Vec2 } from '@shared/skeleton'
import type { Routine } from '@shared/routine'
import routineExample from '@shared/examples/routine.example.json'
import {
  bodyToScreen,
  imageToDisplay,
  landmarksToPlayerPose,
  MEDIAPIPE_LANDMARK_COUNT,
  type LandmarkLike,
  type PlayerPose,
} from './normalize'

const EPS = 1e-6

type FullPose = Record<JointName, Vec2>

function fullPose(p: Pose2D): FullPose {
  const out = {} as FullPose
  for (const j of JOINTS) {
    const v = p[j]
    if (!v) throw new Error(`fixture pose is missing ${j}`)
    out[j] = v
  }
  return out
}

/** Neutral standing pose straight from the shared example routine (the contract's fixture). */
const NEUTRAL: FullPose = fullPose((routineExample as unknown as Routine).moves[0].keyframes[0].pose)

/** Leaning, right arm raised, left knee up. mid-hip (0,0); mid-shoulder at unit distance. */
const LEAN_ANGLE = 0.25 // rad, toward the dancer's right
const LEAN_MID_SH: Vec2 = [Math.sin(LEAN_ANGLE), -Math.cos(LEAN_ANGLE)]
const LEANING: FullPose = {
  nose: [LEAN_MID_SH[0] + 0.1, -1.42],
  l_eye: [LEAN_MID_SH[0] + 0.03, -1.5],
  r_eye: [LEAN_MID_SH[0] + 0.17, -1.49],
  l_ear: [LEAN_MID_SH[0] - 0.05, -1.46],
  r_ear: [LEAN_MID_SH[0] + 0.24, -1.44],
  l_shoulder: [LEAN_MID_SH[0] - 0.44, LEAN_MID_SH[1] + 0.06],
  r_shoulder: [LEAN_MID_SH[0] + 0.44, LEAN_MID_SH[1] - 0.06],
  l_elbow: [-0.6, -0.45],
  r_elbow: [0.85, -1.55],
  l_wrist: [-0.55, 0.05],
  r_wrist: [0.95, -2.2],
  l_hip: [-0.22, 0.01],
  r_hip: [0.22, -0.01],
  l_knee: [-0.35, 0.55],
  r_knee: [0.25, 0.95],
  l_ankle: [-0.3, 1.1],
  r_ankle: [0.24, 1.86],
}

interface Placement {
  /** Raw video px of the mid-hip. */
  hipX: number
  hipY: number
  /** Torso length in raw video px. */
  torsoPx: number
  videoWidth: number
  videoHeight: number
}

/**
 * Inverse of the README transform: body frame -> fake MediaPipe landmarks in a RAW
 * (unmirrored) camera image, where the dancer's right side is at smaller image x.
 */
function toLandmarks(pose: FullPose, at: Placement, visibility = 0.9): LandmarkLike[] {
  const lms: LandmarkLike[] = Array.from({ length: MEDIAPIPE_LANDMARK_COUNT }, () => ({
    x: 0.5,
    y: 0.5,
    visibility: 0.05,
  }))
  for (const j of JOINTS) {
    const [bx, by] = pose[j]
    const px = at.hipX - bx * at.torsoPx
    const py = at.hipY + by * at.torsoPx
    lms[MEDIAPIPE_INDEX[j]] = { x: px / at.videoWidth, y: py / at.videoHeight, visibility }
  }
  return lms
}

const HD: Placement = { hipX: 703.3, hipY: 431.7, torsoPx: 187.25, videoWidth: 1280, videoHeight: 720 }

function expectPoseClose(actual: Pose2D, expected: FullPose, eps = EPS): void {
  for (const j of JOINTS) {
    const a = actual[j]
    expect(a, j).toBeDefined()
    if (!a) continue
    expect(Math.abs(a[0] - expected[j][0]), `${j}.x`).toBeLessThan(eps)
    expect(Math.abs(a[1] - expected[j][1]), `${j}.y`).toBeLessThan(eps)
  }
}

function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectNumbers(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectNumbers(v, out)
  return out
}

function expectNoNaN(p: PlayerPose): void {
  const nums = collectNumbers(p)
  expect(nums.length).toBeGreaterThan(0)
  for (const n of nums) expect(Number.isFinite(n)).toBe(true)
}

const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

describe('landmarksToPlayerPose', () => {
  it('recovers a body-frame pose from raw-camera landmarks (non-square video)', () => {
    for (const pose of [NEUTRAL, LEANING]) {
      const lms = toLandmarks(pose, HD)
      const out = landmarksToPlayerPose(lms, HD.videoWidth, HD.videoHeight)
      expect(out.valid).toBe(true)
      expect(Math.abs(out.torsoPx - HD.torsoPx)).toBeLessThan(EPS)
      expectPoseClose(out.pose, pose)
      expectNoNaN(out)
    }
  })

  it('follows the README conventions: +x = dancer right, mid-shoulder (0,-1), mid-hip origin', () => {
    const lms = toLandmarks(NEUTRAL, HD)
    // Sanity-check the fixture: in the raw camera image the dancer's right is image-left.
    expect(lms[MEDIAPIPE_INDEX.r_shoulder].x).toBeLessThan(lms[MEDIAPIPE_INDEX.l_shoulder].x)

    const out = landmarksToPlayerPose(lms, HD.videoWidth, HD.videoHeight)
    const p = fullPose(out.pose)
    expect(p.r_shoulder[0]).toBeGreaterThan(0)
    expect(p.l_shoulder[0]).toBeLessThan(0)
    const midSh = mid(p.l_shoulder, p.r_shoulder)
    const midHip = mid(p.l_hip, p.r_hip)
    expect(midSh[0]).toBeCloseTo(0, 9)
    expect(midSh[1]).toBeCloseTo(-1, 9)
    expect(midHip[0]).toBeCloseTo(0, 9)
    expect(midHip[1]).toBeCloseTo(0, 9)
    // Head up (negative y), feet down (positive y).
    expect(p.nose[1]).toBeLessThan(-1)
    expect(p.l_ankle[1]).toBeGreaterThan(1)
  })

  it('matches a hand-computed raw camera frame (independent of the inverse helper)', () => {
    // 1280x720 raw selfie-camera frame; the dancer faces the camera with the RIGHT hand
    // raised. Their right side is at smaller x in the raw image.
    const lms: LandmarkLike[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.9 }))
    lms[12] = { x: 0.45, y: 0.3, visibility: 0.99 } // r_shoulder -> (576, 216) px
    lms[11] = { x: 0.55, y: 0.3, visibility: 0.99 } // l_shoulder -> (704, 216) px
    lms[24] = { x: 0.47, y: 0.55, visibility: 0.98 } // r_hip -> (601.6, 396) px
    lms[23] = { x: 0.53, y: 0.55, visibility: 0.98 } // l_hip -> (678.4, 396) px
    lms[16] = { x: 0.4, y: 0.1, visibility: 0.97 } // r_wrist -> (512, 72) px
    lms[15] = { x: 0.6, y: 0.62, visibility: 0.97 } // l_wrist -> (768, 446.4) px
    const out = landmarksToPlayerPose(lms, 1280, 720)
    expect(out.valid).toBe(true)
    expect(out.torsoPx).toBeCloseTo(180, 9) // mid-shoulder (640,216) to mid-hip (640,396)
    const p = fullPose(out.pose)
    expect(p.r_shoulder[0]).toBeCloseTo(64 / 180, 9)
    expect(p.r_shoulder[1]).toBeCloseTo(-1, 9)
    expect(p.r_wrist[0]).toBeCloseTo(128 / 180, 9)
    expect(p.r_wrist[1]).toBeCloseTo(-324 / 180, 9)
    // The PoseSpike hint: "Raise your RIGHT hand: r_wrist.x > 0 and y < -1".
    expect(p.r_wrist[0] > 0 && p.r_wrist[1] < -1).toBe(true)
    expect(p.l_wrist[0]).toBeCloseTo(-128 / 180, 9)
    expect(out.image.r_wrist[0]).toBeCloseTo(512, 9)
    expect(out.image.r_wrist[1]).toBeCloseTo(72, 9)
    expect(out.visibility.r_wrist).toBeCloseTo(0.97, 9)
  })

  it('works in pixels, so non-square video does not distort angles', () => {
    // r_wrist 100 px right and 100 px up from r_elbow in the raw image: a 45 degree segment.
    const lms: LandmarkLike[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }))
    lms[11] = { x: 700 / 1280, y: 200 / 720 }
    lms[12] = { x: 580 / 1280, y: 200 / 720 }
    lms[23] = { x: 680 / 1280, y: 400 / 720 }
    lms[24] = { x: 600 / 1280, y: 400 / 720 }
    lms[14] = { x: 500 / 1280, y: 300 / 720 }
    lms[16] = { x: 600 / 1280, y: 200 / 720 }
    const p = fullPose(landmarksToPlayerPose(lms, 1280, 720).pose)
    const dx = p.r_wrist[0] - p.r_elbow[0]
    const dy = p.r_wrist[1] - p.r_elbow[1]
    expect(Math.abs(dx)).toBeCloseTo(Math.abs(dy), 9)
    expect(dx).toBeCloseTo(-0.5, 9) // image-right = toward the dancer's LEFT
    expect(dy).toBeCloseTo(-0.5, 9)
  })

  it('is invariant to where the dancer stands, how big they appear and the video size', () => {
    const placements: Placement[] = [
      HD,
      { hipX: 120.5, hipY: 400, torsoPx: 42.5, videoWidth: 640, videoHeight: 480 },
      { hipX: 1500, hipY: 300, torsoPx: 512, videoWidth: 1920, videoHeight: 1080 },
      { hipX: 360, hipY: 900, torsoPx: 260, videoWidth: 720, videoHeight: 1280 }, // portrait
    ]
    const results = placements.map((at) =>
      landmarksToPlayerPose(toLandmarks(LEANING, at), at.videoWidth, at.videoHeight),
    )
    for (const r of results) {
      expect(r.valid).toBe(true)
      expectPoseClose(r.pose, LEANING)
    }
    expectPoseClose(results[1].pose, fullPose(results[2].pose))
  })

  it('returns valid=false and no NaN for unusable input', () => {
    const good = toLandmarks(NEUTRAL, HD)
    const collapsed = good.map(() => ({ x: 0.5, y: 0.5, visibility: 0.9 })) // zero torso
    const nanHip = good.map((lm, i) => (i === MEDIAPIPE_INDEX.l_hip ? { ...lm, x: Number.NaN } : lm))
    const cases: Array<[string, PlayerPose]> = [
      ['empty', landmarksToPlayerPose([], 1280, 720)],
      ['32 landmarks', landmarksToPlayerPose(good.slice(0, 32), 1280, 720)],
      ['zero torso', landmarksToPlayerPose(collapsed, 1280, 720)],
      ['zero torso, minTorsoPx 0', landmarksToPlayerPose(collapsed, 1280, 720, { minTorsoPx: 0 })],
      ['NaN landmark', landmarksToPlayerPose(nanHip, 1280, 720)],
      ['zero video size', landmarksToPlayerPose(good, 0, 0)],
      ['NaN video size', landmarksToPlayerPose(good, Number.NaN, 720)],
    ]
    for (const [name, out] of cases) {
      expect(out.valid, name).toBe(false)
      expect(out.pose, name).toEqual({})
      expect(Object.keys(out.image), name).toEqual([...JOINTS])
      expect(Object.keys(out.visibility), name).toEqual([...JOINTS])
      expectNoNaN(out)
    }
  })

  it('rejects poses whose torso is smaller than minTorsoPx but keeps image coords', () => {
    const tiny = toLandmarks(NEUTRAL, { ...HD, torsoPx: 8 })
    const out = landmarksToPlayerPose(tiny, HD.videoWidth, HD.videoHeight)
    expect(out.valid).toBe(false)
    expect(out.torsoPx).toBeCloseTo(8, 6)
    expect(out.image.nose[0]).toBeGreaterThan(0)
    expect(landmarksToPlayerPose(tiny, HD.videoWidth, HD.videoHeight, { minTorsoPx: 5 }).valid).toBe(true)
  })

  it('defaults missing visibility to 0 and clamps it to [0, 1]', () => {
    const lms: LandmarkLike[] = toLandmarks(NEUTRAL, HD).map(({ x, y }) => ({ x, y }))
    lms[MEDIAPIPE_INDEX.nose] = { ...lms[MEDIAPIPE_INDEX.nose], visibility: 1.7 }
    const out = landmarksToPlayerPose(lms, HD.videoWidth, HD.videoHeight)
    expect(out.valid).toBe(true)
    expect(out.visibility.r_wrist).toBe(0)
    expect(out.visibility.nose).toBe(1)
  })
})

describe('bodyToScreen', () => {
  const rWrist: Vec2 = [0.9, -2.1]
  const view = { cx: 200, cy: 300, scale: 100 }

  it('mirrored view puts the dancer right on screen right; true view on screen left', () => {
    const m = bodyToScreen(rWrist, { ...view, mirrored: true })
    const t = bodyToScreen(rWrist, { ...view, mirrored: false })
    expect(m).toEqual([290, 90])
    expect(t).toEqual([110, 90])
    expect(m[0] - view.cx).toBeGreaterThan(0)
    expect(t[0] - view.cx).toBeLessThan(0)
    expect(m[1]).toBe(t[1])
  })

  it('maps the origin to (cx, cy) and +y downward', () => {
    expect(bodyToScreen([0, 0], { ...view, mirrored: true })).toEqual([200, 300])
    expect(bodyToScreen([0, 1], { ...view, mirrored: false })[1]).toBe(400)
  })
})

describe('imageToDisplay', () => {
  it('letterboxes a 16:9 video in a square box', () => {
    // scale = min(800/1280, 800/720) = 0.625 -> 800x450 picture, 175 px bars top and bottom.
    expect(imageToDisplay([0, 0], 1280, 720, 800, 800, false)).toEqual([0, 175])
    expect(imageToDisplay([1280, 720], 1280, 720, 800, 800, false)).toEqual([800, 625])
    expect(imageToDisplay([640, 360], 1280, 720, 800, 800, false)).toEqual([400, 400])
  })

  it('pillarboxes a 4:3 video in a wide box', () => {
    // scale = min(1000/640, 480/480) = 1 -> 640x480 picture, 180 px bars left and right.
    expect(imageToDisplay([0, 0], 640, 480, 1000, 480, false)).toEqual([180, 0])
    expect(imageToDisplay([640, 480], 640, 480, 1000, 480, false)).toEqual([820, 480])
  })

  it('mirrors around the element center like CSS scaleX(-1)', () => {
    expect(imageToDisplay([0, 0], 640, 480, 1000, 480, true)).toEqual([820, 0])
    expect(imageToDisplay([640, 480], 640, 480, 1000, 480, true)).toEqual([180, 480])
    expect(imageToDisplay([100, 50], 1280, 720, 800, 800, true)).toEqual([800 - 62.5, 175 + 31.25])
  })

  it('returns [0, 0] for empty sizes instead of NaN/Infinity', () => {
    expect(imageToDisplay([10, 10], 0, 0, 800, 600, false)).toEqual([0, 0])
    expect(imageToDisplay([10, 10], 640, 480, 0, 0, true)).toEqual([0, 0])
  })
})

describe('mirrored self-view and mirrored body view agree', () => {
  it('shows the dancer right wrist on the right side of the screen in both panels', () => {
    const lms = toLandmarks(LEANING, HD)
    const out = landmarksToPlayerPose(lms, HD.videoWidth, HD.videoHeight)
    const display = { w: 960, h: 540 }
    const wristOnVideo = imageToDisplay(out.image.r_wrist, HD.videoWidth, HD.videoHeight, display.w, display.h, true)
    const hipOnVideo = imageToDisplay(mid(out.image.l_hip, out.image.r_hip), HD.videoWidth, HD.videoHeight, display.w, display.h, true)
    const wristBody = bodyToScreen(fullPose(out.pose).r_wrist, { cx: 0, cy: 0, scale: 50, mirrored: true })
    expect(wristOnVideo[0]).toBeGreaterThan(hipOnVideo[0])
    expect(wristBody[0]).toBeGreaterThan(0)
  })
})
