import { describe, expect, it } from 'vitest'
import type { Move } from '@shared/routine'
import { JOINTS, LIMBS, type JointName, type Pose2D, type Vec2 } from '@shared/skeleton'
import { DEMO_LIBRARY, demoRoutine } from './demo'
import { NEUTRAL_POSE, poseAtTime, poseDistance, poseInMove, type KeyframeLike } from './pose'
import { buildMotionTrack, routineKnots, type MotionTrack } from './track'

const A: Pose2D = { ...NEUTRAL_POSE }
const with_ = (o: Partial<Record<JointName, Vec2>>): Pose2D => ({ ...NEUTRAL_POSE, ...o })
const shift = (p: Pose2D, dx: number, dy: number): Pose2D => {
  const out: Pose2D = {}
  for (const j of JOINTS) {
    const v = p[j]
    if (v) out[j] = [v[0] + dx, v[1] + dy]
  }
  return out
}
// Right arm raised in three steps: B -> C keeps going the same way.
const B = with_({ r_elbow: [0.95, -0.85], r_wrist: [1.35, -0.75] })
const C = with_({ r_elbow: [0.85, -1.45], r_wrist: [1.05, -1.95] })
const D = with_({ l_elbow: [-0.95, -0.85], l_wrist: [-1.35, -0.75], l_knee: [-0.4, 0.8], l_ankle: [-0.55, 1.65] })

function move(id: string, startTime: number, endTime: number, keyframes: KeyframeLike[], lengthBeats = 4): Move {
  return { id, name: id, startBeat: 0, lengthBeats, startTime, endTime, intensity: 1, scoredJoints: [], keyframes }
}

function song(seconds: number) {
  const beats = Array.from({ length: Math.floor(seconds / 0.5) }, (_, i) => 0.4 + i * 0.5)
  return {
    id: 'f'.repeat(64),
    title: 'Fake',
    durationSec: seconds,
    bpm: 120,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 1),
    sections: [{ start: 0, end: seconds, label: 'verse' as const, energy: 0.5, group: 'A', startBeat: 0, endBeat: beats.length, bars: 1 }],
  }
}

const routineOf = (seed: number, seconds = 40) => demoRoutine(song(seconds), DEMO_LIBRARY, { difficulty: 'hard', mode: 'standing', seed })

/** Largest joint displacement per second over [t, t + h]. */
function speed(track: MotionTrack, t: number, h = 1e-4): number {
  return poseDistance(track.sample(t).pose, track.sample(t + h).pose) / h
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1])

describe('buildMotionTrack', () => {
  it('returns neutral for an empty routine', () => {
    expect(buildMotionTrack({ moves: [] }).sample(3)).toEqual(poseAtTime({ moves: [] }, 3))
  })

  it('passes exactly through every keyframe that is a knot', () => {
    for (const seed of [1, 2, 3]) {
      const r = routineOf(seed)
      const track = buildMotionTrack(r)
      let checked = 0
      r.moves.forEach((m, i) => {
        const prevEnd = i > 0 ? poseInMove(r.moves[i - 1].keyframes, 1) : null
        m.keyframes.forEach((k, j) => {
          // A first keyframe that differs from the previous end pose is blended into (skip it).
          if (j === 0 && prevEnd && poseDistance(prevEnd.pose, k.pose) > 1e-4) return
          const t = m.startTime + k.t * (m.endTime - m.startTime)
          const s = track.sample(t)
          expect(poseDistance(s.pose, k.pose)).toBeLessThan(1e-9)
          expect(dist(s.root, k.root ?? [0, 0])).toBeLessThan(1e-9)
          checked++
        })
      })
      expect(checked).toBeGreaterThan(30)
    }
  })

  it('agrees with poseAtTime on moveIndex, u and nextMoveIndex everywhere', () => {
    const r = { moves: [move('a', 1, 2, [{ t: 0, pose: A }, { t: 1, pose: B }]), move('b', 2, 3, [{ t: 0, pose: B }, { t: 1, pose: A }]), move('c', 4, 5, [{ t: 0, pose: C }])] }
    const gen = routineOf(4)
    for (const rt of [r, gen]) {
      const track = buildMotionTrack(rt)
      const end = rt.moves[rt.moves.length - 1].endTime + 1
      for (let t = -1; t < end; t += 0.0371) {
        const a = track.sample(t)
        const b = poseAtTime(rt, t)
        expect([a.moveIndex, a.nextMoveIndex]).toEqual([b.moveIndex, b.nextMoveIndex])
        expect(a.u).toBeCloseTo(b.u, 12)
      }
      for (const m of rt.moves) {
        for (const t of [m.startTime, m.endTime, m.startTime - 1e-9]) {
          const a = track.sample(t)
          const b = poseAtTime(rt, t)
          expect([a.moveIndex, a.u, a.nextMoveIndex]).toEqual([b.moveIndex, b.u, b.nextMoveIndex])
        }
      }
    }
  })

  it('is continuous (C0 and C1) and never NaN on generated routines', () => {
    for (const seed of [5, 6]) {
      const r = routineOf(seed)
      const track = buildMotionTrack(r)
      for (const t of [-5, Number.NaN, 1e9, ...Array.from({ length: 4000 }, (_, i) => i * 0.0101)]) {
        const s = track.sample(t)
        expect(Object.keys(s.pose)).toHaveLength(17)
        for (const j of JOINTS) expect(Number.isFinite(s.pose[j]?.[0]) && Number.isFinite(s.pose[j]?.[1])).toBe(true)
        expect(Number.isFinite(s.root[0]) && Number.isFinite(s.root[1])).toBe(true)
      }
      const h = 1e-6
      for (const k of routineKnots(r.moves)) {
        const a = track.sample(k.time - h)
        const b = track.sample(k.time)
        const c = track.sample(k.time + h)
        expect(poseDistance(a.pose, b.pose)).toBeLessThan(1e-4)
        // Left and right velocities agree (C1).
        for (const j of JOINTS) {
          const pa = a.pose[j] as Vec2
          const pb = b.pose[j] as Vec2
          const pc = c.pose[j] as Vec2
          const vl: Vec2 = [(pb[0] - pa[0]) / h, (pb[1] - pa[1]) / h]
          const vr: Vec2 = [(pc[0] - pb[0]) / h, (pc[1] - pb[1]) / h]
          expect(dist(vl, vr)).toBeLessThan(0.05)
        }
      }
    }
  })

  it('never stretches a limb beyond its neighbouring keyframes', () => {
    const r = routineOf(7)
    const track = buildMotionTrack(r)
    const knots = routineKnots(r.moves)
    const len = (p: Pose2D, [a, b]: readonly [JointName, JointName]): number => dist(p[a] as Vec2, p[b] as Vec2)
    const limbs: Array<readonly [JointName, JointName]> = []
    for (const [a, b] of Object.values(LIMBS)) if (a !== 'mid_hip') limbs.push([a, b])
    let checked = 0
    for (let k = 0; k + 1 < knots.length; k++) {
      const t0 = knots[k].time
      const t1 = knots[k + 1].time
      for (const limb of limbs) {
        const l0 = len(knots[k].pose, limb)
        const l1 = len(knots[k + 1].pose, limb)
        const lo = Math.min(l0, l1)
        const hi = Math.max(l0, l1)
        for (let i = 1; i < 8; i++) {
          const l = len(track.sample(t0 + ((t1 - t0) * i) / 8).pose, limb)
          expect(l).toBeLessThanOrEqual(hi + 1e-9)
          expect(l).toBeGreaterThanOrEqual(lo - 1e-9)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  it('holds identical keyframes, gaps and the ends perfectly still', () => {
    const r = {
      moves: [
        move('a', 1, 3, [{ t: 0, pose: A }, { t: 0.25, pose: B }, { t: 0.75, pose: B }, { t: 1, pose: C, root: [0.1, 0.2] }]),
        move('b', 4, 5, [{ t: 0, pose: C, root: [0.1, 0.2] }, { t: 1, pose: D }]),
      ],
    }
    const track = buildMotionTrack(r)
    for (let t = 1.5; t <= 2.5; t += 0.05) expect(poseDistance(track.sample(t).pose, B)).toBeLessThan(1e-12)
    for (let t = 3; t <= 4; t += 0.05) {
      const s = track.sample(t)
      expect(poseDistance(s.pose, C)).toBeLessThan(1e-12)
      expect(dist(s.root, [0.1, 0.2])).toBeLessThan(1e-12)
    }
    expect(poseDistance(track.sample(-3).pose, A)).toBeLessThan(1e-12)
    expect(poseDistance(track.sample(0.999).pose, A)).toBeLessThan(1e-12)
    expect(poseDistance(track.sample(9).pose, D)).toBeLessThan(1e-12)
    expect(speed(track, 2)).toBe(0)
    expect(speed(track, 3.5)).toBe(0)
  })

  it('flows through move boundaries where the motion continues (poseAtTime stops dead)', () => {
    // a: A -> B, b: B -> C; the arm keeps rising through the boundary at t = 2.
    const r = { moves: [move('a', 1, 2, [{ t: 0, pose: A }, { t: 1, pose: B }]), move('b', 2, 3, [{ t: 0, pose: B }, { t: 1, pose: C }])] }
    const track = buildMotionTrack(r)
    expect(speed(track, 2 - 5e-5)).toBeGreaterThan(0.3)
    expect(poseDistance(poseAtTime(r, 2 - 5e-5).pose, poseAtTime(r, 2 + 5e-5).pose) / 1e-4).toBeLessThan(0.01)
    // A different start pose still blends in (no jump) and lands on the move's next keyframe.
    const r2 = { moves: [move('a', 0, 2, [{ t: 0, pose: A }, { t: 1, pose: B }]), move('b', 2, 4, [{ t: 0, pose: D }, { t: 0.5, pose: C }, { t: 1, pose: A }])] }
    const t2 = buildMotionTrack(r2)
    expect(poseDistance(t2.sample(2).pose, B)).toBeLessThan(1e-9)
    expect(poseDistance(t2.sample(2 + 0.25).pose, D)).toBeLessThan(1e-9) // transitionSec = 0.25
    expect(poseDistance(t2.sample(3).pose, C)).toBeLessThan(1e-9)
  })

  it('blends a big jump over the whole window even when the next move has dense keyframes', () => {
    // A real-dancer clip: quarter-beat keyframes (beat 0.5 s), starting over 2 units away from
    // the previous end pose. The blend must not be cut short by the quarter-beat knot at +0.125 s:
    // it lasts the full half beat (0.25 s = min(0.5 beat, 1.5 / BLEND_SPEED)).
    const far = with_({ r_elbow: [0.95, -1.6], r_wrist: [1.4, -2.1], l_elbow: [-0.95, -1.6], l_wrist: [-1.4, -2.1] })
    const q = (t: number, pose: Pose2D): KeyframeLike => ({ t, pose })
    const clip = move('clip', 2, 4, [q(0, far), q(1 / 16, C), q(2 / 16, far), q(3 / 16, B), q(4 / 16, far), q(1, far)])
    const r = { moves: [move('a', 0, 2, [{ t: 0, pose: A }, { t: 1, pose: A }]), clip] }
    const track = buildMotionTrack(r)
    const knots = routineKnots(r.moves)
    expect(knots.some((k) => Math.abs(k.time - 2.125) < 1e-9)).toBe(false) // the in-window knot is skipped
    expect(knots.some((k) => Math.abs(k.time - 2.25) < 1e-9)).toBe(true) // ... the window ends on a knot
    expect(poseDistance(track.sample(2).pose, A)).toBeLessThan(1e-9)
    // At the window's end: the move's own pose (here exactly its half-beat keyframe).
    expect(poseDistance(track.sample(2.25).pose, far)).toBeLessThan(1e-9)
    expect(poseDistance(track.sample(2.5).pose, far)).toBeLessThan(1e-9) // on-beat keyframe exact
    // Peak joint speed during the blend stays near the paced average (monotone cubic: <= 3x).
    const avg = poseDistance(A, far) / 0.25
    let peak = 0
    for (let t = 2; t < 2.25; t += 0.005) peak = Math.max(peak, speed(track, t))
    expect(peak).toBeLessThanOrEqual(3 * avg + 1e-6)
    // Without the fix the blend would hit the quarter-beat pose C at 2.125 s (twice as fast).
    expect(poseDistance(track.sample(2.125).pose, C)).toBeGreaterThan(0.1)
  })

  it('a window ending between two skipped knots lands on the move\'s interpolated pose', () => {
    // 2-beat move (beat 0.5 s), knots every 1/8 beat; a 1.2-unit jump: window = 1.2 / 6 = 0.2 s.
    const ks: KeyframeLike[] = Array.from({ length: 17 }, (_, i) => ({ t: i / 16, pose: shift(A, 1.2 + 0.1 * Math.min(i, 8), 0) }))
    const r = { moves: [move('a', 0, 1, [{ t: 0, pose: A }, { t: 1, pose: A }], 2), move('b', 1, 2, ks, 2)] }
    const knots = routineKnots(r.moves)
    const k = knots.find((x) => Math.abs(x.time - 1.2) < 1e-9)
    expect(k).toBeDefined()
    // Between the knots at 1.1875 s (x + 1.5) and 1.25 s (x + 1.6): 1.2 s is 20% of the way.
    expect(k?.pose.nose[0]).toBeCloseTo(1.5 + 0.1 * 0.2, 9)
    expect(knots.filter((x) => x.time > 1 && x.time < 1.2 - 1e-9)).toHaveLength(0)
  })

  it('slides a foreshortened (spinning) shoulder line through zero width instead of swinging it', () => {
    const side = with_({ l_shoulder: [0, -1], r_shoulder: [0, -1], l_hip: [0, 0], r_hip: [0, 0] })
    const back = with_({ l_shoulder: [0.45, -1], r_shoulder: [-0.45, -1], l_hip: [0.22, 0], r_hip: [-0.22, 0] })
    const r = { moves: [move('spin', 0, 2, [{ t: 0, pose: A }, { t: 0.5, pose: side }, { t: 1, pose: back }])] }
    const track = buildMotionTrack(r)
    for (let t = 0; t <= 2; t += 0.01) {
      const p = track.sample(t).pose
      expect(Math.abs((p.l_shoulder as Vec2)[1] + 1)).toBeLessThan(1e-9)
      expect(Math.abs((p.r_hip as Vec2)[1])).toBeLessThan(1e-9)
    }
    expect((track.sample(0.75).pose.r_shoulder as Vec2)[0]).toBeGreaterThan(0)
    expect((track.sample(1.25).pose.r_shoulder as Vec2)[0]).toBeLessThan(0)
  })

  it('flips a width-clamped spin through zero only between its side-on knots, then keeps turning', () => {
    // Server FK keeps spins >= 40% wide: front, narrow front, narrow back, back, full back.
    const turned = (k: number): Pose2D => {
      const out: Pose2D = {}
      for (const j of JOINTS) {
        const p = NEUTRAL_POSE[j] as Vec2
        out[j] = [p[0] * k, p[1]]
      }
      return out
    }
    const ks = [1, 0.7, 0.4, -0.4, -0.7, -1]
    const r = { moves: [move('spin', 0, 5, ks.map((k, i) => ({ t: i / 5, pose: turned(k) })))] }
    const track = buildMotionTrack(r)
    for (let t = 0; t <= 5; t += 0.01) {
      const p = track.sample(t).pose
      expect(Math.abs((p.l_shoulder as Vec2)[1] + 1)).toBeLessThan(1e-9) // the shoulder line never swings
      expect(Math.abs((p.r_hip as Vec2)[1])).toBeLessThan(1e-9)
      const w = (p.r_shoulder as Vec2)[0] - (p.l_shoulder as Vec2)[0]
      if (t < 2 - 1e-9 || t > 3 + 1e-9) expect(Math.abs(w)).toBeGreaterThan(0.4 * 0.9 - 1e-9) // narrow only mid-flip
      if (t > 3 + 1e-9) expect(w).toBeLessThan(0)
    }
  })

  it('samples a 4-minute routine in well under 0.05 ms', () => {
    const r = routineOf(9, 240)
    expect(r.moves[r.moves.length - 1].endTime).toBeGreaterThan(200)
    const track = buildMotionTrack(r)
    const n = 50_000
    let acc = 0
    const t0 = performance.now()
    for (let i = 0; i < n; i++) acc += track.sample((i * 239.7) / n).pose.nose?.[1] ?? 0
    const perCall = (performance.now() - t0) / n
    expect(Number.isFinite(acc)).toBe(true)
    expect(perCall).toBeLessThan(0.05)
  })
})
