import { describe, expect, it } from 'vitest'
import { flowReducer, needsCalibration, type FlowEvent, type Phase } from './flow'

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
    for (const p of ['generating', 'calibration', 'warmup', 'game', 'results'] satisfies Phase[]) {
      expect(flowReducer(p, { type: 'exit' })).toBe('lobby')
    }
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
