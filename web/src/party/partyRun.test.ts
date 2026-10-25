// Party scoring end to end on a real generated routine: three synthetic dancers stand side by side in
// one fake camera image, MediaPipe-style landmarks go through the single-player normalization, the
// tracker and one keeper each. Every dancer must be scored exactly as if they had played alone.

import { describe, expect, it } from 'vitest'
import type { Routine } from '@shared/routine'
import routineJson from '../game/__fixtures__/routine_synth120_normal.json'
import { BotPoseSource } from '../game/botSource'
import { buildCheckpoints, DEFAULT_SCORING, ScoreKeeper, type Checkpoint, type ScoringConfig } from '../game/scoring'
import { buildMotionTrack } from '../routine/track'
import { AWARD_TITLES, meanAbsOffset, rankParty } from './awards'
import { CALLOUT_MS, classicKeeper, PartyRun, type MakeKeeper } from './partyRun'
import { partyPlayers } from './players'
import { SyntheticPeopleFeed, type SyntheticDancer } from './synthetic'
import { PartyTracker } from './tracker'

const routine = routineJson as unknown as Routine
const track = buildMotionTrack(routine)
const checkpoints = buildCheckpoints(routine, routine.mode)
const FPS = 30

function play(dancers: SyntheticDancer[], makeKeeper: MakeKeeper = classicKeeper) {
  const feed = new SyntheticPeopleFeed(track, dancers)
  const tracker = new PartyTracker(feed, dancers.length)
  tracker.attach()
  let nowMs = 0
  const run = new PartyRun({ tracker, players: partyPlayers(dancers.length), checkpoints, config: DEFAULT_SCORING, makeKeeper, isPlaying: () => true, now: () => nowMs })
  const end = routine.song.durationSec
  const callouts = new Set<number>()
  for (let k = 0; k <= Math.ceil(end * FPS); k++) {
    const t = k / FPS
    nowMs = t * 1000
    feed.emit(t)
    run.tick(t)
    for (const v of run.view()) if (v.callout) callouts.add(v.callout.id)
  }
  return { standings: run.finish(routine, end), callouts, run }
}

/** The same bot dancing alone through the classic single-player path. */
function solo(d: SyntheticDancer, seed: number): number {
  const keeper = new ScoreKeeper(checkpoints, DEFAULT_SCORING)
  const bot = new BotPoseSource({ track, skill: d.skill, seed })
  const end = routine.song.durationSec
  for (let k = 0; k <= Math.ceil(end * FPS); k++) {
    const t = k / FPS
    if (!d.away?.some(([a, b]) => t >= a && t < b)) keeper.addFrame(bot.frameAt(t))
    keeper.advanceTo(t)
  }
  keeper.advanceTo(Number.POSITIVE_INFINITY)
  return keeper.state.score
}

describe('PartyRun', () => {
  const dancers: SyntheticDancer[] = [
    { skill: 'perfect', screenX: 0.2, swayPx: 12 },
    { skill: 'sloppy', screenX: 0.5, swayPx: 12 },
    { skill: 'idle', screenX: 0.8 },
  ]
  const { standings, callouts } = play(dancers)

  it('scores every dancer on their own, identical to a solo run of the same moves', () => {
    expect(standings).toHaveLength(3)
    standings.forEach((s, i) => {
      expect(s.summary.state.total).toBe(checkpoints.length)
      expect(s.summary.state.score).toBe(solo(dancers[i], 11 + i * 7))
    })
    const [good, sloppy, idle] = standings.map((s) => s.summary)
    expect(good.state.counts.perfect).toBeGreaterThan(checkpoints.length * 0.8)
    expect(sloppy.accuracy).toBeLessThan(good.accuracy)
    expect(idle.state.score).toBe(0)
  })

  it('keeps separate combos per dancer', () => {
    const [good, , idle] = standings.map((s) => s.summary.state)
    expect(good.maxCombo).toBeGreaterThan(10)
    expect(idle.maxCombo).toBe(0)
  })

  it('pops a callout per judgment', () => {
    expect(callouts.size).toBeGreaterThan(checkpoints.length * 2)
  })

  it('ranks the podium and hands out titles', () => {
    const placings = rankParty(standings)
    expect(placings.map((p) => p.index)).toEqual([0, 1, 2])
    expect(placings.map((p) => p.rank)).toEqual([1, 2, 3])
    const titles = placings.map((p) => p.awards.map((a) => a.title))
    expect(titles[0]).toContain(AWARD_TITLES.belle)
    expect(titles[0]).toContain(AWARD_TITLES.combo)
    expect(titles[2]).toEqual([AWARD_TITLES.heart])
    expect(placings.flatMap((p) => p.awards).filter((a) => a.id === 'sync')).toHaveLength(1)
  })

  it('a dancer who steps out misses only while away and keeps their slot and score', () => {
    const away: [number, number] = [20, 23]
    const ds: SyntheticDancer[] = [
      { skill: 'perfect', screenX: 0.25 },
      { skill: 'perfect', screenX: 0.75, away: [away] },
    ]
    const { standings: st } = play(ds)
    const [stay, left] = st
    const missesAway = left.results.filter((r) => r.judgment === 'miss' && r.checkpoint.time >= away[0] && r.checkpoint.time < away[1])
    expect(missesAway.length).toBeGreaterThan(0)
    expect(left.summary.state.counts.miss).toBeLessThanOrEqual(missesAway.length + 2)
    expect(left.summary.state.score).toBe(solo(ds[1], 18))
    expect(stay.summary.state.counts.miss).toBeLessThanOrEqual(2)
  })

  it('uses the injected keeper factory (scoring v2 adapter seam)', () => {
    const made: Array<{ n: number; config: ScoringConfig }> = []
    const spy: MakeKeeper = (cps: readonly Checkpoint[], config) => {
      made.push({ n: cps.length, config })
      return new ScoreKeeper(cps, config)
    }
    const feed = new SyntheticPeopleFeed(track, dancers.slice(0, 2))
    const run = new PartyRun({ tracker: new PartyTracker(feed, 2), players: partyPlayers(2), checkpoints, config: DEFAULT_SCORING, makeKeeper: spy, isPlaying: () => true })
    expect(made).toEqual([
      { n: checkpoints.length, config: DEFAULT_SCORING },
      { n: checkpoints.length, config: DEFAULT_SCORING },
    ])
    expect(run.keeper(1)).toBeInstanceOf(ScoreKeeper)
  })

  it('does not score while paused but still tracks who is there', () => {
    const feed = new SyntheticPeopleFeed(track, dancers)
    const tracker = new PartyTracker(feed, 3)
    tracker.attach()
    let nowMs = 0
    const run = new PartyRun({ tracker, players: partyPlayers(3), checkpoints, config: DEFAULT_SCORING, isPlaying: () => false, now: () => nowMs })
    for (let k = 0; k < 300; k++) {
      nowMs = (k / FPS) * 1000
      feed.emit(k / FPS)
      run.tick(0) // the song clock stands still while paused
    }
    const v = run.view()
    expect(v.every((p) => p.seen && p.frame !== null)).toBe(true)
    expect(v.every((p) => p.score === 0 && p.callout === null)).toBe(true)
    expect(run.finish(routine, 1)[0].summary.state.counts.perfect).toBe(0)
    expect(run.finish(routine, 1)).toHaveLength(3) // idempotent
    expect(CALLOUT_MS).toBeGreaterThan(0)
  })
})

describe('rankParty', () => {
  const entry = (score: number, accuracy: number, maxCombo = 0, perfect = 0, offsets: number[] = []) => ({
    summary: {
      state: { score, combo: 0, maxCombo, counts: { perfect, good: 0, ok: 0, miss: 0 }, stars: 0, judged: 0, total: 0 },
      accuracy,
      perMove: [],
      hardestMove: null,
      bestMove: null,
    },
    results: offsets.map((o) => ({ offsetSec: o, judgment: 'good' as const })),
  })

  it('ties share a rank and a title', () => {
    const p = rankParty([entry(500, 80), entry(500, 80), entry(100, 20)])
    expect(p.map((x) => x.rank)).toEqual([1, 1, 3])
    expect(p.filter((x) => x.awards.some((a) => a.id === 'belle'))).toHaveLength(2)
  })

  it('nobody is Belle of an empty ball; everyone is still someone', () => {
    const p = rankParty([entry(0, 0), entry(0, 0)])
    expect(p.every((x) => x.awards.map((a) => a.id).join() === 'heart')).toBe(true)
  })

  it('Most in Sync goes to the smallest mean timing error, not the top score', () => {
    const p = rankParty([entry(900, 90, 0, 0, [0.1, -0.1, 0.1, -0.1]), entry(800, 85, 0, 0, [0.02, -0.01, 0.02, 0.01])])
    const sync = p.find((x) => x.awards.some((a) => a.id === 'sync'))
    expect(sync?.index).toBe(1)
    expect(sync?.syncMs).toBeCloseTo(15)
    expect(meanAbsOffset([{ offsetSec: 0.1, judgment: 'good' }])).toBeNull()
  })
})
