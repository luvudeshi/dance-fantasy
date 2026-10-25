// Several people in front of one camera: the regular WebcamPoseSource (camera, frame timing, GPU->CPU
// fallback, song-clock mapping) with its PoseLandmarker switched to numPoses = N. Every detection
// result is tapped before the single-player path picks landmarks[0], and each person is normalized
// to the body frame exactly like the single-player path (pose/normalize landmarksToPlayerPose).
// Still a WebcamPoseSource, so calibration and the PIP keep working on person 0.

import { abortReason } from '../lib/errors'
import type { Delegate, PoseModel } from '../pose/mediapipeAssets'
import { createPoseLandmarker } from '../pose/mediapipe'
import { landmarksToPlayerPose, type LandmarkLike } from '../pose/normalize'
import type { PlayerFrame } from '../game/poseSource'
import { WebcamPoseSource, type LandmarkerHandleLike, type WebcamPoseSourceOptions } from '../game/webcamSource'
import { MAX_PARTY } from './players'

/** Everyone the camera saw in one video frame. */
export interface PartyFrame {
  songTime: number
  captureMs: number
  videoWidth: number
  videoHeight: number
  /** One PlayerFrame per detected person (valid ones only), in MediaPipe's (arbitrary) order. */
  people: PlayerFrame[]
}

/** Where party mode gets its people from: the camera (PartyPoseSource) or the harness (SyntheticPeopleFeed). */
export interface PeopleFeed {
  readonly video?: HTMLVideoElement
  onPeople(cb: (frame: PartyFrame) => void): () => void
  latestPeople(): PartyFrame | null
}

type FrameBase = Pick<PlayerFrame, 'songTime' | 'rawSongTime' | 'captureMs' | 'videoWidth' | 'videoHeight'>

/** All people of one detection result as body-frame PlayerFrames sharing `base`'s timing (invalid ones dropped). */
export function peopleFrame(landmarks: readonly (readonly LandmarkLike[])[], width: number, height: number, base: FrameBase): PartyFrame {
  const people: PlayerFrame[] = []
  for (const lms of landmarks) {
    const p = landmarksToPlayerPose(lms, width, height)
    if (p.valid) people.push({ ...base, pose: p.pose, visibility: p.visibility, valid: true, image: p.image })
  }
  return { songTime: base.songTime, captureMs: base.captureMs ?? 0, videoWidth: width, videoHeight: height, people }
}

interface Tapped {
  landmarks: LandmarkLike[][]
  width: number
  height: number
}

/** createPoseLandmarker with numPoses = maxPeople, whose detections are also handed to `tap`. */
function multiPersonLandmarker(maxPeople: number, tap: (t: Tapped) => void) {
  return async (opts: { model?: PoseModel; delegate?: Delegate; signal?: AbortSignal }): Promise<LandmarkerHandleLike> => {
    const h = await createPoseLandmarker(opts)
    try {
      await h.landmarker.setOptions({ numPoses: maxPeople })
    } catch (err) {
      h.landmarker.close()
      throw err
    }
    if (opts.signal?.aborted) {
      h.landmarker.close()
      throw abortReason(opts.signal)
    }
    return {
      delegate: h.delegate,
      landmarker: {
        detectForVideo(video: HTMLVideoElement, ts: number) {
          const result = h.landmarker.detectForVideo(video, ts)
          tap({ landmarks: result.landmarks, width: video.videoWidth, height: video.videoHeight })
          return result
        },
        close: () => h.landmarker.close(),
      },
    }
  }
}

export interface PartyPoseSourceOptions extends Omit<WebcamPoseSourceOptions, 'deps'> {
  /** Most people tracked at once (MediaPipe numPoses), 1..MAX_PARTY. */
  maxPeople: number
}

export class PartyPoseSource extends WebcamPoseSource implements PeopleFeed {
  readonly maxPeople: number
  private readonly peopleListeners = new Set<(f: PartyFrame) => void>()
  private lastPeople: PartyFrame | null = null
  private tapped: Tapped | null = null

  constructor(opts: PartyPoseSourceOptions) {
    const maxPeople = Math.min(MAX_PARTY, Math.max(1, Math.round(opts.maxPeople)))
    const box: { self: PartyPoseSource | null } = { self: null }
    const tap = (t: Tapped): void => {
      if (box.self) box.self.tapped = t
    }
    super({ ...opts, deps: { createPoseLandmarker: multiPersonLandmarker(maxPeople, tap) } })
    box.self = this
    this.maxPeople = maxPeople
    // Registered first, so the party frame is ready before anyone else hears about this video frame.
    this.onFrame((f) => this.onSinglePlayerFrame(f))
  }

  onPeople(cb: (f: PartyFrame) => void): () => void {
    this.peopleListeners.add(cb)
    return () => {
      this.peopleListeners.delete(cb)
    }
  }

  latestPeople(): PartyFrame | null {
    return this.lastPeople
  }

  /** The single-player frame arrives synchronously right after detectForVideo: the tap holds the same result. */
  private onSinglePlayerFrame(f: PlayerFrame): void {
    const t = this.tapped
    this.tapped = null
    if (!t) return
    const { songTime, rawSongTime, captureMs, videoWidth, videoHeight } = f
    const frame = peopleFrame(t.landmarks, t.width, t.height, { songTime, rawSongTime, captureMs, videoWidth, videoHeight })
    this.lastPeople = frame
    for (const cb of this.peopleListeners) {
      try {
        cb(frame)
      } catch (err) {
        console.error('[party] people listener failed', err)
      }
    }
  }
}
