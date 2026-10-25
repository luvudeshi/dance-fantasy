// Scoring v2 vs classic on the bot simulation (same fixtures and stepping as scoring.sim.test.ts),
// plus unit checks of the v2 pieces and the scorer selector.

import { describe, expect, it } from 'vitest'
import type { Routine } from '@shared/routine'
import { JOINTS, type JointName } from '@shared/skeleton'
import { buildMotionTrack } from '../../routine/track'
import seatedJson from '../__fixtures__/routine_synth120_normal_seated.json'
import standingJson from '../__fixtures__/routine_synth120_normal.json'
import { BotPoseSource, perturbPose, type BotSkill } from '../botSource'
import { createScoreKeeper, scoringVersion, SCORING_STORAGE_KEY } from '../createScoreKeeper'
import type { PlayerFrame } from '../poseSource'
import { RELAXED_SCORING } from '../judging'
import { buildCheckpoints, DEFAULT_SCORING, ScoreKeeper, type Judgment, type ResultsSummary, type ScoringConfig } from '../scoring'
import { DEFAULT_V2, LimbCarry, ScoreKeeperV2, timingFactor, type CheckpointResultV2 } from '.'

const ROUTINES: Record<string, Routine> = {
  standing: standingJson as unknown as Routine,
  seated: seatedJson as unknown as Routine,
}

/** Deterministic uniform [0, 1) from integers (mulberry-style hash). */
function rand(seed: number, a: number, b: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(b ^ 0x165667b1, 0x27d4eb2f)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

const ARMS: JointName[][] = [
  ['l_elbow', 'l_wrist'],
  ['r_elbow', 'r_wrist'],
  ['l_wrist'],
  ['r_wrist'],
]

/** ±jitterDeg uniform per limb per frame, plus motion-blur dropouts of an arm's joints for 1-3 frames. */
function noisy(seed: number, jitterDeg: number, dropoutRate: number): (f: PlayerFrame, k: number) => PlayerFrame {
  let dropUntil = -1
  let dropped: JointName[] = []
  return (f, k) => {
    const angles = Array.from({ length: 9 }, (_, i) => ((rand(seed, k, i) * 2 - 1) * jitterDeg * Math.PI) / 180)
    const visibility = { ...f.visibility }
    if (k > dropUntil && rand(seed, k, 99) < dropoutRate) {
      dropUntil = k + Math.floor(rand(seed, k, 98) * 3)
      dropped = ARMS[Math.floor(rand(seed, k, 97) * ARMS.length)]
    }
    if (k <= dropUntil) for (const j of dropped) visibility[j] = 0.1
    return { ...f, pose: perturbPose(f.pose, angles), visibility }
  }
}

interface Case {
  name: string
  skill: BotSkill
  lagSec?: number
  noiseDeg?: number
  transform?: (seed: number) => (f: PlayerFrame, k: number) => PlayerFrame
}

const CASES: Record<string, Case> = {
  idle: { name: 'standing still', skill: 'idle' },
  flail: { name: 'random flailing', skill: 'idle', noiseDeg: 140 },
  perfect: { name: 'perfect', skill: 'perfect' },
  good: { name: 'good (~12°)', skill: 'good' },
  sloppy: { name: 'sloppy (~30°)', skill: 'sloppy' },
  // Webcam-like: ~20° of slowly drifting error, ±20° per-frame jitter on top, and 1-3 frame blur
  // dropouts of an arm's joints on ~20% of frames.
  noisy: { name: "correct + ±20° jitter + blur", skill: "good", noiseDeg: 25, transform: (s) => noisy(s, 20, 0.2) },
  late: { name: 'correct, 120 ms late', skill: 'perfect', lagSec: 0.12 },
  mirrored: { name: 'wrong side', skill: 'mirrored' },
  // A hard real-webcam night: ~30° of drift, ±20° jitter, blur dropouts and 150 ms late.
  rough: { name: 'rough webcam, 150 ms late', skill: 'sloppy', lagSec: 0.15, transform: (s) => noisy(s, 20, 0.2) },
  // Catching up: correct moves, but 300 ms (0.6 beat at 120 bpm) behind.
  delayed: { name: 'good, 300 ms late', skill: 'good', lagSec: 0.3 },
}

interface Sim {
  v2: ResultsSummary
  classic: ResultsSummary
  frac: Record<Judgment, number>
  classicFrac: Record<Judgment, number>
  results: CheckpointResultV2[]
}

const fracOf = (s: ResultsSummary): Record<Judgment, number> => {
  const { counts, total } = s.state
  return { perfect: counts.perfect / total, good: counts.good / total, ok: counts.ok / total, miss: counts.miss / total }
}

function simulate(routine: Routine, c: Case, seed = 1, config: ScoringConfig = DEFAULT_SCORING): Sim {
  const track = buildMotionTrack(routine)
  const keeper = new ScoreKeeperV2(buildCheckpoints(routine, routine.mode), config, { track })
  const bot = new BotPoseSource({ track, skill: c.skill, lagSec: c.lagSec ?? 0, noiseDeg: c.noiseDeg, seed })
  const tf = c.transform?.(seed)
  let k = 0
  bot.onFrame((f) => keeper.addFrame(tf ? tf(f, k++) : f))
  void bot.start()
  const steps = Math.ceil((routine.song.durationSec + 1) * 60)
  for (let i = 0; i <= steps; i++) {
    bot.tick(i / 60)
    keeper.advanceTo(i / 60)
  }
  keeper.advanceTo(Number.POSITIVE_INFINITY)
  const shadow = keeper.shadow as ScoreKeeper
  const v2 = keeper.summary(routine)
  const classic = shadow.summary(routine)
  return { v2, classic, frac: fracOf(v2), classicFrac: fracOf(classic), results: keeper.results() }
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`.padStart(4)
const goodPlus = (f: Record<Judgment, number>): number => f.perfect + f.good

describe.each(Object.entries(ROUTINES))('scoring v2 simulation: %s routine', (mode, routine) => {
  const cache = new Map<string, Sim>()
  const run = (key: keyof typeof CASES, seed = 1): Sim => {
    const id = `${key}/${seed}`
    const hit = cache.get(id) ?? simulate(routine, CASES[key], seed)
    cache.set(id, hit)
    return hit
  }

  it('prints the classic vs v2 table', () => {
    const lines = [`${mode}: classic vs v2 (seed 1)   P/G/O/M = perfect/good/ok/miss`, 'case                           classic P/G/O/M    acc |   v2 P/G/O/M    acc  late-tags']
    for (const key of Object.keys(CASES) as (keyof typeof CASES)[]) {
      const r = run(key)
      const f = (x: Record<Judgment, number>): string => `${pct(x.perfect)}${pct(x.good)}${pct(x.ok)}${pct(x.miss)}`
      const late = r.results.filter((x) => x.timing === 'late').length / r.results.length
      lines.push(
        `${CASES[key].name.padEnd(30)} ${f(r.classicFrac)} ${r.classic.accuracy.toFixed(1).padStart(6)} | ${f(r.frac)} ${r.v2.accuracy.toFixed(1).padStart(6)}  ${pct(late)}`,
      )
    }
    console.log(lines.join('\n'))
    expect(cache.size).toBe(Object.keys(CASES).length)
  })

  for (const seed of [1, 2, 3]) {
    it(`standing still scores mostly Miss (seed ${seed})`, () => {
      const r = run('idle', seed)
      expect(r.frac.miss).toBeGreaterThanOrEqual(0.9)
      expect(r.v2.state.stars).toBeLessThan(1)
    })

    it(`random flailing scores low (seed ${seed})`, () => {
      const r = run('flail', seed)
      expect(r.frac.miss).toBeGreaterThanOrEqual(0.6)
      expect(goodPlus(r.frac)).toBeLessThan(0.25)
      expect(r.v2.accuracy).toBeLessThan(55)
      expect(r.v2.state.stars).toBeLessThan(2)
    })

    it(`a noisy, blurry but correct performance scores mostly Good+ and beats classic (seed ${seed})`, () => {
      const r = run('noisy', seed)
      expect(goodPlus(r.frac)).toBeGreaterThanOrEqual(0.8)
      expect(r.v2.accuracy).toBeGreaterThan(r.classic.accuracy + 2)
      expect(r.frac.perfect).toBeGreaterThan(r.classicFrac.perfect + 0.1)
    })

    it(`a correct performance 120 ms late is Good+, tagged Late (seed ${seed})`, () => {
      const r = run('late', seed)
      expect(goodPlus(r.frac)).toBeGreaterThanOrEqual(0.9)
      const late = r.results.filter((x) => x.timing === 'late').length
      const early = r.results.filter((x) => x.timing === 'early').length
      expect(late / r.results.length).toBeGreaterThanOrEqual(0.6)
      expect(early).toBeLessThan(late / 4)
      // On time: (almost) no tags and full timing.
      const onTime = run('perfect', seed)
      expect(onTime.results.filter((x) => x.timing).length / onTime.results.length).toBeLessThan(0.2)
      expect(onTime.frac.perfect).toBeGreaterThanOrEqual(0.9)
    })

    it(`dancing the wrong side is still clearly worse than a good attempt (seed ${seed})`, () => {
      expect(run('mirrored', seed).v2.accuracy).toBeLessThan(run('good', seed).v2.accuracy - 20)
    })
  }

  it('scores the movement, not only the pose at the beat', () => {
    // A "statue" jumps straight to each checkpoint's pose right after the previous beat and holds
    // it: a perfect pose at every beat but none of the coach's movement in between.
    const track = buildMotionTrack(routine)
    const cps = buildCheckpoints(routine, routine.mode)
    const keeper = new ScoreKeeperV2(cps, DEFAULT_SCORING, { track })
    const visibility = Object.fromEntries(JOINTS.map((j) => [j, 1])) as Record<JointName, number>
    let c = 0
    for (let k = 0; k <= Math.ceil((routine.song.durationSec + 1) * 30); k++) {
      const t = k / 30
      while (c < cps.length && cps[c].time < t - 0.05) c++
      const pose = c < cps.length ? cps[c].target : track.sample(t).pose
      keeper.addFrame({ songTime: t, pose, visibility, valid: true })
    }
    keeper.advanceTo(Number.POSITIVE_INFINITY)
    const statue = keeper.summary(routine).accuracy
    const classicStatue = (keeper.shadow as ScoreKeeper).summary(routine).accuracy
    const perfect = run('perfect').v2.accuracy
    console.log(`${mode}: pose-only "statue" accuracy  classic ${classicStatue.toFixed(1)}  v2 ${statue.toFixed(1)}  (perfect dancer v2 ${perfect.toFixed(1)})`)
    expect(classicStatue).toBeGreaterThan(95)
    expect(statue).toBeLessThan(perfect - 6)
    expect(statue).toBeLessThan(classicStatue - 6)
    expect(keeper.results().every((r) => r.v2 === undefined || r.v2.path !== null)).toBe(true)
  })

  it('the motion bonus only ever adds, and never past 100', () => {
    for (const key of ['good', 'sloppy', 'noisy'] as const) {
      for (const r of run(key).results) {
        if (!r.v2) continue
        expect(r.score).toBeLessThanOrEqual(100)
        expect(r.score + 1e-9).toBeGreaterThanOrEqual(r.v2.raw * r.v2.timingFactor)
      }
    }
    expect(run('good').results.some((r) => (r.v2?.bonus.direction ?? 0) > 0)).toBe(true)
  })
})

describe.each(Object.entries(ROUTINES))('Relaxed preset (v2): %s routine', (mode, routine) => {
  const cache = new Map<string, Sim>()
  const run = (key: keyof typeof CASES, relaxed: boolean, seed = 1): Sim => {
    const id = `${key}/${relaxed}/${seed}`
    const hit = cache.get(id) ?? simulate(routine, CASES[key], seed, relaxed ? RELAXED_SCORING : DEFAULT_SCORING)
    cache.set(id, hit)
    return hit
  }

  it('prints the Standard v2 vs Relaxed v2 table', () => {
    const lines = [`${mode}: v2 Standard vs v2 Relaxed (seed 1)`, 'case                           standard P/G/O/M   acc |  relaxed P/G/O/M   acc  tried']
    const f = (x: Record<Judgment, number>): string => `${pct(x.perfect)}${pct(x.good)}${pct(x.ok)}${pct(x.miss)}`
    for (const key of Object.keys(CASES) as (keyof typeof CASES)[]) {
      const a = run(key, false)
      const b = run(key, true)
      const tried = b.results.filter((r) => r.v2?.tried).length / b.results.length
      lines.push(`${CASES[key].name.padEnd(30)} ${f(a.frac)} ${a.v2.accuracy.toFixed(1).padStart(5)} | ${f(b.frac)} ${b.v2.accuracy.toFixed(1).padStart(5)}  ${pct(tried)}`)
    }
    console.log(lines.join('\n'))
    expect(cache.size).toBe(2 * Object.keys(CASES).length)
  })

  for (const seed of [1, 2, 3]) {
    it(`still never rewards standing still or flailing (seed ${seed})`, () => {
      const idle = run('idle', true, seed)
      expect(idle.frac.miss).toBeGreaterThanOrEqual(0.9)
      expect(idle.v2.state.stars).toBeLessThan(1)
      // Relaxed trades some flailing credit for forgiveness: still well below a real attempt.
      const flail = run('flail', true, seed)
      expect(flail.frac.miss).toBeGreaterThanOrEqual(0.3)
      expect(goodPlus(flail.frac)).toBeLessThan(0.55)
      expect(flail.v2.accuracy).toBeLessThan(run('sloppy', true, seed).v2.accuracy - 25)
    })

    it(`is easier than Standard on hard nights, wrong side included (seed ${seed})`, () => {
      for (const key of ['sloppy', 'noisy', 'rough'] as const) {
        expect(run(key, true, seed).v2.accuracy, key).toBeGreaterThanOrEqual(run(key, false, seed).v2.accuracy)
      }
      const rough = run('rough', true, seed)
      expect(rough.frac.miss).toBeLessThan(0.1)
      expect(rough.frac.miss).toBeLessThan(run('rough', false, seed).frac.miss + 1e-9)
      expect(goodPlus(rough.frac)).toBeGreaterThan(goodPlus(run('rough', false, seed).frac))
      // The wrong side earns mirrorCredit (85%) of a hit on Relaxed: rarely a miss, never top marks.
      const mirrored = run('mirrored', true, seed)
      expect(mirrored.frac.miss).toBeLessThan(0.1)
      expect(mirrored.v2.accuracy).toBeLessThan(run('good', true, seed).v2.accuracy - 8)
      expect(mirrored.v2.accuracy).toBeGreaterThan(run('mirrored', false, seed).v2.accuracy + 20)
    })

    it(`a move 300 ms late still scores, a little lower than on time (seed ${seed})`, () => {
      const late = run('delayed', true, seed)
      expect(late.frac.miss).toBeLessThan(0.1)
      expect(goodPlus(late.frac)).toBeGreaterThanOrEqual(0.8)
      expect(late.v2.accuracy).toBeLessThan(run('good', true, seed).v2.accuracy)
      expect(late.results.filter((r) => r.timing === 'late').length / late.results.length).toBeGreaterThanOrEqual(0.6)
      // Standard v2 catches up too (up to half a beat), just less generously.
      expect(run('delayed', false, seed).v2.accuracy).toBeLessThan(late.v2.accuracy)
    })
  }
})

describe('scoring v2 pieces', () => {
  it('late catch-up: lateness past 150 ms falls linearly to lateMinFactor at the late edge', () => {
    expect(timingFactor(0.15, DEFAULT_V2, 0.5)).toBeCloseTo(0.85, 5)
    expect(timingFactor(0.325, DEFAULT_V2, 0.5)).toBeCloseTo((0.85 + DEFAULT_V2.lateMinFactor) / 2, 5)
    expect(timingFactor(0.5, DEFAULT_V2, 0.5)).toBeCloseTo(DEFAULT_V2.lateMinFactor, 5)
    // Early stays quadratic.
    expect(timingFactor(-0.15, DEFAULT_V2, 0.5)).toBeCloseTo(0.85, 5)
  })

  it('timing factor: full on the beat, ~85% at ±150 ms', () => {
    expect(timingFactor(0)).toBe(1)
    expect(timingFactor(0.15)).toBeCloseTo(0.85, 5)
    expect(timingFactor(-0.15)).toBeCloseTo(0.85, 5)
    expect(timingFactor(Number.NaN)).toBe(DEFAULT_V2.timingMinFactor)
  })

  it('gaussian falloff keeps near-misses generous and never hits a hard zero', async () => {
    const { limbScoreV2 } = await import('.')
    const c = { ...DEFAULT_V2, falloff: 'gaussian' as const, perfectDeg: 28, gaussianSigmaDeg: 24 }
    expect(limbScoreV2(28, c)).toBe(100)
    expect(limbScoreV2(48, c)).toBeGreaterThan(65)
    expect(limbScoreV2(90, c)).toBeGreaterThan(0)
    expect(limbScoreV2(90, c)).toBeLessThan(5)
    expect(limbScoreV2(48, DEFAULT_V2)).toBeLessThan(limbScoreV2(48, c))
  })

  it('mirrorDirs swaps sides and flips x; Foreshortening drops limbs pointing at the camera', async () => {
    const { mirrorDirs, Foreshortening } = await import('.')
    expect(mirrorDirs({ l_forearm: [1, 2], torso: [0.5, -1] })).toEqual({ r_forearm: [-1, 2], torso: [-0.5, -1] })
    const f = new Foreshortening(0.4)
    expect(f.apply({ l_forearm: [0.3, 0] }).l_forearm).toBeDefined()
    expect(f.apply({ l_forearm: [0.1, 0] }).l_forearm).toBeUndefined()
    expect(f.apply({ l_forearm: [0, 0.2] }).l_forearm).toBeDefined()
    expect(new Foreshortening(0).apply({ l_forearm: [0.01, 0] }).l_forearm).toBeDefined()
  })

  it('carries a limb through a dropout of up to 100 ms only', () => {
    const carry = new LimbCarry(0.1)
    carry.apply(1, { l_forearm: [1, 0] })
    expect(carry.apply(1.08, {}).l_forearm).toEqual([1, 0])
    expect(carry.apply(1.15, {}).l_forearm).toBeUndefined()
  })

  it('a signature checkpoint (multiplier 2) scores double', () => {
    const routine = ROUTINES.standing
    const [cp] = buildCheckpoints(routine, routine.mode)
    const pointsFor = (multiplier?: number): number | undefined => {
      const k = new ScoreKeeperV2([{ ...cp, ...(multiplier ? { multiplier } : {}) }], DEFAULT_SCORING, { shadow: false })
      k.addFrame({ songTime: cp.time, pose: cp.target, visibility: Object.fromEntries(JOINTS.map((j) => [j, 1])), valid: true })
      const [r] = k.advanceTo(cp.time + 1)
      expect(r.judgment).toBe('perfect')
      return r.points
    }
    const single = pointsFor()
    expect(single).toBeGreaterThan(0)
    expect(pointsFor(2)).toBe(2 * (single ?? 0))
  })

  it('a frame is unseen only when every hero limb is missing', () => {
    const routine = ROUTINES.standing
    const cps = buildCheckpoints(routine, routine.mode)
    const k = new ScoreKeeperV2(cps.slice(0, 1), DEFAULT_SCORING, { shadow: false })
    const cp = k.checkpoints[0]
    const hero = k.heroes[0]
    const visibility = Object.fromEntries(JOINTS.map((j) => [j, 1])) as Record<JointName, number>
    // Hide everything but one hero limb's joints: still seen.
    const keep = new Set<string>(['l_shoulder', 'r_shoulder', 'l_hip', 'r_hip', 'l_elbow', 'r_elbow', 'l_wrist', 'r_wrist', 'l_knee', 'r_knee', 'l_ankle', 'r_ankle'])
    for (const j of JOINTS) if (!keep.has(j)) visibility[j] = 0
    k.addFrame({ songTime: cp.time, pose: cp.target, visibility, valid: true })
    const [r] = k.advanceTo(cp.time + 1)
    expect(hero.length).toBeGreaterThan(0)
    expect(r.unseen).toBeUndefined()
    expect(r.judgment).toBe('perfect')
    // Nothing visible: unseen miss.
    const k2 = new ScoreKeeperV2(cps.slice(0, 1), DEFAULT_SCORING, { shadow: false })
    k2.addFrame({ songTime: cp.time, pose: cp.target, visibility: {}, valid: true })
    const [r2] = k2.advanceTo(cp.time + 1)
    expect(r2.unseen).toBe(true)
    expect(r2.judgment).toBe('miss')
  })
})

describe('createScoreKeeper', () => {
  const store = (v: string | null) => ({ getItem: (key: string) => (key === SCORING_STORAGE_KEY ? v : null) })

  it('defaults to classic; ?scoring=v2 (search or hash route) or localStorage selects v2', () => {
    expect(scoringVersion({ search: '', hash: '#/play' }, store(null))).toBe('classic')
    expect(scoringVersion({ search: '', hash: '#/play?scoring=v2' }, store(null))).toBe('v2')
    expect(scoringVersion({ search: '?scoring=v2', hash: '' }, store(null))).toBe('v2')
    expect(scoringVersion({ search: '', hash: '#/play' }, store('v2'))).toBe('v2')
    expect(scoringVersion({ search: '', hash: '#/play?scoring=classic' }, store('v2'))).toBe('classic')
    expect(scoringVersion(null, null)).toBe('classic')
  })

  it('always uses v2 for the Relaxed preset', () => {
    const cps = buildCheckpoints(ROUTINES.standing, 'standing')
    expect(createScoreKeeper(cps, RELAXED_SCORING, null, 'classic')).toBeInstanceOf(ScoreKeeperV2)
  })

  it('returns the matching keeper', () => {
    const cps = buildCheckpoints(ROUTINES.standing, 'standing')
    expect(createScoreKeeper(cps, DEFAULT_SCORING, null, 'classic')).toBeInstanceOf(ScoreKeeper)
    expect(createScoreKeeper(cps, DEFAULT_SCORING, null, 'v2')).toBeInstanceOf(ScoreKeeperV2)
  })
})

describe('HUD timing tags', () => {
  it('shows EARLY / LATE next to a v2 judgment, nothing for classic results', async () => {
    const { Hud } = await import('../hud')
    const cp = buildCheckpoints(ROUTINES.standing, 'standing')[0]
    const hud = new Hud({ autoplay: false })
    const state = new ScoreKeeper([cp]).state
    hud.push([{ checkpoint: cp, score: 90, judgment: 'good', offsetSec: 0.1, perLimb: {}, timing: 'late' } as CheckpointResultV2], state, 0)
    hud.push([{ checkpoint: cp, score: 90, judgment: 'good', offsetSec: 0, perLimb: {} }], state, 10)
    const pops = hud.view(20).pops
    expect(pops.map((p) => p.tag)).toEqual(['LATE', undefined])
  })
})
