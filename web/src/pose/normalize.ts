// Pure coordinate transforms between MediaPipe output, the shared body frame and the
// screen. Follows shared/README.md ("Body frame", "From MediaPipe to the body frame",
// "Drawing a body-frame pose") exactly. No DOM, no MediaPipe import: reused by scoring
// and by offline pose extraction from video files.

import { JOINTS, MEDIAPIPE_INDEX, type JointName, type Pose2D, type Vec2 } from '@shared/skeleton'

/** Number of landmarks in MediaPipe's pose model. */
export const MEDIAPIPE_LANDMARK_COUNT = 33

/** Below this mid-shoulder to mid-hip distance (raw video px) a pose is too small to trust. */
export const DEFAULT_MIN_TORSO_PX = 10

/** The subset of MediaPipe's NormalizedLandmark this module needs. */
export interface LandmarkLike {
  /** 0..1 across the raw (unmirrored) video width. */
  x: number
  /** 0..1 down the video height. */
  y: number
  visibility?: number
}

export type PlayerPose = {
  /** Body-frame pose: all 17 joints when `valid`, empty otherwise. */
  pose: Pose2D
  /** MediaPipe visibility per joint (0..1; 0 when unknown). */
  visibility: Record<JointName, number>
  /** Raw video pixel position per joint (unmirrored camera image; [0, 0] when unknown). */
  image: Record<JointName, Vec2>
  /** Mid-shoulder to mid-hip distance in raw video pixels (0 when unknown). */
  torsoPx: number
  /** False when the input can't be normalized (too few landmarks, degenerate torso). */
  valid: boolean
}

export interface NormalizeOptions {
  /** Minimum torso length in raw video pixels; default {@link DEFAULT_MIN_TORSO_PX}. */
  minTorsoPx?: number
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function jointRecord<T>(make: () => T): Record<JointName, T> {
  const out = {} as Record<JointName, T>
  for (const j of JOINTS) out[j] = make()
  return out
}

function invalidPose(
  image?: Record<JointName, Vec2>,
  visibility?: Record<JointName, number>,
  torsoPx = 0,
): PlayerPose {
  return {
    pose: {},
    visibility: visibility ?? jointRecord(() => 0),
    image: image ?? jointRecord<Vec2>(() => [0, 0]),
    torsoPx: isFiniteNumber(torsoPx) ? torsoPx : 0,
    valid: false,
  }
}

/**
 * Converts one person's 33 MediaPipe landmarks to the shared body frame.
 *
 * MediaPipe's x/y are normalized to the raw camera frame, so they are first converted to
 * pixels (both axes in the same unit), then: origin = mid-hip, scale = torso length,
 * +x = dancer's anatomical right (the x sign flips because a front-facing camera sees the
 * dancer's right side at smaller image x), +y = down.
 */
export function landmarksToPlayerPose(
  landmarks: ReadonlyArray<LandmarkLike>,
  videoWidth: number,
  videoHeight: number,
  opts: NormalizeOptions = {},
): PlayerPose {
  const minTorsoPx = opts.minTorsoPx ?? DEFAULT_MIN_TORSO_PX
  if (
    landmarks.length < MEDIAPIPE_LANDMARK_COUNT ||
    !isFiniteNumber(videoWidth) ||
    !isFiniteNumber(videoHeight) ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    return invalidPose()
  }

  const image = {} as Record<JointName, Vec2>
  const visibility = {} as Record<JointName, number>
  let finite = true
  for (const j of JOINTS) {
    const lm: LandmarkLike | undefined = landmarks[MEDIAPIPE_INDEX[j]]
    const vis = lm?.visibility
    visibility[j] = isFiniteNumber(vis) ? Math.min(1, Math.max(0, vis)) : 0
    if (lm && isFiniteNumber(lm.x) && isFiniteNumber(lm.y)) {
      image[j] = [lm.x * videoWidth, lm.y * videoHeight]
    } else {
      image[j] = [0, 0]
      visibility[j] = 0
      finite = false
    }
  }
  if (!finite) return invalidPose(image, visibility)

  const midHipX = (image.l_hip[0] + image.r_hip[0]) / 2
  const midHipY = (image.l_hip[1] + image.r_hip[1]) / 2
  const midShX = (image.l_shoulder[0] + image.r_shoulder[0]) / 2
  const midShY = (image.l_shoulder[1] + image.r_shoulder[1]) / 2
  const torsoPx = Math.hypot(midShX - midHipX, midShY - midHipY)
  if (!(torsoPx > 0 && torsoPx >= minTorsoPx && Number.isFinite(torsoPx))) {
    return invalidPose(image, visibility, torsoPx)
  }

  const pose: Pose2D = {}
  for (const j of JOINTS) {
    const [px, py] = image[j]
    // body.x = -(p.x - midHip.x) / torsoPx, written so equal x gives +0 rather than -0.
    pose[j] = [(midHipX - px) / torsoPx, (py - midHipY) / torsoPx]
  }
  return { pose, visibility, image, torsoPx, valid: true }
}

/** Where and how big to draw a body-frame pose. */
export interface BodyView {
  /** Screen position of the body-frame origin (mid-hip). */
  cx: number
  cy: number
  /** Screen pixels per body unit (torso length). */
  scale: number
  /**
   * true: the figure looks like the player's reflection (coach and webcam self-view; the
   * dancer's right appears on screen right). false: the dancer seen from the front.
   */
  mirrored: boolean
}

/** Body frame -> screen, per shared/README.md "Drawing a body-frame pose". */
export function bodyToScreen(p: Vec2, view: BodyView): Vec2 {
  const dx = p[0] * view.scale
  return [view.mirrored ? view.cx + dx : view.cx - dx, view.cy + p[1] * view.scale]
}

/**
 * Raw video pixel -> position inside the element displaying it, for a <video> styled with
 * `object-fit: contain` (letterboxed/pillarboxed, centered) and optionally mirrored with
 * CSS `transform: scaleX(-1)` (which flips around the element's horizontal center).
 * Display sizes are CSS pixels of the element's box. Returns [0, 0] for empty sizes.
 */
export function imageToDisplay(
  p: Vec2,
  videoWidth: number,
  videoHeight: number,
  displayWidth: number,
  displayHeight: number,
  mirrored: boolean,
): Vec2 {
  if (!(videoWidth > 0 && videoHeight > 0 && displayWidth > 0 && displayHeight > 0)) return [0, 0]
  const scale = Math.min(displayWidth / videoWidth, displayHeight / videoHeight)
  const offsetX = (displayWidth - videoWidth * scale) / 2
  const offsetY = (displayHeight - videoHeight * scale) / 2
  const x = offsetX + p[0] * scale
  return [mirrored ? displayWidth - x : x, offsetY + p[1] * scale]
}
