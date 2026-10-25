// End-to-end scoring simulation: bots dance real generated routines (fixtures saved from
// POST /api/choreograph for synth_120bpm.wav, normal, seed 1) and must land in fair bands.
// Time advances in 1/60 s steps: bot.tick(t) (frames -> keeper.addFrame) then keeper.advanceTo(t).

import { describe, expect, it } from 'vitest'
import type { Routine } from '@shared/routine'
import { buildMotionTrack } from '../routine/track'
import seatedJson from './__fixtures__/routine_synth120_normal_seated.json'
import standingJson from './__fixtures__/routine_synth120_normal.json'
import { BotPoseSource, type BotSkill } from './botSource'
import { buildCheckpoints, DEFAULT_SCORING, ScoreKeeper, type Judgment, type ResultsSummary } from './scoring'

const ROUTINES: Record<string, Routine> = {
  standing: standingJson as unknown as Routine,
  seated: seatedJson as unknown as Routine,
}

interface SimResult {
  summary: ResultsSummary
  /** Fraction of checkpoints per judgment. */
  frac: Record<Judgment, number>
}

function simulate(routine: Routine, skill: BotSkill, lagSec = 0, seed = 1): SimResult {
  const keeper = new ScoreKeeper(buildCheckpoints(routine, routine.mode), DEFAULT_SCORING)
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
