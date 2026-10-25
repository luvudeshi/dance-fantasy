// Motion bonus (bonus only): direction of travel vs the coach, and the "snap" on the beat.

import type { LimbName, Vec2 } from '@shared/skeleton'
import { angleBetweenDeg, limbVector } from '../scoring'
import type { MotionTrack } from '../../routine/track'
import { DEFAULT_V2, type V2Config } from './config'
import type { LimbDirs } from './frame'

/** Recent player limb directions by song time (oldest first). */
export class LimbHistory {
  private readonly frames: { t: number; dirs: LimbDirs }[] = []

  private readonly keepSec: number

  constructor(keepSec = 2) {
    this.keepSec = keepSec
  }

  push(t: number, dirs: LimbDirs): void {
    const f = this.frames
    let i = f.length
    while (i > 0 && f[i - 1].t > t) i--
    f.splice(i, 0, { t, dirs })
    const cut = f[f.length - 1].t - this.keepSec
    while (f.length > 0 && f[0].t < cut) f.shift()
  }

  /** Direction of `limb` in the frame nearest t (within maxGap s), as a unit vector. */
  at(limb: LimbName, t: number, maxGap = 0.05): Vec2 | undefined {
    let best: Vec2 | undefined
    let gap = maxGap
    for (const f of this.frames) {
      const d = Math.abs(f.t - t)
      const v = f.dirs[limb]
      if (v && d <= gap) {
        gap = d
        best = v
      }
    }
    return best && unit(best)
  }
}

function unit(v: Vec2): Vec2 {
  const n = Math.hypot(v[0], v[1])
  return n > 1e-9 ? [v[0] / n, v[1] / n] : [0, 0]
}

const clamp01 = (u: number): number => (u <= 0 || Number.isNaN(u) ? 0 : u >= 1 ? 1 : u)

export interface MotionBonus {
  direction: number
  snap: number
}

/**
 * Direction: over the last travelBeats before the player's best moment `tb`, the hero limbs'
 * travel (change of unit direction) should point the same way as the coach's over the same span
 * before the beat; cos >= 0.9 earns the full bonus, <= 0.3 nothing. Needs the motion track.
 * Snap: a hero limb arriving fast (>= snapMinSpeedDegPerSec) and nearly stopping right after
 * `tb` (outgoing speed <= 10% of incoming earns the full bonus, >= 50% nothing). Best limb counts.
 */
export function motionBonus(
  heroes: readonly LimbName[],
  beatTime: number,
  tb: number,
  beatSec: number,
  history: LimbHistory,
  track: MotionTrack | null,
  c: V2Config = DEFAULT_V2,
): MotionBonus {
  const q = Math.max(0.05, beatSec * c.travelBeats)
  let dirSum = 0
  let dirN = 0
  if (track) {
    const coachNow = track.sample(beatTime).pose
    const coachBefore = track.sample(beatTime - q).pose
    for (const limb of heroes) {
      const a = limbVector(coachBefore, limb)
      const b = limbVector(coachNow, limb)
      if (!a || !b) continue
      const ua = unit(a)
      const ub = unit(b)
      const dc: Vec2 = [ub[0] - ua[0], ub[1] - ua[1]]
      const nc = Math.hypot(dc[0], dc[1])
      if (nc < c.minTravel) continue
      dirN++
      const pa = history.at(limb, tb - q)
      const pb = history.at(limb, tb)
      if (!pa || !pb) continue
      const dp: Vec2 = [pb[0] - pa[0], pb[1] - pa[1]]
      const np = Math.hypot(dp[0], dp[1])
      if (np < c.minTravel / 2) continue
      const cos = (dp[0] * dc[0] + dp[1] * dc[1]) / (np * nc)
      dirSum += clamp01((cos - 0.3) / 0.6)
    }
  }
  const h = q / 2
  let snap = 0
  for (const limb of heroes) {
    const before = history.at(limb, tb - h)
    const now = history.at(limb, tb)
    const after = history.at(limb, tb + h)
    if (!before || !now || !after) continue
    const vin = angleBetweenDeg(before, now) / h
    if (vin < c.snapMinSpeedDegPerSec) continue
    const vout = angleBetweenDeg(now, after) / h
    snap = Math.max(snap, clamp01((0.5 - vout / vin) / 0.4))
  }
  return { direction: dirN > 0 ? (c.directionBonus * dirSum) / dirN : 0, snap: c.snapBonus * snap }
}
