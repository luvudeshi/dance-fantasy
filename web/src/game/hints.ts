// Teach-mode tips (pure, unit-tested): at most one short tip per judged beat, in the PLAYER's
// words. Routine limbs are compared with the player's own anatomical limbs (the player copies the
// mirrored coach like a mirror), so `l_*` is the player's LEFT and +x in the body frame is the
// player's right.
//
// Priority for one judged checkpoint:
//  1. can't see the player              -> "Can't see you — step back"
//  2. on the beat and near-perfect      -> "Perfect!"
//  3. a decent pose, but > 80 ms off    -> "Left arm late" / "Right arm early" (the weakest limb)
//  4. the weakest limb points elsewhere -> "Right arm too low", "Left arm wider", "Bend your knees",
//                                          "Lean left", "Straighten up" (player vs target angles)
//  5. otherwise                         -> "Nice!" or "Watch your left arm"
// HintFeed then rate-limits what is on screen so every tip stays up long enough to read.

import type { LimbName, Pose2D, Vec2 } from '@shared/skeleton'
import { angleBetweenDeg, DEFAULT_SCORING, limbVector, type CheckpointResult, type ScoringConfig } from './scoring'

export type HintKind = 'unseen' | 'timing' | 'direction' | 'watch' | 'praise'

export interface TeachHint {
  text: string
  kind: HintKind
  /** The limb the tip is about (null for praise / unseen / a whole-body timing tip). */
  limb: LimbName | null
  /** Praise (green) rather than a correction. */
  good: boolean
  /** The checkpoint's score, 0..100 (picks the most useful tip when several beats close at once). */
  score: number
}

/** Timing tips fire beyond this many REAL seconds early / late. */
export const TIMING_HINT_SEC = 0.08
/** A limb within this angle (degrees) of the target gets no direction tip. */
export const DIRECTION_MIN_DEG = 15
/** Knee bend difference (degrees) for "Bend your knees" / "Straighten up". */
export const KNEE_HINT_DEG = 20
/** Torso tilt (unit-vector x) that counts as a lean (~10°). */
export const LEAN_X = Math.sin((10 * Math.PI) / 180)

export const UNSEEN_HINT = 'Can’t see you — step back'

/** Player-perspective limb words. */
export const LIMB_WORDS: Readonly<Record<LimbName, string>> = {
  l_upper_arm: 'Left arm',
  l_forearm: 'Left arm',
  r_upper_arm: 'Right arm',
  r_forearm: 'Right arm',
  l_thigh: 'Left leg',
  l_shin: 'Left leg',
  r_thigh: 'Right leg',
  r_shin: 'Right leg',
  torso: 'Body',
}

/** Lowest-scoring limb (first listed wins ties); null when none were compared. */
export function weakestLimb(perLimb: Partial<Record<LimbName, number>>): LimbName | null {
  let worst: LimbName | null = null
  let lo = Number.POSITIVE_INFINITY
  for (const [limb, s] of Object.entries(perLimb) as Array<[LimbName, number | undefined]>) {
    if (s === undefined || !Number.isFinite(s)) continue
    if (s < lo) {
      lo = s
      worst = limb
    }
  }
  return worst
}

/** Limbs scoring below `below` (default: the "ok" threshold): tinted on the coach. */
export function wrongLimbs(r: Pick<CheckpointResult, 'perLimb' | 'unseen'>, below = DEFAULT_SCORING.thresholds.ok): LimbName[] {
  if (r.unseen) return []
  return (Object.entries(r.perLimb) as Array<[LimbName, number | undefined]>).filter(([, s]) => s !== undefined && s < below).map(([l]) => l)
}

const unit = (v: Vec2): Vec2 | null => {
  const n = Math.hypot(v[0], v[1])
  return n > 1e-9 && Number.isFinite(n) ? [v[0] / n, v[1] / n] : null
}

/** Knee bend (degrees, 0 = straight leg) of one side. */
function kneeBend(p: Pose2D, side: 'l' | 'r'): number | null {
  const thigh = limbVector(p, side === 'l' ? 'l_thigh' : 'r_thigh')
  const shin = limbVector(p, side === 'l' ? 'l_shin' : 'r_shin')
  return thigh && shin && Math.hypot(...thigh) > 1e-9 && Math.hypot(...shin) > 1e-9 ? angleBetweenDeg(thigh, shin) : null
}

/**
 * Which way to move `limb` so the player's pose matches the target (null when close enough or
 * not computable). Arms and legs: the bigger of the up/down and out/in differences (in the
 * player's own outward direction); legs first check the knee bend; the torso: lean / upright.
 */
export function directionHint(limb: LimbName, player: Pose2D, target: Pose2D): string | null {
  const pv = limbVector(player, limb)
  const tv = limbVector(target, limb)
  const P = pv ? unit(pv) : null
  const T = tv ? unit(tv) : null
  if (!P || !T || angleBetweenDeg(P, T) < DIRECTION_MIN_DEG) return null
  if (limb === 'torso') {
    if (Math.abs(T[0]) < LEAN_X && Math.abs(P[0]) >= LEAN_X) return 'Straighten up'
    const dx = T[0] - P[0]
    if (Math.abs(dx) < LEAN_X) return null
    return dx > 0 ? 'Lean right' : 'Lean left'
  }
  const side = limb.startsWith('l_') ? 'l' : 'r'
  const isLeg = limb.endsWith('thigh') || limb.endsWith('shin')
  if (isLeg) {
    const bt = kneeBend(target, side)
    const bp = kneeBend(player, side)
    if (bt !== null && bp !== null) {
      if (bt - bp > KNEE_HINT_DEG) return 'Bend your knees'
      if (bp - bt > KNEE_HINT_DEG) return 'Straighten up'
    }
  }
  const out = side === 'r' ? 1 : -1
  const dOut = out * T[0] - out * P[0]
  const dUp = -T[1] - -P[1]
  const word = LIMB_WORDS[limb]
  if (Math.abs(dUp) >= Math.abs(dOut)) return dUp > 0 ? `${word} too low` : `${word} too high`
  return dOut > 0 ? `${word} wider` : `${word} closer`
}

/**
 * The tip for one judged checkpoint. `player`: the player's pose at the best-matching frame
 * (null when unknown: no direction tips then). `rate`: playback rate (offsets are song time).
 */
export function hintFor(
  r: Pick<CheckpointResult, 'checkpoint' | 'score' | 'offsetSec' | 'perLimb' | 'unseen'>,
  player: Pose2D | null,
  rate: number,
  config: Pick<ScoringConfig, 'thresholds'> = DEFAULT_SCORING,
): TeachHint {
  const th = config.thresholds
  const score = r.score
  if (r.unseen) return { text: UNSEEN_HINT, kind: 'unseen', limb: null, good: false, score }
  const limb = weakestLimb(r.perLimb)
  const word = limb ? LIMB_WORDS[limb] : null
  const offReal = r.offsetSec === null ? 0 : r.offsetSec / (rate > 0 ? rate : 1)
  const timingOff = Math.abs(offReal) > TIMING_HINT_SEC
  if (score >= th.perfect && !timingOff) return { text: 'Perfect!', kind: 'praise', limb: null, good: true, score }
  if (timingOff && score >= th.ok) {
    const when = offReal > 0 ? 'late' : 'early'
    const text = word && limb !== 'torso' ? `${word} ${when}` : `A little ${when}`
    return { text, kind: 'timing', limb, good: false, score }
  }
  if (limb && player && (r.perLimb[limb] ?? 100) < th.good) {
    const text = directionHint(limb, player, r.checkpoint.target)
    if (text) return { text, kind: 'direction', limb, good: false, score }
  }
  if (score >= th.good) return { text: score >= th.perfect ? 'Perfect!' : 'Nice!', kind: 'praise', limb: null, good: true, score }
  const text = !limb ? 'Copy the coach' : limb === 'torso' ? 'Watch your lean' : `Watch your ${word?.toLowerCase() ?? 'arms'}`
  return { text, kind: 'watch', limb, good: false, score }
}

/** One tip for several beats judged at once: the weakest correction, else the best praise. */
export function pickHint(hints: readonly TeachHint[]): TeachHint | null {
  let best: TeachHint | null = null
  for (const h of hints) {
    if (!best) best = h
    else if (best.good && !h.good) best = h
    else if (best.good === h.good && (h.good ? h.score > best.score : h.score < best.score)) best = h
  }
  return best
}

/** A tip stays at least this long (ms) before a different one may replace it ... */
export const HINT_MIN_MS = 1200
/** ... is shown fully for this long ... */
export const HINT_HOLD_MS = 2400
/** ... then fades out over this long. */
export const HINT_FADE_MS = 400

/**
 * What tip is on screen (wall-clock ms). A new tip replaces the current one once that has been
 * up HINT_MIN_MS, immediately when it repeats the same text (refresh) or when a correction
 * replaces praise; otherwise it is dropped.
 */
export class HintFeed {
  private cur: { hint: TeachHint; at: number } | null = null

  push(hint: TeachHint, nowMs: number): boolean {
    const c = this.cur
    const replace = !c || nowMs - c.at >= HINT_MIN_MS || c.hint.text === hint.text || (c.hint.good && !hint.good)
    if (replace) this.cur = { hint, at: nowMs }
    return replace
  }

  current(nowMs: number): { hint: TeachHint; alpha: number } | null {
    const c = this.cur
    if (!c) return null
    const age = nowMs - c.at
    if (age >= HINT_HOLD_MS + HINT_FADE_MS) return null
    return { hint: c.hint, alpha: age <= HINT_HOLD_MS ? 1 : 1 - (age - HINT_HOLD_MS) / HINT_FADE_MS }
  }

  clear(): void {
    this.cur = null
  }
}
