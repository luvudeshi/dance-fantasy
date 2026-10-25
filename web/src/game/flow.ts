// The play screen's phases as a tiny state machine: lobby -> generating -> calibration ->
// warmup (camera ready?) -> game -> results. Events that don't apply to the current phase are
// ignored, so a late async callback (a camera that opens after Esc) can't drag the screen back.

export type Phase = 'lobby' | 'generating' | 'calibration' | 'warmup' | 'game' | 'results'

export type FlowEvent =
  /** Lobby Start, or New routine from the results / an error. */
  | { type: 'generate' }
  /** The routine + audio are ready. */
  | { type: 'prepared'; calibrate: boolean }
  /** Calibration finished or skipped (K / Skip). */
  | { type: 'calibrated' }
  /** The pose source is running: the count-in starts. */
  | { type: 'ready' }
  /** The song ended. */
  | { type: 'finished' }
  /** Play again (same routine): wait for the camera again. */
  | { type: 'replay' }
  | { type: 'exit' }

export function flowReducer(phase: Phase, e: FlowEvent): Phase {
  switch (e.type) {
    case 'generate':
      return 'generating'
    case 'prepared':
      return phase === 'generating' ? (e.calibrate ? 'calibration' : 'warmup') : phase
    case 'calibrated':
      return phase === 'calibration' ? 'warmup' : phase
    case 'ready':
      return phase === 'warmup' ? 'game' : phase
    case 'finished':
      return phase === 'game' ? 'results' : phase
    case 'replay':
      return phase === 'results' || phase === 'game' ? 'warmup' : phase
    case 'exit':
      return 'lobby'
  }
}

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
