import { describe, expect, it } from 'vitest'
import { flowReducer, isRunning, needsCalibration, type FlowEvent, type Phase } from './flow'

const run = (events: FlowEvent[], from: Phase = 'lobby'): Phase => events.reduce(flowReducer, from)

describe('play flow', () => {
  it('lobby -> generating -> calibration -> warmup -> game -> results', () => {
    const seen: Phase[] = []
    let p: Phase = 'lobby'
    for (const e of [
      { type: 'generate' },
      { type: 'prepared', calibrate: true },
      { type: 'calibrated' },
      { type: 'ready' },
      { type: 'finished' },
    ] satisfies FlowEvent[]) {
      p = flowReducer(p, e)
      seen.push(p)
    }
    expect(seen).toEqual(['generating', 'calibration', 'warmup', 'game', 'results'])
  })

  it('skips calibration when told to', () => {
    expect(run([{ type: 'generate' }, { type: 'prepared', calibrate: false }])).toBe('warmup')
  })

  it('results -> Play again waits for the camera, New routine generates', () => {
    expect(flowReducer('results', { type: 'replay' })).toBe('warmup')
    expect(flowReducer('results', { type: 'generate' })).toBe('generating')
    expect(flowReducer('results', { type: 'exit' })).toBe('lobby')
  })

  it('ignores events that arrive in the wrong phase (late async callbacks)', () => {
    expect(flowReducer('lobby', { type: 'ready' })).toBe('lobby')
    expect(flowReducer('lobby', { type: 'prepared', calibrate: true })).toBe('lobby')
    expect(flowReducer('warmup', { type: 'calibrated' })).toBe('warmup')
    expect(flowReducer('calibration', { type: 'finished' })).toBe('calibration')
    expect(flowReducer('game', { type: 'calibrated' })).toBe('game')
    expect(flowReducer('lobby', { type: 'replay' })).toBe('lobby')
    // A second "ready" (double begin) doesn't leave the results.
    expect(run([{ type: 'finished' }, { type: 'ready' }], 'game')).toBe('results')
  })

  it('Esc goes to the lobby from anywhere', () => {
    for (const p of ['generating', 'calibration', 'warmup', 'preview', 'practice', 'ready', 'game', 'results'] satisfies Phase[]) {
      expect(flowReducer(p, { type: 'exit' })).toBe('lobby')
    }
  })
})

describe('before the ball', () => {
  const trace = (events: FlowEvent[]): Phase[] => {
    const seen: Phase[] = []
    events.reduce<Phase>((p, e) => {
      const next = flowReducer(p, e)
      seen.push(next)
      return next
    }, 'lobby')
    return seen
  }

  it('watch first: lobby -> generating -> preview -> ready -> calibration -> warmup -> game -> results', () => {
    expect(
      trace([
        { type: 'generate' },
        { type: 'prepared', calibrate: true, rehearsal: 'watch' },
        { type: 'rehearsed' },
        { type: 'play', calibrate: true },
        { type: 'calibrated' },
        { type: 'ready' },
        { type: 'finished' },
      ]),
    ).toEqual(['generating', 'preview', 'ready', 'calibration', 'warmup', 'game', 'results'])
  })

  it('watch first with autoplay / a calibrated dancer: no calibration before the real round', () => {
    expect(run([{ type: 'generate' }, { type: 'prepared', calibrate: false, rehearsal: 'watch' }, { type: 'rehearsed' }, { type: 'play', calibrate: false }])).toBe(
      'warmup',
    )
  })

  it('practice run: calibration -> practice -> ready -> straight into the game (same camera)', () => {
    expect(
      trace([
        { type: 'generate' },
        { type: 'prepared', calibrate: true, rehearsal: 'practice' },
        { type: 'calibrated' },
        { type: 'ready', practice: true },
        { type: 'rehearsed' },
        { type: 'play', calibrate: false },
        { type: 'ready' },
        { type: 'finished' },
      ]),
    ).toEqual(['generating', 'calibration', 'warmup', 'practice', 'ready', 'warmup', 'game', 'results'])
  })

  it('skip ends a preview / practice run; again loops back', () => {
    expect(flowReducer('preview', { type: 'rehearsed' })).toBe('ready')
    expect(flowReducer('practice', { type: 'rehearsed' })).toBe('ready')
    expect(flowReducer('ready', { type: 'watch' })).toBe('preview')
    expect(run([{ type: 'replay' }, { type: 'ready', practice: true }], 'ready')).toBe('practice')
  })

  it('a practice camera that fails can fall back to watching', () => {
    expect(flowReducer('calibration', { type: 'watch' })).toBe('preview')
    expect(flowReducer('warmup', { type: 'watch' })).toBe('preview')
  })

  it('ignores rehearsal events out of place', () => {
    expect(flowReducer('game', { type: 'rehearsed' })).toBe('game')
    expect(flowReducer('game', { type: 'watch' })).toBe('game')
    expect(flowReducer('preview', { type: 'play', calibrate: true })).toBe('preview')
    expect(flowReducer('preview', { type: 'finished' })).toBe('preview')
    expect(flowReducer('practice', { type: 'finished' })).toBe('practice')
    expect(flowReducer('preview', { type: 'ready' })).toBe('preview')
    expect(flowReducer('lobby', { type: 'rehearsed' })).toBe('lobby')
    // "Just play" ignores the rehearsal field entirely.
    expect(run([{ type: 'generate' }, { type: 'prepared', calibrate: true, rehearsal: 'none' }])).toBe('calibration')
  })

  it('isRunning', () => {
    expect((['game', 'preview', 'practice'] satisfies Phase[]).every(isRunning)).toBe(true)
    expect((['lobby', 'ready', 'warmup', 'results'] satisfies Phase[]).some(isRunning)).toBe(false)
  })
})

describe('needsCalibration', () => {
  it('only for a fresh webcam dancer who did not opt out', () => {
    expect(needsCalibration({ autoplay: false, skipCalibration: false, calibrated: false })).toBe(true)
    expect(needsCalibration({ autoplay: true, skipCalibration: false, calibrated: false })).toBe(false)
    expect(needsCalibration({ autoplay: false, skipCalibration: true, calibrated: false })).toBe(false)
    expect(needsCalibration({ autoplay: false, skipCalibration: false, calibrated: true })).toBe(false)
  })
})
