// The play screen's phases as a tiny state machine: lobby -> generating -> calibration ->
// warmup (camera ready?) -> game -> results. Events that don't apply to the current phase are
// ignored, so a late async callback (a camera that opens after Esc) can't drag the screen back.
//
// "Before the ball" rehearsals:
//   Watch first:  generating -> preview (music + coach, no camera, no score) -> ready ->
//                 [Play for real] calibration? -> warmup -> game -> results
//   Practice run: generating -> calibration? -> warmup -> practice (camera + judgments, no
//                 score) -> ready -> [Play for real] warmup -> game (same camera) -> results
// "ready" is the "Ready to dance?" card; Watch / Practice again loop back from it.

import type { Rehearsal } from './rehearsal'

export type Phase = 'lobby' | 'generating' | 'calibration' | 'warmup' | 'preview' | 'practice' | 'ready' | 'game' | 'results'

export type FlowEvent =
  /** Lobby Start, or New routine from the results / an error. */
  | { type: 'generate' }
  /** The routine + audio are ready. */
  | { type: 'prepared'; calibrate: boolean; rehearsal?: Rehearsal }
  /** Calibration finished or skipped (K / Skip). */
  | { type: 'calibrated' }
  /** The pose source is running: the count-in starts (a practice run or the real game). */
  | { type: 'ready'; practice?: boolean }
  /** The song ended. */
  | { type: 'finished' }
  /** The preview / practice run ended or was skipped ("Skip → I'm ready"). */
  | { type: 'rehearsed' }
  /** Watch (again): the preview, also instead of a practice run whose camera failed. */
  | { type: 'watch' }
  /** "Play for real" from the ready card. */
  | { type: 'play'; calibrate: boolean }
  /** Play again (same routine) / Practice again: wait for the camera again. */
  | { type: 'replay' }
  | { type: 'exit' }

export function flowReducer(phase: Phase, e: FlowEvent): Phase {
  switch (e.type) {
    case 'generate':
      return 'generating'
    case 'prepared':
      if (phase !== 'generating') return phase
      if (e.rehearsal === 'watch') return 'preview'
      return e.calibrate ? 'calibration' : 'warmup'
    case 'calibrated':
      return phase === 'calibration' ? 'warmup' : phase
    case 'ready':
      return phase === 'warmup' ? (e.practice ? 'practice' : 'game') : phase
    case 'finished':
      return phase === 'game' ? 'results' : phase
    case 'rehearsed':
      return phase === 'preview' || phase === 'practice' ? 'ready' : phase
    case 'watch':
      return phase === 'ready' || phase === 'calibration' || phase === 'warmup' ? 'preview' : phase
    case 'play':
      return phase === 'ready' ? (e.calibrate ? 'calibration' : 'warmup') : phase
    case 'replay':
      return phase === 'results' || phase === 'game' || phase === 'ready' ? 'warmup' : phase
    case 'exit':
      return 'lobby'
  }
}

/** Phases where the song plays with the coach on stage (Space pauses, R restarts). */
export const isRunning = (p: Phase): boolean => p === 'game' || p === 'preview' || p === 'practice'

export interface CalibrationNeed {
  autoplay: boolean
  /** The lobby's "Skip calibration". */
  skipCalibration: boolean
  /** Already calibrated in this visit (Play again / New routine keep the same dancer). */
  calibrated: boolean
}

/** Calibrate only a fresh webcam dancer who didn't opt out. */
export function needsCalibration(o: CalibrationNeed): boolean {
  return !o.autoplay && !o.skipCalibration && !o.calibrated
}

/** The teach page for a routine, optionally starting at a move: "#/teach?routine=<id>[&start=<i>]". */
export function teachHash(routineId: string, start?: number): string {
  const s = start !== undefined && Number.isInteger(start) && start > 0 ? `&start=${start}` : ''
  return `#/teach?routine=${routineId}${s}`
}
