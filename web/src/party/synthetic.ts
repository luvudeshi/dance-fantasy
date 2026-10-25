// Synthetic MediaPipe output for tests and the #/party-dev harness: body-frame poses placed in a fake
// camera image as 33 landmarks (the exact inverse of pose/normalize landmarksToPlayerPose), and a
// people feed that replays several bot dancers side by side. The fake webcam has nobody in it, so
// this is how party mode is exercised without a room full of dancers.

import { JOINTS, MEDIAPIPE_INDEX, type Pose2D } from '@shared/skeleton'
import { BotPoseSource, type BotSkill } from '../game/botSource'
import { MEDIAPIPE_LANDMARK_COUNT, type LandmarkLike } from '../pose/normalize'
import type { MotionTrack } from '../routine/track'
import { peopleFrame, type PartyFrame, type PeopleFeed } from './multiPose'

export const FAKE_VIDEO = { width: 640, height: 480 } as const

export interface Placement {
  /** Mid-hip in raw (unmirrored) video pixels. */
  hipX: number
  hipY: number
  /** Mid-shoulder to mid-hip, video pixels. */
  torsoPx: number
  visibility?: number
}

/** One person's 33 landmarks (normalized 0..1 to the raw video) for a body-frame pose. */
export function poseToLandmarks(pose: Pose2D, at: Placement, width: number = FAKE_VIDEO.width, height: number = FAKE_VIDEO.height): LandmarkLike[] {
  const vis = at.visibility ?? 0.95
  const out: LandmarkLike[] = Array.from({ length: MEDIAPIPE_LANDMARK_COUNT }, () => ({ x: at.hipX / width, y: at.hipY / height, visibility: 0 }))
  for (const j of JOINTS) {
    const p = pose[j]
    if (!p) continue
    // body.x = (midHip.x - px) / torso  =>  px = midHip.x - body.x * torso (the camera sees the dancer's right at small x)
    out[MEDIAPIPE_INDEX[j]] = { x: (at.hipX - p[0] * at.torsoPx) / width, y: (at.hipY + p[1] * at.torsoPx) / height, visibility: vis }
  }
  return out
}

export interface SyntheticDancer {
  skill: BotSkill
  /** Mid-hip x as a fraction of the SCREEN width (mirrored view: 0 = left of the mirror). */
  screenX: number
  seed?: number
  /** Sways sideways by this many video px (0 = stands still). */
  swayPx?: number
  /** Not in the picture during these song-time spans (s), e.g. stepping out for a drink. */
  away?: ReadonlyArray<readonly [number, number]>
}

/**
 * Several bots dancing the routine side by side, as one camera would see them: frameAt(t) is the
 * PartyFrame a PartyPoseSource would emit at song time t (people in MediaPipe's arbitrary order).
 */
export class SyntheticPeopleFeed implements PeopleFeed {
  readonly video = undefined
  readonly dancers: readonly SyntheticDancer[]
  private readonly bots: BotPoseSource[]
  private readonly listeners = new Set<(f: PartyFrame) => void>()
  private last: PartyFrame | null = null

  constructor(track: MotionTrack, dancers: readonly SyntheticDancer[]) {
    this.dancers = dancers
    this.bots = dancers.map((d, i) => new BotPoseSource({ track, skill: d.skill, seed: d.seed ?? 11 + i * 7 }))
  }

  frameAt(songTime: number): PartyFrame {
    const { width, height } = FAKE_VIDEO
    const landmarks: LandmarkLike[][] = []
    this.dancers.forEach((d, i) => {
      if (d.away?.some(([a, b]) => songTime >= a && songTime < b)) return
      const pose = this.bots[i].frameAt(songTime).pose
      const sway = (d.swayPx ?? 0) * Math.sin(songTime * 1.3 + i)
      // mirrored view: screen x = width - raw x
      const hipX = width - d.screenX * width + sway
      landmarks.push(poseToLandmarks(pose, { hipX, hipY: height * 0.6, torsoPx: height * 0.17 }, width, height))
    })
    // MediaPipe returns people in no particular order: reverse to make sure nothing relies on it.
    landmarks.reverse()
    const captureMs = songTime * 1000
    return peopleFrame(landmarks, width, height, { songTime, rawSongTime: songTime, captureMs, videoWidth: width, videoHeight: height })
  }

  /** Emits the frame at songTime to every listener (the harness calls this from its clock). */
  emit(songTime: number): PartyFrame {
    const f = this.frameAt(songTime)
    this.last = f
    for (const cb of [...this.listeners]) cb(f)
    return f
  }

  onPeople(cb: (f: PartyFrame) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  latestPeople(): PartyFrame | null {
    return this.last
  }
}
