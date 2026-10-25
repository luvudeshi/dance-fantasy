// Test helpers: CheckpointResults from a judgment string, a fake MediaRecorder, a fake stream.

import type { CheckpointResult, Judgment } from '../game/scoring'
import type { RecorderFactory, RecorderLike } from './comboClipper'

const CODES: Record<string, Judgment> = { P: 'perfect', G: 'good', O: 'ok', M: 'miss' }
const SCORES: Record<Judgment, number> = { perfect: 95, good: 80, ok: 60, miss: 10 }

/** "PPGGM" -> one result per letter, 0.5 s apart from t0, move i = floor(index / perMove). */
export function results(pattern: string, opts: { t0?: number; dt?: number; perMove?: number; score?: (i: number, j: Judgment) => number } = {}): CheckpointResult[] {
  const { t0 = 10, dt = 0.5, perMove = 4 } = opts
  return [...pattern].map((c, i) => {
    const judgment = CODES[c]
    if (!judgment) throw new Error(`bad code ${c}`)
    return {
      checkpoint: { index: i, moveIndex: Math.floor(i / perMove), time: t0 + i * dt, target: {}, limbs: [] },
      score: opts.score?.(i, judgment) ?? SCORES[judgment],
      judgment,
      offsetSec: 0,
      perLimb: {},
    }
  })
}

export class FakeRecorder implements RecorderLike {
  state: RecordingState = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  readonly mimeType: string
  constructor(mimeType: string) {
    this.mimeType = mimeType
  }
  start(): void {
    this.state = 'recording'
  }
  /** A chunk of fake video. */
  emit(bytes = 100): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) })
  }
  stop(): void {
    if (this.state === 'inactive') return
    this.emit(10)
    this.state = 'inactive'
    queueMicrotask(() => this.onstop?.())
  }
}

export function fakeRecorders(): { factory: RecorderFactory; made: FakeRecorder[] } {
  const made: FakeRecorder[] = []
  return {
    made,
    factory: (_stream, mime) => {
      const r = new FakeRecorder(mime)
      made.push(r)
      return r
    },
  }
}

/** Stands in for a camera MediaStream (the clipper only hands it to the recorder factory). */
export const fakeStream = (): MediaStream => ({ id: 'fake-stream', getTracks: () => [], getVideoTracks: () => [] }) as unknown as MediaStream
