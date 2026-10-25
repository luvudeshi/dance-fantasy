import { describe, expect, it } from 'vitest'
import type { Routine } from '@shared/routine'
import standingJson from './__fixtures__/routine_synth120_normal.json'
import { scoringFor } from './judging'
import { buildCheckpoints, ScoreKeeper, type CheckpointResult } from './scoring'
import { buildSessionLog, sessionLogFilename, SESSION_LOG_FORMAT } from './sessionLog'

const routine = standingJson as unknown as Routine

function roundOf(): { results: CheckpointResult[]; keeper: ScoreKeeper } {
  const keeper = new ScoreKeeper(buildCheckpoints(routine, routine.mode), scoringFor('lenient'))
  keeper.advanceTo(Number.POSITIVE_INFINITY) // nobody danced: all unseen misses
  return { results: keeper.results(), keeper }
}

describe('session log', () => {
  it('records settings, calibration, judging and one row per checkpoint', () => {
    const { results, keeper } = roundOf()
    const log = buildSessionLog({
      routine,
      title: 'Synth 120',
      durationSec: 30.1234,
      autoplay: false,
      calibration: { latencySec: 0.1234, source: 'measured' },
      preset: 'lenient',
      config: keeper.config,
      summary: keeper.summary(routine),
      results,
      now: new Date('2026-10-25T01:02:03.456Z'),
    })
    expect(log.format).toBe(SESSION_LOG_FORMAT)
    expect(log.createdAt).toBe('2026-10-25T01:02:03.456Z')
    expect(log.settings).toEqual({ difficulty: routine.difficulty, mode: routine.mode, seed: routine.seed, autoplay: false })
    expect(log.calibration).toEqual({ latencyMs: 123, source: 'measured' })
    expect(log.judging.preset).toBe('lenient')
    expect(log.judging.windowSec).toBe(0.2)
    expect(log.checkpoints).toHaveLength(results.length)
    expect(log.summary.checkpoints).toBe(results.length)
    const row = log.checkpoints[0]
    expect(row).toEqual({
      index: 0,
      time: Math.round(results[0].checkpoint.time * 1000) / 1000,
      moveIndex: results[0].checkpoint.moveIndex,
      moveId: routine.moves[results[0].checkpoint.moveIndex].id,
      score: 0,
      judgment: 'miss',
      offsetMs: null,
      perLimb: {},
      unseen: true,
    })
  })

  it('carries no poses (only numbers about the round)', () => {
    const { results, keeper } = roundOf()
    const log = buildSessionLog({
      routine,
      title: 't',
      durationSec: 1,
      autoplay: true,
      calibration: null,
      preset: 'standard',
      config: keeper.config,
      summary: keeper.summary(routine),
      results,
    })
    const json = JSON.stringify(log)
    expect(json).not.toMatch(/"(target|pose|keyframes|l_wrist|nose)"/)
    expect(log.calibration).toBeNull()
  })

  it('names the file after the routine and time', () => {
    expect(sessionLogFilename({ routineId: '0123456789abcdef', createdAt: '2026-10-25T01:02:03.456Z' })).toBe(
      'midnight-ball-session-0123456789abcdef-20261025-010203.json',
    )
    expect(sessionLogFilename({ routineId: null, createdAt: '2026-10-25T01:02:03.456Z' })).toBe('midnight-ball-session-local-20261025-010203.json')
  })
})
