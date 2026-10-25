// End-to-end scoring simulation: bots dance real generated routines (fixtures saved from
// POST /api/choreograph for synth_120bpm.wav, normal, seed 1; the *_aist / *_mix ones with
// moveSource "aist" / "mix") and must land in fair bands.
// Time advances in 1/60 s steps: bot.tick(t) (frames -> keeper.addFrame) then keeper.advanceTo(t).

import { describe, expect, it } from 'vitest'
import type { Routine } from '@shared/routine'
import { buildMotionTrack } from '../routine/track'
import standingJson from './__fixtures__/routine_synth120_normal.json'
import aistStandingJson from './__fixtures__/routine_synth120_normal_aist.json'
import aistSeatedJson from './__fixtures__/routine_synth120_normal_aist_seated.json'
import mixStandingJson from './__fixtures__/routine_synth120_normal_mix.json'
import seatedJson from './__fixtures__/routine_synth120_normal_seated.json'
import { BotPoseSource, type BotSkill } from './botSource'
import { JUDGING_PRESETS, scoringFor } from './judging'
import { buildCheckpoints, DEFAULT_SCORING, ScoreKeeper, type Judgment, type ResultsSummary, type ScoringConfig } from './scoring'

const ROUTINES: Record<string, Routine> = {
  standing: standingJson as unknown as Routine,
  seated: seatedJson as unknown as Routine,
}

interface SimResult {
  summary: ResultsSummary
  /** Fraction of checkpoints per judgment. */
  frac: Record<Judgment, number>
}

function simulate(routine: Routine, skill: BotSkill, lagSec = 0, seed = 1, config: ScoringConfig = DEFAULT_SCORING): SimResult {
  const keeper = new ScoreKeeper(buildCheckpoints(routine, routine.mode), config)
  const bot = new BotPoseSource({ track: buildMotionTrack(routine), skill, lagSec, seed })
  bot.onFrame((f) => keeper.addFrame(f))
  void bot.start()
  const steps = Math.ceil((routine.song.durationSec + 1) * 60)
  for (let i = 0; i <= steps; i++) {
    const t = i / 60
    bot.tick(t)
    keeper.advanceTo(t)
  }
  keeper.advanceTo(Number.POSITIVE_INFINITY)
  const summary = keeper.summary(routine)
  const { counts, total } = summary.state
  const frac = { perfect: counts.perfect / total, good: counts.good / total, ok: counts.ok / total, miss: counts.miss / total }
  return { summary, frac }
}

const pct = (x: number): string => `${(100 * x).toFixed(0)}%`.padStart(5)

const CASES: { skill: BotSkill; lagSec: number }[] = [
  { skill: 'perfect', lagSec: 0 },
  { skill: 'perfect', lagSec: 0.1 },
  { skill: 'good', lagSec: 0 },
  { skill: 'sloppy', lagSec: 0 },
  { skill: 'idle', lagSec: 0 },
  { skill: 'mirrored', lagSec: 0 },
]

describe.each(Object.entries(ROUTINES))('bot simulation: %s routine', (mode, routine) => {
  const results = new Map<string, SimResult>()
  const run = (skill: BotSkill, lagSec = 0, seed = 1): SimResult => {
    const key = `${skill}/${lagSec}/${seed}`
    const hit = results.get(key)
    if (hit) return hit
    const r = simulate(routine, skill, lagSec, seed)
    results.set(key, r)
    return r
  }

  it('prints the judgment table', () => {
    const lines = [`${mode}: ${buildCheckpoints(routine, routine.mode).length} checkpoints, ${routine.moves.length} moves`]
    lines.push('skill       lag   perfect  good    ok  miss  accuracy  stars  maxCombo')
    for (const { skill, lagSec } of CASES) {
      const { summary: s, frac } = run(skill, lagSec)
      lines.push(
        `${skill.padEnd(10)} ${lagSec.toFixed(1).padStart(4)}  ${pct(frac.perfect)}  ${pct(frac.good)} ${pct(frac.ok)} ${pct(frac.miss)}  ${s.accuracy.toFixed(1).padStart(8)}  ${s.state.stars.toFixed(2).padStart(5)}  ${String(s.state.maxCombo).padStart(8)}`,
      )
    }
    console.log(lines.join('\n'))
    expect(results.size).toBe(CASES.length)
  })

  for (const seed of [1, 2, 3]) {
    it(`meets the fairness bands (seed ${seed})`, () => {
      const perfect = run('perfect', 0, seed)
      expect(perfect.frac.perfect).toBeGreaterThanOrEqual(0.95)

      // Late by 0.1 s: the ±windowSec best-match absorbs it.
      expect(run('perfect', 0.1, seed).frac.perfect).toBeGreaterThanOrEqual(0.9)

      const good = run('good', 0, seed)
      expect(good.frac.perfect + good.frac.good).toBeGreaterThanOrEqual(0.9)
      expect(good.frac.perfect).toBeGreaterThan(0.5)

      // ~30° per limb: a real mix, mostly below perfect, rarely a miss.
      const sloppy = run('sloppy', 0, seed)
      expect(sloppy.frac.perfect).toBeLessThan(0.5)
      expect(sloppy.frac.good + sloppy.frac.ok + sloppy.frac.miss).toBeGreaterThan(0.5)
      expect(sloppy.frac.good).toBeGreaterThan(0.15)
      expect(sloppy.frac.ok).toBeGreaterThan(0.1)
      expect(sloppy.summary.accuracy).toBeLessThan(good.summary.accuracy - 8)
      // Five stars are earned by dancing well, not by a long sloppy combo.
      expect(good.summary.state.stars).toBeGreaterThanOrEqual(4.9)
      expect(sloppy.summary.state.stars).toBeLessThan(4.7)
      expect(sloppy.summary.state.stars).toBeGreaterThan(3)

      // Standing still never earns points.
      const idle = run('idle', 0, seed)
      expect(idle.frac.miss).toBeGreaterThanOrEqual(0.9)
      expect(idle.summary.state.stars).toBeLessThan(1)

      // Dancing the wrong side is clearly worse than a decent attempt.
      const mirrored = run('mirrored', 0, seed)
      expect(mirrored.summary.accuracy).toBeLessThan(60)
      expect(mirrored.summary.accuracy).toBeLessThan(good.summary.accuracy - 30)
      expect(mirrored.summary.state.stars).toBeLessThan(3)
    })
  }

  it('names a hardest and a best move for a sloppy run', () => {
    const { summary } = run('sloppy')
    expect(summary.bestMove).not.toBeNull()
    expect(summary.hardestMove).not.toBeNull()
    expect(summary.bestMove?.avgScore ?? 0).toBeGreaterThan(summary.hardestMove?.avgScore ?? 100)
    expect(summary.perMove.reduce((n, m) => n + m.checkpoints, 0)).toBe(summary.state.total)
  })
})

// Judging presets (lobby: Lenient / Standard / Strict): every preset keeps the core fairness
// invariants; Lenient helps a sloppy dancer, Strict asks more of them.
describe.each(Object.entries(ROUTINES))('judging presets: %s routine', (mode, routine) => {
  const SKILLS: BotSkill[] = ['perfect', 'good', 'sloppy', 'idle', 'mirrored']
  const table = new Map<string, SimResult>()
  const run = (preset: (typeof JUDGING_PRESETS)[number]['value'], skill: BotSkill, seed = 1, lagSec = 0): SimResult => {
    const key = `${preset}/${skill}/${seed}/${lagSec}`
    const hit = table.get(key)
    if (hit) return hit
    const r = simulate(routine, skill, lagSec, seed, scoringFor(preset))
    table.set(key, r)
    return r
  }

  it('prints the per-preset table', () => {
    const lines = [`${mode}: judging presets (seed 1)`, 'preset    skill      perfect  good    ok  miss  accuracy  stars']
    for (const { value } of JUDGING_PRESETS) {
      for (const skill of SKILLS) {
        const { summary: s, frac } = run(value, skill)
        lines.push(
          `${value.padEnd(9)} ${skill.padEnd(9)}  ${pct(frac.perfect)}  ${pct(frac.good)} ${pct(frac.ok)} ${pct(frac.miss)}  ${s.accuracy.toFixed(1).padStart(8)}  ${s.state.stars.toFixed(2).padStart(5)}`,
        )
      }
    }
    console.log(lines.join('\n'))
    expect(table.size).toBe(JUDGING_PRESETS.length * SKILLS.length)
  })

  for (const seed of [1, 2, 3]) {
    it(`keeps the invariants on every preset (seed ${seed})`, () => {
      for (const { value } of JUDGING_PRESETS) {
        const idle = run(value, 'idle', seed)
        expect(idle.frac.miss, `${value} idle miss`).toBeGreaterThanOrEqual(0.9)
        expect(idle.summary.state.stars, `${value} idle stars`).toBeLessThan(0.5)
        const perfect = run(value, 'perfect', seed)
        expect(perfect.frac.perfect, `${value} perfect`).toBeGreaterThanOrEqual(0.95)
        // A late camera within the window still counts.
        expect(run(value, 'perfect', seed, 0.1).frac.perfect, `${value} perfect +0.1 s`).toBeGreaterThanOrEqual(0.9)
        const mirrored = run(value, 'mirrored', seed)
        expect(mirrored.summary.state.stars, `${value} mirrored stars`).toBeLessThan(3.5)
      }
      const sloppy = (p: (typeof JUDGING_PRESETS)[number]['value']): SimResult => run(p, 'sloppy', seed)
      expect(sloppy('lenient').summary.accuracy).toBeGreaterThan(sloppy('standard').summary.accuracy + 5)
      expect(sloppy('lenient').summary.state.stars).toBeGreaterThan(sloppy('standard').summary.state.stars)
      expect(sloppy('strict').summary.accuracy).toBeLessThan(sloppy('standard').summary.accuracy)
      expect(run('strict', 'good', seed).frac.perfect).toBeLessThan(run('standard', 'good', seed).frac.perfect)
    })
  }
})

// Real-dancer routines (moveSource "aist" / "mix", same song, normal, seed 1; Stage 8). The core
// fairness rules hold on every preset: standing still never scores (the clips have subtle poses,
// arms low and loose, which buildCheckpoints' REST_PROOF rule keeps out of the judging), a clean
// dancer is perfect, a late camera within the window still counts, and judging presets keep their
// order. The wrong-side band is relative here: the classic fixtures' absolute "< 60%" is tuned on
// the classic library's sided moves, while real dancers move both arms alike more often and keep
// moving through the beat, so a mirrored dancer matches more checkpoints. It must still trail a
// decent attempt clearly and stay off five stars.
const REAL_DANCER_ROUTINES: Record<string, Routine> = {
  'aist standing': aistStandingJson as unknown as Routine,
  'aist seated': aistSeatedJson as unknown as Routine,
  'mix standing': mixStandingJson as unknown as Routine,
}

describe.each(Object.entries(REAL_DANCER_ROUTINES))('real-dancer routine: %s', (_name, routine) => {
  const table = new Map<string, SimResult>()
  const run = (preset: (typeof JUDGING_PRESETS)[number]['value'], skill: BotSkill, seed = 1, lagSec = 0): SimResult => {
    const key = `${preset}/${skill}/${seed}/${lagSec}`
    const hit = table.get(key)
    if (hit) return hit
    const r = simulate(routine, skill, lagSec, seed, scoringFor(preset))
    table.set(key, r)
    return r
  }

  it('is a real-dancer routine with enough checkpoints', () => {
    expect(routine.meta?.aistMoves).toBeGreaterThan(5)
    expect(buildCheckpoints(routine, routine.mode).length).toBeGreaterThan(60)
  })

  for (const seed of [1, 2]) {
    it(`keeps the fairness invariants on every preset (seed ${seed})`, () => {
      for (const { value } of JUDGING_PRESETS) {
        const idle = run(value, 'idle', seed)
        expect(idle.frac.miss, `${value} idle miss`).toBeGreaterThanOrEqual(0.9)
        expect(idle.summary.state.stars, `${value} idle stars`).toBeLessThan(0.5)
        expect(run(value, 'perfect', seed).frac.perfect, `${value} perfect`).toBeGreaterThanOrEqual(0.95)
        expect(run(value, 'perfect', seed, 0.1).frac.perfect, `${value} perfect +0.1 s`).toBeGreaterThanOrEqual(0.9)
      }
      const good = run('standard', 'good', seed)
      expect(good.frac.perfect + good.frac.good).toBeGreaterThanOrEqual(0.9)
      expect(good.summary.state.stars).toBeGreaterThanOrEqual(4.9)
      const sloppy = (p: (typeof JUDGING_PRESETS)[number]['value']): SimResult => run(p, 'sloppy', seed)
      expect(sloppy('standard').summary.accuracy).toBeLessThan(good.summary.accuracy - 8)
      expect(sloppy('lenient').summary.accuracy).toBeGreaterThan(sloppy('standard').summary.accuracy)
      expect(sloppy('strict').summary.accuracy).toBeLessThan(sloppy('standard').summary.accuracy)
      const mirrored = run('standard', 'mirrored', seed)
      expect(mirrored.summary.accuracy).toBeLessThan(good.summary.accuracy - 20)
      expect(mirrored.summary.state.stars).toBeLessThan(4)
    })
  }
})
