// Hero limbs: per move, the limbs whose direction changes most across its keyframes (the
// checkpoint targets of the move plus the pose it starts from). They carry most of the score.

import type { LimbName, Vec2 } from '@shared/skeleton'
import { angleBetweenDeg, limbVector, type Checkpoint } from '../scoring'
import { NEUTRAL_POSE } from '../../routine/pose'
import { DEFAULT_V2, type V2Config } from './config'

/** Largest pairwise angle (degrees) between the limb's directions in `dirs`. */
function spreadDeg(dirs: readonly Vec2[]): number {
  let max = 0
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) max = Math.max(max, angleBetweenDeg(dirs[i], dirs[j]))
  return max
}

/**
 * Hero limbs of every checkpoint (same order as `checkpoints`, sorted by time). A move's hero
 * limbs change direction by >= heroFraction of its biggest change (and >= heroMinChangeDeg).
 * A checkpoint's heroes are its compared, non-resting limbs among them (a hero resting at this
 * beat would reward standing still); if none qualifies, its moving limbs, else all its limbs.
 */
export function heroLimbs(checkpoints: readonly Checkpoint[], c: V2Config = DEFAULT_V2): LimbName[][] {
  const byMove = new Map<number, number[]>()
  checkpoints.forEach((cp, i) => {
    const list = byMove.get(cp.moveIndex) ?? []
    list.push(i)
    byMove.set(cp.moveIndex, list)
  })
  const heroesOfMove = new Map<number, Set<LimbName>>()
  for (const [move, idx] of byMove) {
    const first = idx[0]
    const poses = [first > 0 ? checkpoints[first - 1].target : NEUTRAL_POSE, ...idx.map((i) => checkpoints[i].target)]
    const limbs = new Set(idx.flatMap((i) => checkpoints[i].limbs))
    const change = new Map<LimbName, number>()
    for (const limb of limbs) {
      const dirs = poses.map((p) => limbVector(p, limb)).filter((v): v is Vec2 => v !== undefined)
      change.set(limb, spreadDeg(dirs))
    }
    const top = Math.max(0, ...change.values())
    const cut = Math.max(c.heroMinChangeDeg, c.heroFraction * top)
    heroesOfMove.set(move, new Set([...change].filter(([, d]) => d >= cut).map(([l]) => l)))
  }
  return checkpoints.map((cp) => {
    const heroes = heroesOfMove.get(cp.moveIndex) ?? new Set<LimbName>()
    const own = cp.limbs.filter((l) => heroes.has(l) && !cp.resting?.includes(l))
    if (own.length > 0) return own
    const moving = cp.limbs.filter((l) => !cp.resting?.includes(l))
    return moving.length > 0 ? moving : [...cp.limbs]
  })
}
