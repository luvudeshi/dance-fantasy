// Scoring v2 tunables. The judging preset (game/judging.ts) still sets the thresholds, the
// visibility cut-off and, as an offset from the standard preset, how forgiving the angles are.

import { DEFAULT_SCORING, type ScoringConfig } from '../scoring'

export interface V2Config {
  /** A limb within this angle (degrees) of the target scores 100 ... */
  perfectDeg: number
  /** ... and 0 at this angle or worse (linear in between). */
  zeroDeg: number
  /** Falloff shape between perfectDeg and zeroDeg: score = 100 * u^falloffPower (u: linear 1..0).
   *  > 1 keeps near-misses generous but gives little for a limb pointing roughly anywhere. */
  falloffPower: number
  /** 'linear' (classic shape, see falloffPower) or 'gaussian': past perfectDeg the score falls
   *  off as exp(-x² / 2σ²) (OKS-style bell curve), so near-misses keep most of their credit. */
  falloff: 'linear' | 'gaussian'
  /** σ (degrees past perfectDeg) of the gaussian falloff. */
  gaussianSigmaDeg: number
  /** Window half-width as a fraction of a beat (0 = windowSec only); the wider of the two wins. */
  windowBeats: number
  /** "Tried it": a non-miss floor (the OK threshold) when the hero limbs travel the coach's way
   *  (match >= triedMatch, 0..1) and the pose is at least partly there (raw >= triedMinRaw). */
  triedFloor: boolean
  triedMatch: number
  triedMinRaw: number
  /** Share of a checkpoint's score carried by its hero limbs; the rest can only add points. */
  heroWeight: number
  /** A limb is a hero when its direction change across the move is >= this fraction of the largest. */
  heroFraction: number
  /** Limbs that change less than this (degrees) across a move are never heroes. */
  heroMinChangeDeg: number
  /** A limb's last good direction is carried through dropouts (motion blur) for this long (s). */
  carrySec: number
  /** Window (s) searched around each checkpoint (never narrower than the preset's). */
  windowSec: number
  /** Offsets beyond this (s) are tagged Early / Late. */
  timingTagSec: number
  /** Points kept at timingRefSec off the beat (1 on time, quadratic in between). */
  timingRefFactor: number
  timingRefSec: number
  /** Floor for the timing factor (the window bounds it anyway). */
  timingMinFactor: number
  /** Frames within this many degrees of the closest one count as equally close (timing tie-break). */
  timingTieDeg: number
  /** Motion bonus caps (points). */
  directionBonus: number
  snapBonus: number
  /** Coach limbs moving less than this (unit-vector distance over the look-back) give no direction bonus. */
  minTravel: number
  /** A snap needs at least this incoming angular speed (degrees / s) ... */
  snapMinSpeedDegPerSec: number
  /** Look-back for direction of travel, in beats. */
  travelBeats: number
}

export const DEFAULT_V2: V2Config = {
  perfectDeg: 25,
  zeroDeg: 80,
  falloffPower: 1.5,
  falloff: 'linear',
  gaussianSigmaDeg: 24,
  windowBeats: 0,
  triedFloor: false,
  triedMatch: 0.7,
  triedMinRaw: 15,
  heroWeight: 0.8,
  heroFraction: 0.4,
  heroMinChangeDeg: 15,
  carrySec: 0.1,
  windowSec: 0.18,
  timingTagSec: 0.06,
  timingRefFactor: 0.85,
  timingRefSec: 0.15,
  timingMinFactor: 0.6,
  timingTieDeg: 3,
  directionBonus: 10,
  snapBonus: 10,
  minTravel: 0.2,
  snapMinSpeedDegPerSec: 120,
  travelBeats: 0.25,
}

/** A judging preset that also carries v2 settings (and always plays with v2: createScoreKeeper). */
export interface V2ScoringConfig extends ScoringConfig {
  v2: Partial<V2Config>
}

export const hasV2Settings = (c: ScoringConfig): c is V2ScoringConfig => typeof (c as Partial<V2ScoringConfig>).v2 === 'object'

/** v2 settings for a judging preset: angles shift with the preset's offset from the standard one,
 *  then the preset's own v2 settings (if any), then `overrides`. */
export function v2ConfigFor(base: ScoringConfig, overrides: Partial<V2Config> = {}): V2Config {
  const dPerfect = (base.perfectDeg ?? 15) - (DEFAULT_SCORING.perfectDeg ?? 15)
  const dZero = (base.zeroDeg ?? 60) - (DEFAULT_SCORING.zeroDeg ?? 60)
  return {
    ...DEFAULT_V2,
    perfectDeg: DEFAULT_V2.perfectDeg + dPerfect,
    zeroDeg: DEFAULT_V2.zeroDeg + dZero,
    windowSec: Math.max(DEFAULT_V2.windowSec, base.windowSec),
    ...(hasV2Settings(base) ? base.v2 : {}),
    ...overrides,
  }
}

/** 0..100 for an angular error (degrees) under the v2 falloff. */
export function limbScoreV2(errorDeg: number, c: V2Config = DEFAULT_V2): number {
  if (Number.isNaN(errorDeg)) return 0
  const over = errorDeg - c.perfectDeg
  if (over <= 0) return 100
  if (c.falloff === 'gaussian') return 100 * Math.exp(-(over * over) / (2 * c.gaussianSigmaDeg * c.gaussianSigmaDeg))
  if (errorDeg >= c.zeroDeg) return 0
  return 100 * ((c.zeroDeg - errorDeg) / Math.max(1e-6, c.zeroDeg - c.perfectDeg)) ** c.falloffPower
}

/** 1 on the beat, timingRefFactor at ±timingRefSec (quadratic), never below timingMinFactor. */
export function timingFactor(offsetSec: number, c: V2Config = DEFAULT_V2): number {
  if (!Number.isFinite(offsetSec)) return c.timingMinFactor
  const u = offsetSec / c.timingRefSec
  return Math.max(c.timingMinFactor, 1 - (1 - c.timingRefFactor) * u * u)
}
