// Per-frame v2 scoring: forgiving geometry, hero-limb weighting and soft visibility.

import { JOINTS, type LimbName, type Pose2D, type Vec2 } from '@shared/skeleton'
import { NEUTRAL_POSE } from '../../routine/pose'
import { angleBetweenDeg, DEFAULT_LIMB_WEIGHTS, LIMB_NAMES, limbVector, NEUTRAL_SKIP_DEG, type Checkpoint, type ScoringConfig } from '../scoring'
import type { PlayerFrame } from '../poseSource'
import { DEFAULT_V2, limbScoreV2, type V2Config } from './config'

export type LimbDirs = Partial<Record<LimbName, Vec2>>

/** Limb directions of a frame, counting only joints at or above minVisibility. */
export function visibleLimbDirs(frame: PlayerFrame, minVisibility: number): LimbDirs {
  const out: LimbDirs = {}
  if (!frame.valid) return out
  const seen: Pose2D = {}
  for (const j of JOINTS) if (frame.pose[j] && (frame.visibility[j] ?? 0) >= minVisibility) seen[j] = frame.pose[j]
  for (const limb of LIMB_NAMES) {
    const v = limbVector(seen, limb)
    if (v && Math.hypot(v[0], v[1]) > 1e-9) out[limb] = v
  }
  return out
}

/**
 * Carries each limb's last good direction through short dropouts (motion blur): a limb missing
 * from a frame reuses its previous direction when that is at most carrySec older.
 */
export class LimbCarry {
  private readonly last: Partial<Record<LimbName, { dir: Vec2; t: number }>> = {}

  private readonly carrySec: number

  constructor(carrySec: number = DEFAULT_V2.carrySec) {
    this.carrySec = carrySec
  }

  apply(songTime: number, dirs: LimbDirs): LimbDirs {
    const out: LimbDirs = { ...dirs }
    for (const limb of LIMB_NAMES) {
      const d = dirs[limb]
      const prev = this.last[limb]
      if (d) {
        if (!prev || songTime >= prev.t) this.last[limb] = { dir: d, t: songTime }
      } else if (prev && songTime - prev.t <= this.carrySec && songTime >= prev.t) {
        out[limb] = prev.dir
      }
    }
    return out
  }
}

export interface FrameScoreV2 {
  /** 0..100 before timing and bonuses. */
  score: number
  perLimb: Partial<Record<LimbName, number>>
  /** Weighted mean angular error (degrees) of the visible hero limbs (timing uses it). */
  heroErrDeg: number
  /** Every hero limb was missing. */
  unseen: boolean
}

const NEUTRAL_DIR = Object.fromEntries(LIMB_NAMES.map((l) => [l, limbVector(NEUTRAL_POSE, l)])) as Record<LimbName, Vec2 | undefined>

const UNSEEN: FrameScoreV2 = { score: 0, perLimb: {}, heroErrDeg: Number.POSITIVE_INFINITY, unseen: true }

/**
 * hero = weighted mean over visible hero limbs, support = the same over the other visible limbs.
 * Score = max(hero, heroWeight * hero + (1 - heroWeight) * support): support limbs can only add.
 * Unseen only when no hero limb is visible. Anti-cheat: a limb whose target is away from rest
 * (> NEUTRAL_SKIP_DEG) but which is closer to its resting direction than to the target scores 0,
 * so the forgiving angles never reward standing still.
 */
export function scoreFrameV2(
  cp: Pick<Checkpoint, 'target' | 'limbs'>,
  heroes: readonly LimbName[],
  dirs: LimbDirs,
  base: ScoringConfig,
  c: V2Config = DEFAULT_V2,
): FrameScoreV2 {
  const weights = base.limbWeights ?? DEFAULT_LIMB_WEIGHTS
  const perLimb: Partial<Record<LimbName, number>> = {}
  let hW = 0
  let hSum = 0
  let hErr = 0
  let sW = 0
  let sSum = 0
  for (const limb of cp.limbs) {
    const pv = dirs[limb]
    const tv = limbVector(cp.target, limb)
    if (!pv || !tv) continue
    const err = angleBetweenDeg(pv, tv)
    const rest = NEUTRAL_DIR[limb]
    const atRest = rest !== undefined && angleBetweenDeg(tv, rest) > NEUTRAL_SKIP_DEG && angleBetweenDeg(pv, rest) < err
    const s = atRest ? 0 : limbScoreV2(err, c)
    const w = Math.max(0, weights[limb] ?? DEFAULT_LIMB_WEIGHTS[limb])
    perLimb[limb] = s
    if (heroes.includes(limb)) {
      hW += w
      hSum += w * s
      hErr += w * err
    } else {
      sW += w
      sSum += w * s
    }
  }
  if (!(hW > 0)) return { ...UNSEEN, perLimb }
  const hero = hSum / hW
  const score = sW > 0 ? Math.max(hero, c.heroWeight * hero + (1 - c.heroWeight) * (sSum / sW)) : hero
  return { score, perLimb, heroErrDeg: hErr / hW, unseen: false }
}
