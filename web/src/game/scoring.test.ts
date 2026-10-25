import { describe, expect, it } from 'vitest'
import type { Move } from '@shared/routine'
import type { JointName, Pose2D, Vec2 } from '@shared/skeleton'
import { NEUTRAL_POSE } from '../routine/pose'
import type { PlayerFrame } from './poseSource'
import {
  buildCheckpoints,
  comboMultiplier,
  DEFAULT_SCORING,
  judge,
  limbScore,
  ScoreKeeper,
  scoreFrame,
  type Checkpoint,
} from './scoring'

// --- helpers -------------------------------------------------------------------------------

const N: Pose2D = { ...NEUTRAL_POSE }
/** Right arm straight up (the demo library's arm_raise peak). */
const RAISED: Pose2D = { ...NEUTRAL_POSE, r_elbow: [0.55, -1.55], r_wrist: [0.6, -2.1] }
/** Left arm straight up too. */
const BOTH_UP: Pose2D = { ...RAISED, l_elbow: [-0.55, -1.55], l_wrist: [-0.6, -2.1] }

function at(p: Pose2D, j: JointName): Vec2 {
  const v = p[j]
  if (!v) throw new Error(`missing ${j}`)
  return v
}

const rot = (v: Vec2, deg: number): Vec2 => {
  const r = (deg * Math.PI) / 180
  return [v[0] * Math.cos(r) - v[1] * Math.sin(r), v[0] * Math.sin(r) + v[1] * Math.cos(r)]
}

/** Rotates only `dist` about `prox` (so only that one limb's direction changes). */
function rotJoint(p: Pose2D, prox: JointName, dist: JointName, deg: number): Pose2D {
  const a = at(p, prox)
  const b = at(p, dist)
  const d = rot([b[0] - a[0], b[1] - a[1]], deg)
  return { ...p, [dist]: [a[0] + d[0], a[1] + d[1]] }
}

/** Leans the upper body (shoulders, arms, head) by `deg` about mid-hip. */
function lean(p: Pose2D, deg: number): Pose2D {
  const out: Pose2D = { ...p }
  for (const j of ['nose', 'l_eye', 'r_eye', 'l_ear', 'r_ear', 'l_shoulder', 'r_shoulder', 'l_elbow', 'r_elbow', 'l_wrist', 'r_wrist'] as const) {
    out[j] = rot(at(p, j), deg)
  }
  return out
}

const ALL_VISIBLE = Object.fromEntries(Object.keys(NEUTRAL_POSE).map((j) => [j, 1])) as Record<JointName, number>

function frame(songTime: number, pose: Pose2D, visibility: Partial<Record<JointName, number>> = ALL_VISIBLE, valid = true): PlayerFrame {
  return { songTime, pose, visibility, valid }
}

let moveId = 0
function move(startTime: number, lengthBeats: number, keyframes: [number, Pose2D][], opts: Partial<Move> = {}): Move {
  const beatSec = 0.5
  return {
    id: `m${moveId++}`,
    name: 'Move',
    startBeat: Math.round(startTime / beatSec),
    lengthBeats,
    startTime,
    endTime: startTime + lengthBeats * beatSec,
    intensity: 1,
    scoredJoints: ['r_elbow', 'r_wrist'],
    keyframes: keyframes.map(([t, pose]) => ({ t, pose })),
    ...opts,
  }
}

const cpRaised = (time: number, index = 0): Checkpoint => ({ index, moveIndex: 0, time, target: RAISED, limbs: ['r_upper_arm', 'r_forearm'], resting: [] })

/** Forearm 30° off: upper arm 100, forearm 100 * (60 - 30) / 45. */
const OFF30 = rotJoint(RAISED, 'r_elbow', 'r_wrist', 30)
const OFF30_SCORE = (100 + (100 * 30) / 45) / 2
/** Forearm 40° off: (100 + 100 * 20 / 45) / 2 = 72.2 -> ok. */
const OFF40 = rotJoint(RAISED, 'r_elbow', 'r_wrist', 40)

// --- limb maths ----------------------------------------------------------------------------

describe('limb maths', () => {
  it('maps angular error to 0..100 (100 up to perfectDeg, linear to 0 at zeroDeg)', () => {
    expect(limbScore(0)).toBe(100)
    expect(limbScore(15)).toBe(100)
    expect(limbScore(30)).toBeCloseTo((100 * (60 - 30)) / (60 - 15), 9)
    expect(limbScore(60)).toBe(0)
    expect(limbScore(170)).toBe(0)
    expect(limbScore(30, { ...DEFAULT_SCORING, perfectDeg: 15, zeroDeg: 75 })).toBeCloseTo(75, 9)
    expect(limbScore(Number.NaN)).toBe(0)
  })

  it('scores an identical pose 100 and a 30° forearm error as expected', () => {
    const same = scoreFrame(cpRaised(1), frame(1, RAISED))
    expect(same).toEqual({ score: 100, perLimb: { r_upper_arm: 100, r_forearm: 100 }, unseen: false })
    const off = scoreFrame(cpRaised(1), frame(1, OFF30))
    expect(off.perLimb.r_upper_arm).toBe(100)
    expect(off.perLimb.r_forearm).toBeCloseTo((100 * 30) / 45, 6)
    expect(off.score).toBeCloseTo(OFF30_SCORE, 6)
  })

  it('weights limbs (upper arm 1, shin 0.6)', () => {
    const target = { ...RAISED, r_knee: [0.6, 0.6], r_ankle: [0.6, 1.5] } as Pose2D
    const cp: Checkpoint = { index: 0, moveIndex: 0, time: 0, target, limbs: ['r_upper_arm', 'r_shin'], resting: [] }
    const player = rotJoint(target, 'r_knee', 'r_ankle', 90)
    expect(scoreFrame(cp, frame(0, player)).score).toBeCloseTo(100 / (1 + 0.6), 6) // upper arm 100 (w 1), shin 0 (w 0.6)
  })

  it('excludes limbs with an invisible or missing endpoint; < half usable -> unseen 0', () => {
    // Wrist hidden: the (wrong) forearm doesn't count, the upper arm alone decides.
    const wristHidden = scoreFrame(cpRaised(1), frame(1, OFF40, { ...ALL_VISIBLE, r_wrist: 0.3 }))
    expect(wristHidden).toEqual({ score: 100, perLimb: { r_upper_arm: 100 }, unseen: false })
    // Elbow hidden: both limbs unusable.
    expect(scoreFrame(cpRaised(1), frame(1, RAISED, { ...ALL_VISIBLE, r_elbow: 0.2 }))).toMatchObject({ score: 0, unseen: true })
    // Missing visibility entries count as invisible.
    expect(scoreFrame(cpRaised(1), frame(1, RAISED, {}))).toMatchObject({ score: 0, unseen: true })
    // Missing joint in the pose.
    const noWrist: Pose2D = { ...RAISED }
    delete noWrist.r_wrist
    expect(scoreFrame(cpRaised(1), frame(1, noWrist))).toEqual({ score: 100, perLimb: { r_upper_arm: 100 }, unseen: false })
    const noElbow: Pose2D = { ...RAISED }
    delete noElbow.r_elbow
    expect(scoreFrame(cpRaised(1), frame(1, noElbow))).toMatchObject({ score: 0, unseen: true })
    // No person.
    expect(scoreFrame(cpRaised(1), frame(1, {}, {}, false))).toMatchObject({ score: 0, unseen: true })
    // Exactly half usable is enough (3 of 4 limbs hidden is not).
    const four: Checkpoint = { ...cpRaised(1), target: BOTH_UP, limbs: ['l_upper_arm', 'l_forearm', 'r_upper_arm', 'r_forearm'] }
    expect(scoreFrame(four, frame(1, BOTH_UP, { ...ALL_VISIBLE, l_wrist: 0, l_elbow: 0 })).unseen).toBe(false)
    expect(scoreFrame(four, frame(1, BOTH_UP, { ...ALL_VISIBLE, l_elbow: 0, r_wrist: 0 })).unseen).toBe(true)
  })

  it('lets resting limbs lower the score but never earn it', () => {
    const cp: Checkpoint = { ...cpRaised(1), limbs: ['l_upper_arm', 'l_forearm', 'r_upper_arm', 'r_forearm'], resting: ['l_upper_arm', 'l_forearm'] }
    // Standing still: the left arm matches, the raised right arm doesn't -> 0, not 50.
    expect(scoreFrame(cp, frame(1, N)).score).toBe(0)
    // Right arm right, left arm wrongly up too -> pulled down by the left arm.
    const both = scoreFrame(cp, frame(1, BOTH_UP)).score
    expect(both).toBeLessThan(75)
    expect(both).toBeGreaterThan(0)
    expect(scoreFrame(cp, frame(1, RAISED)).score).toBe(100)
  })

  it('judges by thresholds', () => {
    expect(judge(100)).toBe('perfect')
    expect(judge(DEFAULT_SCORING.thresholds.perfect)).toBe('perfect')
    expect(judge(OFF30_SCORE)).toBe('good')
    expect(judge(60)).toBe('ok')
    expect(judge(10)).toBe('miss')
  })
})

// --- checkpoints ---------------------------------------------------------------------------

describe('buildCheckpoints', () => {
  it('takes on-beat keyframes only, at startTime + t * duration, and skips resting targets', () => {
    // 2 beats over 1 s: t = 0.25 is an off-beat (half beat); t = 0 and 1 are the resting pose.
    const cps = buildCheckpoints({ moves: [move(2, 2, [[0, N], [0.25, RAISED], [0.5, RAISED], [1, N]])] }, 'standing')
    expect(cps).toHaveLength(1)
    expect(cps[0]).toMatchObject({ index: 0, moveIndex: 0, time: 2.5, target: RAISED, limbs: ['r_upper_arm', 'r_forearm'], resting: [] })
  })

  it('keeps holds of a non-resting pose', () => {
    const cps = buildCheckpoints({ moves: [move(0, 4, [[0, N], [0.25, RAISED], [0.5, RAISED], [0.75, RAISED], [1, N]])] }, 'standing')
    expect(cps.map((c) => c.time)).toEqual([0.5, 1, 1.5])
  })

  it("merges a move's t=0 keyframe with the previous move's t=1 keyframe", () => {
    const a = move(0, 2, [[0, N], [0.5, RAISED], [1, RAISED]])
    const b = move(1, 2, [[0, RAISED], [0.5, BOTH_UP], [1, N]], { scoredJoints: ['l_elbow', 'l_wrist', 'r_elbow', 'r_wrist'] })
    const cps = buildCheckpoints({ moves: [a, b] }, 'standing')
    expect(cps.map((c) => [c.time, c.moveIndex])).toEqual([
      [0.5, 0],
      [1, 0],
      [1.5, 1],
    ])
    // The merged checkpoint compares both moves' limbs (the left arm rests there).
    expect(cps[1].limbs).toEqual(['l_upper_arm', 'l_forearm', 'r_upper_arm', 'r_forearm'])
    expect(cps[1].resting).toEqual(['l_upper_arm', 'l_forearm'])
    expect(cps.map((c) => c.index)).toEqual([0, 1, 2])
  })

  it('treats the relaxed "ready" stance as resting', () => {
    // Upper arm 16° and forearm 27° off the resting directions (the library's "ready" anchor).
    const sh = at(N, 'r_shoulder')
    const upper = rot([at(N, 'r_elbow')[0] - sh[0], at(N, 'r_elbow')[1] - sh[1]], 16)
    const fore = rot([at(N, 'r_wrist')[0] - at(N, 'r_elbow')[0], at(N, 'r_wrist')[1] - at(N, 'r_elbow')[1]], 27)
    const elbow: Vec2 = [sh[0] + upper[0], sh[1] + upper[1]]
    const ready: Pose2D = { ...N, r_elbow: elbow, r_wrist: [elbow[0] + fore[0], elbow[1] + fore[1]] }
    expect(buildCheckpoints({ moves: [move(0, 2, [[0, ready], [0.5, ready], [1, ready]])] }, 'standing')).toEqual([])
  })

  it('applies the torso rule (only when the target leans > 10°)', () => {
    const scored: JointName[] = ['r_elbow', 'r_wrist']
    const leaning = buildCheckpoints({ moves: [move(0, 2, [[0.5, lean(RAISED, 20)]], { scoredJoints: scored })] }, 'standing')
    expect(leaning[0].limbs).toEqual(['r_upper_arm', 'r_forearm', 'torso'])
    const upright = buildCheckpoints({ moves: [move(0, 2, [[0.5, lean(RAISED, 5)]], { scoredJoints: scored })] }, 'standing')
    expect(upright[0].limbs).toEqual(['r_upper_arm', 'r_forearm'])
  })

  it('drops legs (and the torso) in seated mode', () => {
    const kneeUp: Pose2D = { ...lean(RAISED, 20), r_knee: [0.6, 0.4], r_ankle: [0.6, 1.3] }
    const scoredJoints: JointName[] = ['r_elbow', 'r_wrist', 'r_knee', 'r_ankle']
    const routine = { moves: [move(0, 2, [[0.5, kneeUp]], { scoredJoints })] }
    expect(buildCheckpoints(routine, 'standing')[0].limbs).toEqual(['r_upper_arm', 'r_forearm', 'r_thigh', 'r_shin', 'torso'])
    expect(buildCheckpoints(routine, 'seated')[0].limbs).toEqual(['r_upper_arm', 'r_forearm'])
    const legsOnly = { moves: [move(0, 2, [[0.5, kneeUp]], { scoredJoints: ['r_knee', 'r_ankle'] })] }
    expect(buildCheckpoints(legsOnly, 'seated')).toEqual([])
  })
})

// --- score keeper --------------------------------------------------------------------------

describe('ScoreKeeper', () => {
  it('takes the best frame within ±windowSec', () => {
    const k = new ScoreKeeper([cpRaised(1)])
    k.addFrame(frame(0.8, RAISED)) // outside the window (perfect, ignored)
    k.addFrame(frame(0.9, OFF30))
    k.addFrame(frame(1.05, RAISED))
    k.addFrame(frame(1.12, OFF40))
    const [r] = k.advanceTo(2)
    expect(k.results()).toHaveLength(1)
    expect(r.score).toBe(100)
    expect(r.judgment).toBe('perfect')
    expect(r.offsetSec).toBeCloseTo(0.05, 9)
    expect(r.unseen).toBeUndefined()

    const k2 = new ScoreKeeper([cpRaised(1)])
    k2.addFrame(frame(0.9, OFF30))
    k2.addFrame(frame(1.2, RAISED)) // outside (and closes the window)
    const [r2] = k2.results()
    expect(r2.score).toBeCloseTo(OFF30_SCORE, 6)
    expect(r2.offsetSec).toBeCloseTo(-0.1, 9)
  })

  it('judges a checkpoint without usable frames as an unseen miss', () => {
    const k = new ScoreKeeper([cpRaised(1), cpRaised(2, 1)])
    k.addFrame(frame(1, RAISED, {}, false))
    const rs = k.advanceTo(3)
    expect(rs.map((r) => [r.score, r.judgment, r.offsetSec, r.unseen])).toEqual([
      [0, 'miss', null, true],
      [0, 'miss', null, true],
    ])
  })

  it('finalizes each checkpoint exactly once, in order, after time + windowSec', () => {
    const k = new ScoreKeeper([cpRaised(3, 2), cpRaised(1, 0), cpRaised(2, 1)])
    expect(k.checkpoints.map((c) => c.time)).toEqual([1, 2, 3])
    expect(k.advanceTo(1.1)).toEqual([])
    expect(k.addFrame(frame(1.1, RAISED))).toEqual([])
    const first = k.addFrame(frame(1.2, RAISED))
    expect(first.map((r) => r.checkpoint.time)).toEqual([1])
    expect(k.advanceTo(1.2)).toEqual([])
    // A late frame for a closed checkpoint changes nothing.
    k.addFrame(frame(1.0, OFF40))
    expect(k.advanceTo(10).map((r) => r.checkpoint.time)).toEqual([2, 3])
    expect(k.advanceTo(Number.POSITIVE_INFINITY)).toEqual([])
    expect(k.advanceTo(Number.NaN)).toEqual([])
    expect(k.results().map((r) => r.checkpoint.time)).toEqual([1, 2, 3])
    expect(k.results()[0].score).toBe(100)
    expect(k.state).toMatchObject({ judged: 3, total: 3 })
  })

  it('counts combo, points and stars', () => {
    expect(comboMultiplier(0)).toBe(1)
    expect(comboMultiplier(10)).toBeCloseTo(1.5, 9)
    expect(comboMultiplier(20)).toBeCloseTo(2, 9)
    expect(comboMultiplier(50)).toBeCloseTo(2, 9)

    const cps = [1, 2, 3, 4, 5].map((t, i) => cpRaised(t, i))
    const k = new ScoreKeeper(cps)
    const poses: (Pose2D | null)[] = [RAISED, RAISED, null, OFF30, OFF40]
    poses.forEach((p, i) => {
      if (p) k.addFrame(frame(i + 1, p))
    })
    k.advanceTo(Number.POSITIVE_INFINITY)
    const rs = k.results()
    expect(rs.map((r) => r.judgment)).toEqual(['perfect', 'perfect', 'miss', 'good', 'ok'])
    expect(rs.map((r) => r.points)).toEqual([100, 105, 0, 70, 42])
    expect(rs.map((r) => r.combo)).toEqual([1, 2, 0, 1, 2])
    const s = k.state
    expect(s).toMatchObject({ score: 317, combo: 2, maxCombo: 2, counts: { perfect: 2, good: 1, ok: 1, miss: 1 }, judged: 5, total: 5 })
    // Stars use base points (100+100+0+70+40), not the combo-boosted score.
    expect(s.stars).toBeCloseTo((5 * 310) / (0.85 * 100 * 5), 9)

    // All perfect: stars cap at 5.
    const k2 = new ScoreKeeper([1, 2, 3].map((t, i) => cpRaised(t, i)))
    for (const t of [1, 2, 3]) k2.addFrame(frame(t, RAISED))
    k2.advanceTo(Number.POSITIVE_INFINITY)
    expect(k2.state.stars).toBe(5)
    expect(new ScoreKeeper([]).state.stars).toBe(0)
  })

  it('summarizes accuracy, per move, and the hardest / best distinct move', () => {
    const fourBeat = (start: number, id: string): Move =>
      move(start, 4, [[0, N], [0.25, RAISED], [0.5, N], [0.75, RAISED], [1, N]], { id, name: id.toUpperCase() })
    const moves = [fourBeat(0, 'a'), fourBeat(2, 'b'), fourBeat(4, 'a'), move(6, 2, [[0, N], [0.5, RAISED], [1, N]], { id: 'c', name: 'C' })]
    const cps = buildCheckpoints({ moves }, 'standing')
    expect(cps.map((c) => c.time)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5])
    const k = new ScoreKeeper(cps)
    for (const cp of cps) {
      const id = moves[cp.moveIndex].id
      k.addFrame(frame(cp.time, id === 'a' ? RAISED : id === 'b' ? OFF40 : N))
    }
    k.advanceTo(Number.POSITIVE_INFINITY)
    const sum = k.summary({ moves })
    const okScore = (100 + (100 * 20) / 45) / 2
    expect(sum.perMove.map((m) => [m.moveIndex, m.id, m.checkpoints])).toEqual([
      [0, 'a', 2],
      [1, 'b', 2],
      [2, 'a', 2],
      [3, 'c', 1],
    ])
    expect(sum.perMove[1].avgScore).toBeCloseTo(okScore, 6)
    expect(sum.accuracy).toBeCloseTo((4 * 100 + 2 * okScore + 0) / 7, 6)
    expect(sum.bestMove).toMatchObject({ id: 'a', name: 'A', moveIndex: 0, checkpoints: 4, avgScore: 100 })
    // c scored 0 but has a single checkpoint, so b is the hardest.
    expect(sum.hardestMove).toMatchObject({ id: 'b', moveIndex: 1, checkpoints: 2 })
    expect(sum.state.judged).toBe(7)

    const empty = new ScoreKeeper([]).summary({ moves: [] })
    expect(empty).toMatchObject({ accuracy: 0, perMove: [], hardestMove: null, bestMove: null })
  })
})
