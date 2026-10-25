// A bot "player" that dances the routine's motion track with human-like error: tests, demos and
// the no-camera fallback. Pull model: the game calls tick(songTime) every animation frame and
// the bot emits every frame on its fps grid since the previous tick, so the output depends only
// on the song times (deterministic, and throttled rAF just backfills). Noise is a smooth,
// seeded function of time per limb, so a frame's pose never depends on how ticks were spaced.

import { JOINTS, type JointName, type LimbName, type Pose2D, type Vec2 } from '@shared/skeleton'
import { mirrorPose, NEUTRAL_POSE } from '../routine/pose'
import type { MotionTrack } from '../routine/track'
import type { PlayerFrame, PoseSource } from './poseSource'

/**
 * perfect: the routine, near-exact. good / sloppy: the routine with ~12° / ~30° error per limb.
 * idle: stands in the resting pose, swaying a little. mirrored: dances the routine on the wrong
 * side (left for right, the classic copy-the-screen mistake).
 */
export type BotSkill = 'perfect' | 'good' | 'sloppy' | 'idle' | 'mirrored'

/** Default per-limb direction error (degrees, RMS) of each skill. */
export const BOT_NOISE_DEG: Readonly<Record<BotSkill, number>> = { perfect: 2, good: 12, sloppy: 30, idle: 4, mirrored: 10 }

/** The noise for each limb drifts between fresh random values this often (s). */
export const BOT_NOISE_PERIOD_SEC = 0.4
/** Most frames one tick backfills (s); a longer stall skips ahead. */
export const BOT_MAX_BACKFILL_SEC = 2

export interface BotOptions {
  track: MotionTrack
  skill: BotSkill
  /** Frames per second on the song-time grid. Default 30. */
  fps?: number
  /** The bot dances this late (s). Default 0. */
  lagSec?: number
  /** Per-limb direction error (degrees, RMS). Default BOT_NOISE_DEG[skill]. */
  noiseDeg?: number
  seed?: number
}

const NOISY_LIMBS: readonly LimbName[] = ['torso', 'l_upper_arm', 'l_forearm', 'r_upper_arm', 'r_forearm', 'l_thigh', 'l_shin', 'r_thigh', 'r_shin']
const UPPER_BODY_RIGID: readonly JointName[] = ['l_shoulder', 'r_shoulder', 'nose', 'l_eye', 'r_eye', 'l_ear', 'r_ear']
/** [limb index in NOISY_LIMBS, proximal joint, distal joint], proximal limbs first. */
const CHAINS: ReadonlyArray<readonly [number, JointName, JointName]> = [
  [1, 'l_shoulder', 'l_elbow'],
  [2, 'l_elbow', 'l_wrist'],
  [3, 'r_shoulder', 'r_elbow'],
  [4, 'r_elbow', 'r_wrist'],
  [5, 'l_hip', 'l_knee'],
  [6, 'l_knee', 'l_ankle'],
  [7, 'r_hip', 'r_knee'],
  [8, 'r_knee', 'r_ankle'],
]

// --- seeded noise --------------------------------------------------------------------------

function hash32(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c ^ 0x165667b1, 0x27d4eb2f)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Standard normal from (seed, stream, k) via Box-Muller. */
function gaussian(seed: number, stream: number, k: number): number {
  const u1 = (hash32(seed, stream * 2, k) + 1) / 4294967297
  const u2 = hash32(seed, stream * 2 + 1, k) / 4294967296
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** Smooth noise with unit variance at every t: smoothstep blend of per-period normals. */
export function smoothNoise(seed: number, stream: number, t: number, periodSec = BOT_NOISE_PERIOD_SEC): number {
  const x = t / periodSec
  const k = Math.floor(x)
  const f = x - k
  const s = f * f * (3 - 2 * f)
  const a = gaussian(seed, stream, k)
  const b = gaussian(seed, stream, k + 1)
  return ((1 - s) * a + s * b) / Math.sqrt((1 - s) * (1 - s) + s * s)
}

// --- pose perturbation ---------------------------------------------------------------------

const rotate = (v: Vec2, a: number): Vec2 => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]
}

/**
 * Turns each limb's direction by its own angle (radians, NOISY_LIMBS order) while keeping
 * lengths: torso = upper body about mid-hip; every other limb rotates its distal joint about
 * its (already moved) proximal joint, so a limb's error is exactly its own angle.
 */
export function perturbPose(pose: Pose2D, angles: readonly number[]): Pose2D {
  const src = {} as Record<JointName, Vec2>
  for (const j of JOINTS) src[j] = pose[j] ?? NEUTRAL_POSE[j]
  const out = { ...src }
  const mh: Vec2 = [(src.l_hip[0] + src.r_hip[0]) / 2, (src.l_hip[1] + src.r_hip[1]) / 2]
  const ta = angles[0] ?? 0
  for (const j of UPPER_BODY_RIGID) {
    const r = rotate([src[j][0] - mh[0], src[j][1] - mh[1]], ta)
    out[j] = [mh[0] + r[0], mh[1] + r[1]]
  }
  for (const [li, prox, dist] of CHAINS) {
    const r = rotate([src[dist][0] - src[prox][0], src[dist][1] - src[prox][1]], angles[li] ?? 0)
    out[dist] = [out[prox][0] + r[0], out[prox][1] + r[1]]
  }
  const res: Pose2D = {}
  for (const j of JOINTS) if (pose[j]) res[j] = out[j]
  return res
}

const FULL_VISIBILITY: Readonly<Record<JointName, number>> = Object.fromEntries(JOINTS.map((j) => [j, 1])) as Record<JointName, number>

// --- source --------------------------------------------------------------------------------

export class BotPoseSource implements PoseSource {
  readonly kind = 'bot' as const
  readonly skill: BotSkill
  readonly fps: number
  readonly lagSec: number
  readonly noiseDeg: number
  readonly seed: number

  private readonly track: MotionTrack
  private readonly listeners = new Set<(frame: PlayerFrame) => void>()
  private running = false
  private lastIndex: number | null = null
  private last: PlayerFrame | null = null

  constructor(opts: BotOptions) {
    this.track = opts.track
    this.skill = opts.skill
    this.fps = opts.fps !== undefined && opts.fps > 0 ? opts.fps : 30
    this.lagSec = opts.lagSec ?? 0
    this.noiseDeg = opts.noiseDeg ?? BOT_NOISE_DEG[opts.skill]
    this.seed = (opts.seed ?? 1) | 0
  }

  start(): Promise<void> {
    this.running = true
    return Promise.resolve()
  }

  stop(): void {
    this.running = false
    this.lastIndex = null
  }

  get started(): boolean {
    return this.running
  }

  onFrame(cb: (frame: PlayerFrame) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  latest(): PlayerFrame | null {
    return this.last
  }

  /** The bot's frame at song time t (pure: same t, same frame). */
  frameAt(songTime: number): PlayerFrame {
    const base: Pose2D = this.skill === 'idle' ? NEUTRAL_POSE : this.track.sample(songTime - this.lagSec).pose
    const target = this.skill === 'mirrored' ? mirrorPose(base) : base
    const amp = (this.noiseDeg * Math.PI) / 180
    const angles = NOISY_LIMBS.map((_, i) => (amp > 0 ? amp * smoothNoise(this.seed, i, songTime) : 0))
    return { songTime, pose: perturbPose(target, angles), visibility: { ...FULL_VISIBILITY }, valid: true }
  }

  /**
   * Emits (in order) every frame on the 1/fps grid after the previous tick, up to songTime
   * (at most BOT_MAX_BACKFILL_SEC worth; the first tick emits one frame). Time going backwards
   * (a restart) starts over. Does nothing until start(). Returns the frames emitted.
   */
  tick(songTime: number): PlayerFrame[] {
    if (!this.running || !Number.isFinite(songTime)) return []
    const end = Math.floor(songTime * this.fps + 1e-6)
    if (this.lastIndex !== null && end < this.lastIndex) this.lastIndex = null
    let first = this.lastIndex === null ? end : this.lastIndex + 1
    first = Math.max(first, end - Math.round(BOT_MAX_BACKFILL_SEC * this.fps) + 1)
    const frames: PlayerFrame[] = []
    for (let k = first; k <= end; k++) {
      const frame = this.frameAt(k / this.fps)
      frames.push(frame)
      this.last = frame
      this.lastIndex = k
      for (const cb of [...this.listeners]) cb(frame)
    }
    return frames
  }
}
