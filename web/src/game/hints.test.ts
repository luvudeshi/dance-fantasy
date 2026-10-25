import { describe, expect, it } from 'vitest'
import type { JointName, LimbName, Pose2D, Vec2 } from '@shared/skeleton'
import { NEUTRAL_POSE } from '../routine/pose'
import {
  directionHint,
  HINT_FADE_MS,
  HINT_HOLD_MS,
  HINT_MIN_MS,
  HintFeed,
  hintFor,
  pickHint,
  UNSEEN_HINT,
  weakestLimb,
  wrongLimbs,
  type TeachHint,
} from './hints'
import type { CheckpointResult } from './scoring'

const pose = (over: Partial<Record<JointName, Vec2>> = {}): Pose2D => ({ ...NEUTRAL_POSE, ...over })

// Body frame: +x = the dancer's (player's) right, +y down; shoulders at (±0.45, -1).
const R_ARM_UP = pose({ r_elbow: [0.45, -1.55], r_wrist: [0.45, -2.1] })
const R_ARM_OUT = pose({ r_elbow: [1, -1], r_wrist: [1.55, -1] })
const L_ARM_OUT = pose({ l_elbow: [-1, -1], l_wrist: [-1.55, -1] })
const L_ARM_ACROSS = pose({ l_elbow: [0.1, -1], l_wrist: [0.65, -1] })
const L_ARM_DIAG_DOWN = pose({ l_elbow: [-0.85, -0.6], l_wrist: [-1.25, -0.2] })
const KNEES_BENT = pose({ l_knee: [-0.6, 0.8], r_knee: [0.6, 0.8], l_ankle: [-0.3, 1.5], r_ankle: [0.3, 1.5] })
const LEAN_RIGHT = pose({ l_shoulder: [-0.1, -0.95], r_shoulder: [0.8, -0.95] })

function result(o: {
  score: number
  perLimb: Partial<Record<LimbName, number>>
  offsetSec?: number | null
  target?: Pose2D
  unseen?: boolean
}): CheckpointResult {
  return {
    checkpoint: { index: 0, moveIndex: 0, time: 10, target: o.target ?? pose(), limbs: Object.keys(o.perLimb) as LimbName[] },
    score: o.score,
    judgment: o.score >= 90 ? 'perfect' : o.score >= 75 ? 'good' : o.score >= 55 ? 'ok' : 'miss',
    offsetSec: o.offsetSec === undefined ? 0 : o.offsetSec,
    perLimb: o.perLimb,
    ...(o.unseen ? { unseen: true } : {}),
  }
}

describe('directionHint (player perspective)', () => {
  it('arms: too low / too high', () => {
    expect(directionHint('r_upper_arm', pose(), R_ARM_UP)).toBe('Right arm too low')
    expect(directionHint('r_forearm', R_ARM_UP, pose())).toBe('Right arm too high')
    expect(directionHint('l_upper_arm', L_ARM_DIAG_DOWN, L_ARM_OUT)).toBe('Left arm too low')
  })

  it('arms: wider / closer, in each arm’s own outward direction', () => {
    expect(directionHint('l_upper_arm', L_ARM_ACROSS, L_ARM_OUT)).toBe('Left arm wider')
    expect(directionHint('l_upper_arm', L_ARM_OUT, L_ARM_ACROSS)).toBe('Left arm closer')
    expect(directionHint('r_forearm', R_ARM_UP, R_ARM_OUT)).toBe('Right arm too high') // vertical difference dominates
  })

  it('legs: bend your knees / straighten up', () => {
    expect(directionHint('l_shin', pose(), KNEES_BENT)).toBe('Bend your knees')
    expect(directionHint('r_thigh', KNEES_BENT, pose())).toBe('Straighten up')
  })

  it('torso: lean toward the player’s side, or straighten up', () => {
    expect(directionHint('torso', pose(), LEAN_RIGHT)).toBe('Lean right')
    expect(directionHint('torso', LEAN_RIGHT, pose())).toBe('Straighten up')
  })

  it('stays quiet when the limb is close enough or missing', () => {
    expect(directionHint('r_upper_arm', pose(), pose({ r_elbow: [0.55, -0.42] }))).toBeNull()
    expect(directionHint('r_upper_arm', {}, R_ARM_UP)).toBeNull()
  })
})

describe('hintFor', () => {
  it('says when it cannot see the player', () => {
    expect(hintFor(result({ score: 0, perLimb: {}, unseen: true, offsetSec: null }), null, 1)).toMatchObject({ text: UNSEEN_HINT, kind: 'unseen' })
  })

  it('praises a perfect, on-time beat', () => {
    expect(hintFor(result({ score: 96, perLimb: { l_upper_arm: 95, r_upper_arm: 98 } }), null, 1)).toMatchObject({ text: 'Perfect!', good: true })
  })

  it('names the weakest limb when the best frame is > 80 ms late / early in REAL time', () => {
    const late = result({ score: 82, perLimb: { l_upper_arm: 70, r_upper_arm: 95 }, offsetSec: 0.05 })
    expect(hintFor(late, null, 0.5)).toMatchObject({ text: 'Left arm late', kind: 'timing', limb: 'l_upper_arm' })
    // The same 50 ms of song is only 50 ms of real time at 1x: no timing tip.
    expect(hintFor(late, null, 1)).toMatchObject({ text: 'Nice!', kind: 'praise' })
    const early = result({ score: 92, perLimb: { r_forearm: 88, l_forearm: 99 }, offsetSec: -0.1 })
    expect(hintFor(early, null, 1)).toMatchObject({ text: 'Right arm early' })
  })

  it('gives a direction tip from the player’s pose for a weak limb', () => {
    const r = result({ score: 40, perLimb: { r_upper_arm: 10, l_upper_arm: 90 }, target: R_ARM_UP, offsetSec: 0.2 })
    expect(hintFor(r, pose(), 1)).toMatchObject({ text: 'Right arm too low', kind: 'direction', limb: 'r_upper_arm' })
    // Without the player's pose (or no clear direction): watch that limb.
    expect(hintFor(r, null, 1)).toMatchObject({ text: 'Watch your right arm', kind: 'watch' })
  })

  it('timing needs a decent pose; a poor pose gets a direction tip instead', () => {
    const r = result({ score: 30, perLimb: { r_upper_arm: 10 }, target: R_ARM_UP, offsetSec: 0.14 })
    expect(hintFor(r, pose(), 1).kind).toBe('direction')
  })
})

describe('limb helpers', () => {
  it('finds the weakest limb and the limbs to tint', () => {
    expect(weakestLimb({ l_upper_arm: 80, r_shin: 20, torso: 20 })).toBe('r_shin')
    expect(weakestLimb({})).toBeNull()
    expect(wrongLimbs({ perLimb: { l_upper_arm: 80, r_shin: 20, torso: 54 } })).toEqual(['r_shin', 'torso'])
    expect(wrongLimbs({ perLimb: { r_shin: 0 }, unseen: true })).toEqual([])
  })
})

describe('pickHint / HintFeed', () => {
  const h = (text: string, good: boolean, score: number): TeachHint => ({ text, kind: good ? 'praise' : 'watch', limb: null, good, score })

  it('picks the weakest correction, else the best praise', () => {
    expect(pickHint([h('Nice!', true, 80), h('Watch your left arm', false, 40), h('Right arm too low', false, 20)])?.text).toBe('Right arm too low')
    expect(pickHint([h('Nice!', true, 80), h('Perfect!', true, 95)])?.text).toBe('Perfect!')
    expect(pickHint([])).toBeNull()
  })

  it('keeps a tip up long enough to read, then fades it', () => {
    const feed = new HintFeed()
    expect(feed.push(h('Left arm late', false, 60), 0)).toBe(true)
    expect(feed.push(h('Right arm too low', false, 30), 500)).toBe(false) // too soon
    expect(feed.push(h('Left arm late', false, 60), 600)).toBe(true) // same tip refreshes
    expect(feed.push(h('Right arm too low', false, 30), 600 + HINT_MIN_MS)).toBe(true)
    expect(feed.current(600 + HINT_MIN_MS)?.hint.text).toBe('Right arm too low')
    const t0 = 600 + HINT_MIN_MS
    expect(feed.current(t0 + HINT_HOLD_MS + HINT_FADE_MS / 2)?.alpha).toBeCloseTo(0.5)
    expect(feed.current(t0 + HINT_HOLD_MS + HINT_FADE_MS)).toBeNull()
  })

  it('lets a correction replace praise right away, but not the other way round', () => {
    const feed = new HintFeed()
    feed.push(h('Perfect!', true, 95), 0)
    expect(feed.push(h('Left arm late', false, 60), 100)).toBe(true)
    expect(feed.push(h('Perfect!', true, 99), 200)).toBe(false)
  })
})
