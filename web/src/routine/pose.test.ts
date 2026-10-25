import { describe, expect, it } from 'vitest'
import routineExample from '@shared/examples/routine.example.json'
import type { Move, Routine } from '@shared/routine'
import { JOINTS, type Pose2D, type Vec2 } from '@shared/skeleton'
import { DEMO_LIBRARY, demoRoutine } from './demo'
import {
  easeInOutSine,
  lastStartedIndex,
  lerpPose,
  mirrorPose,
  moveIndexAt,
  NEUTRAL_POSE,
  poseAtTime,
  poseDistance,
  poseInMove,
  smoothstep,
  BLEND_SPEED,
  transitionSec,
  type KeyframeLike,
} from './pose'

const EXAMPLE = routineExample as unknown as Routine

const shift = (p: Pose2D, dx: number, dy: number): Pose2D => {
  const out: Pose2D = {}
  for (const j of JOINTS) {
    const v = p[j]
    if (v) out[j] = [v[0] + dx, v[1] + dy]
  }
  return out
}

const A: Pose2D = { ...NEUTRAL_POSE }
const B: Pose2D = shift(A, 1, 0)
const C: Pose2D = shift(A, 0, 2)

function move(id: string, startTime: number, endTime: number, keyframes: KeyframeLike[], lengthBeats = 4): Move {
  return { id, name: id, startBeat: 0, lengthBeats, startTime, endTime, intensity: 1, scoredJoints: [], keyframes }
}

describe('easing', () => {
  it('hits 0, 0.5 and 1 and clamps outside [0, 1]', () => {
    for (const f of [easeInOutSine, smoothstep]) {
      expect(f(0)).toBe(0)
      expect(f(1)).toBe(1)
      expect(f(0.5)).toBeCloseTo(0.5, 12)
      expect(f(-3)).toBe(0)
      expect(f(7)).toBe(1)
      expect(f(Number.NaN)).toBe(0)
      expect(f(0.25)).toBeLessThan(0.25) // ease-in
      expect(f(0.75)).toBeGreaterThan(0.75) // ease-out
    }
  })

  it('is monotonic', () => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const v = easeInOutSine(i / 100)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('lerpPose / mirrorPose', () => {
  it('interpolates joint-wise and keeps joints present in one pose only', () => {
    const mid = lerpPose(A, B, 0.25)
    expect(mid.nose?.[0]).toBeCloseTo(0.25)
    expect(lerpPose(A, B, 0)).toEqual(A)
    expect(lerpPose(A, B, 1)).toEqual(B)
    expect(lerpPose({ nose: [0, 0] }, { l_wrist: [1, 1] }, 0.5)).toEqual({ nose: [0, 0], l_wrist: [1, 1] })
  })

  it('mirrors the neutral pose onto itself and is an involution', () => {
    expect(poseDistance(mirrorPose(NEUTRAL_POSE), NEUTRAL_POSE)).toBeLessThan(1e-12)
    const raised = { ...NEUTRAL_POSE, r_wrist: [0.6, -2.1] as Vec2 }
    const m = mirrorPose(raised)
    expect(m.l_wrist).toEqual([-0.6, -2.1])
    expect(m.r_wrist).toEqual([0.55, 0.12])
    expect(mirrorPose(m)).toEqual(raised)
  })

  it('NEUTRAL_POSE matches the contract example', () => {
    expect(NEUTRAL_POSE).toEqual(EXAMPLE.moves[0].keyframes[0].pose)
  })
})

describe('poseInMove', () => {
  const kfs: KeyframeLike[] = [
    { t: 0, pose: A },
    { t: 0.5, pose: B, root: [0, -0.4] },
    { t: 1, pose: C, root: [0.2, 0] },
  ]

  it('is exact at keyframe times', () => {
    for (const k of kfs) {
      const s = poseInMove(kfs, k.t)
      expect(s.pose).toEqual(k.pose)
      expect(s.root).toEqual(k.root ?? [0, 0])
    }
    for (const lib of DEMO_LIBRARY.moves) {
      for (const k of lib.keyframes) expect(poseInMove(lib.keyframes, k.t)).toEqual({ pose: k.pose, root: k.root })
    }
  })

  it('eases between keyframes and holds outside them', () => {
    const q = poseInMove(kfs, 0.125) // a quarter of the way from A to B
    expect(q.pose.nose?.[0]).toBeCloseTo(easeInOutSine(0.25), 12)
    expect(q.root[1]).toBeCloseTo(-0.4 * easeInOutSine(0.25), 12)
    expect(poseInMove(kfs, -1).pose).toEqual(A)
    expect(poseInMove(kfs, 2).pose).toEqual(C)
    const late = [{ t: 0.3, pose: B }, { t: 0.6, pose: C }]
    expect(poseInMove(late, 0.1).pose).toEqual(B)
    expect(poseInMove(late, 0.9).pose).toEqual(C)
  })

  it('falls back to neutral with no keyframes and handles one keyframe', () => {
    expect(poseInMove([], 0.5)).toEqual({ pose: NEUTRAL_POSE, root: [0, 0] })
    expect(poseInMove([{ t: 0, pose: B }], 0.7).pose).toEqual(B)
  })

  it('takes the later keyframe for duplicate times', () => {
    const dup = [{ t: 0, pose: A }, { t: 0.5, pose: B }, { t: 0.5, pose: C }, { t: 1, pose: A }]
    expect(poseInMove(dup, 0.5).pose).toEqual(C)
  })
})

describe('moveIndexAt', () => {
  const r = { moves: [move('a', 1, 2, [{ t: 0, pose: A }]), move('b', 2, 3, [{ t: 0, pose: A }]), move('c', 4, 5, [{ t: 0, pose: A }])] }

  it('finds the move playing at t (binary search)', () => {
    expect(moveIndexAt(r, 0.5)).toBe(-1)
    expect(moveIndexAt(r, 1)).toBe(0)
    expect(moveIndexAt(r, 1.999)).toBe(0)
    expect(moveIndexAt(r, 2)).toBe(1)
    expect(moveIndexAt(r, 3.5)).toBe(-1) // gap
    expect(lastStartedIndex(r.moves, 3.5)).toBe(1)
    expect(moveIndexAt(r, 4.2)).toBe(2)
    expect(moveIndexAt(r, 5)).toBe(-1)
    expect(moveIndexAt({ moves: [] }, 1)).toBe(-1)
  })

  it('agrees with a linear scan on a generated routine', () => {
    const rt = demoRoutine(fakeSong(), DEMO_LIBRARY, { difficulty: 'normal', mode: 'standing', seed: 3 })
    for (let t = -1; t < 40; t += 0.137) {
      const linear = rt.moves.findIndex((m) => m.startTime <= t && t < m.endTime)
      expect(moveIndexAt(rt, t)).toBe(linear)
    }
  })
})

function fakeSong() {
  const beats = Array.from({ length: 64 }, (_, i) => 0.4 + i * 0.5)
  return {
    id: 'f'.repeat(64),
    title: 'Fake',
    durationSec: 33,
    bpm: 120,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 1),
    sections: [{ start: 0, end: 33, label: 'verse' as const, energy: 0.5, group: 'A', startBeat: 0, endBeat: 64, bars: 16 }],
  }
}

describe('poseAtTime', () => {
  it('returns neutral for an empty routine', () => {
    expect(poseAtTime({ moves: [] }, 3)).toEqual({ pose: NEUTRAL_POSE, root: [0, 0], moveIndex: -1, u: 0, nextMoveIndex: -1 })
  })

  it('holds the first start pose before and the last end pose after the routine', () => {
    const r = { moves: [move('a', 1, 3, [{ t: 0, pose: B, root: [0.1, 0] }, { t: 1, pose: C }])] }
    expect(poseAtTime(r, 0)).toEqual({ pose: B, root: [0.1, 0], moveIndex: -1, u: 0, nextMoveIndex: 0 })
    expect(poseAtTime(r, 10)).toEqual({ pose: C, root: [0, 0], moveIndex: -1, u: 0, nextMoveIndex: -1 })
    const mid = poseAtTime(r, 2)
    expect(mid.moveIndex).toBe(0)
    expect(mid.u).toBeCloseTo(0.5)
    expect(mid.nextMoveIndex).toBe(-1)
  })

  it('follows the move exactly when consecutive moves share the boundary pose', () => {
    const r = { moves: [move('a', 0, 2, [{ t: 0, pose: A }, { t: 1, pose: B }]), move('b', 2, 4, [{ t: 0, pose: B }, { t: 1, pose: C }])] }
    const s = poseAtTime(r, 2.05)
    expect(s.pose).toEqual(poseInMove(r.moves[1].keyframes, 0.025).pose)
    expect(s.moveIndex).toBe(1)
    expect(s.nextMoveIndex).toBe(-1)
  })

  it('blends from the previous end pose over min(0.5 beat, 15% of the move)', () => {
    // b: 4 beats over 2 s -> beat 0.5 s; window = min(0.25, 0.3) = 0.25 s.
    const r = { moves: [move('a', 0, 2, [{ t: 0, pose: A }, { t: 1, pose: B, root: [0, 0.3] }]), move('b', 2, 4, [{ t: 0, pose: C }, { t: 1, pose: A }])] }
    expect(transitionSec(r.moves[1])).toBeCloseTo(0.25)
    // Continuous at the boundary.
    const before = poseAtTime(r, 2 - 1e-9)
    const at = poseAtTime(r, 2)
    expect(poseDistance(before.pose, at.pose)).toBeLessThan(1e-6)
    expect(at.pose).toEqual(B)
    expect(at.root).toEqual([0, 0.3])
    expect(at.moveIndex).toBe(1)
    // Mid-window: between the previous end and the move's own pose.
    const mid = poseAtTime(r, 2.125)
    const own = poseInMove(r.moves[1].keyframes, 0.0625)
    expect(mid.pose).toEqual(lerpPose(B, own.pose, smoothstep(0.5)))
    // After the window: the move's own pose, exactly.
    expect(poseAtTime(r, 2.25).pose).toEqual(poseInMove(r.moves[1].keyframes, 0.125).pose)
    // 15% caps it for long beats: 1 beat over 2 s -> min(1, 0.3) = 0.3.
    expect(transitionSec(move('x', 0, 2, [], 1))).toBeCloseTo(0.3)
  })

  it('gives a big jump more time, up to half a beat (real-dancer clips chain by distance)', () => {
    // 2 beats over 1 s: beat 0.5 s; base = min(0.25, 0.15) = 0.15 s.
    const two = move('x', 0, 1, [], 2)
    expect(transitionSec(two)).toBeCloseTo(0.15)
    expect(transitionSec(two, 0.6)).toBeCloseTo(0.15) // 0.6 / 6 = 0.1 < base
    expect(transitionSec(two, 1.2)).toBeCloseTo(1.2 / BLEND_SPEED)
    expect(transitionSec(two, 9)).toBeCloseTo(0.25) // never past half a beat
    expect(transitionSec(two, Number.NaN)).toBeCloseTo(0.15)
    // 4-beat moves already blend over half a beat.
    expect(transitionSec(move('y', 0, 2, []), 3)).toBeCloseTo(0.25)
    // poseAtTime uses the longer window: still blending at 0.18 s after a 1.2-unit jump.
    const r = { moves: [move('a', 0, 1, [{ t: 0, pose: A }, { t: 1, pose: A }], 2), move('b', 1, 2, [{ t: 0, pose: shift(A, 1.2, 0) }, { t: 1, pose: shift(A, 1.2, 0) }], 2)] }
    const at = poseAtTime(r, 1.18).pose
    expect(at.nose?.[0]).toBeCloseTo(1.2 * smoothstep(0.18 / 0.2), 9)
    expect(poseAtTime(r, 1.2).pose.nose?.[0]).toBeCloseTo(1.2, 12)
  })

  it('is continuous across a gap and all boundaries of a generated routine', () => {
    const r = { moves: [move('a', 0, 1, [{ t: 0, pose: A }, { t: 1, pose: B }]), move('b', 1.5, 2.5, [{ t: 0, pose: C }, { t: 1, pose: A }])] }
    expect(poseAtTime(r, 1.2).pose).toEqual(B) // gap holds the previous end pose
    expect(poseAtTime(r, 1.2).nextMoveIndex).toBe(1)
    expect(poseDistance(poseAtTime(r, 1.5 - 1e-9).pose, poseAtTime(r, 1.5).pose)).toBeLessThan(1e-6)

    const rt = demoRoutine(fakeSong(), DEMO_LIBRARY, { difficulty: 'hard', mode: 'standing', seed: 11 })
    expect(rt.moves.length).toBeGreaterThan(5)
    for (const m of rt.moves) {
      const a = poseAtTime(rt, m.startTime - 1e-7)
      const b = poseAtTime(rt, m.startTime)
      expect(poseDistance(a.pose, b.pose)).toBeLessThan(1e-4)
      expect(Math.abs(a.root[0] - b.root[0]) + Math.abs(a.root[1] - b.root[1])).toBeLessThan(1e-4)
    }
  })

  it('animates the contract example routine', () => {
    const s = poseAtTime(EXAMPLE, 0.5)
    expect(s.moveIndex).toBe(0)
    expect(s.u).toBeCloseTo(0.25)
    expect(Object.keys(s.pose)).toHaveLength(17)
  })
})
