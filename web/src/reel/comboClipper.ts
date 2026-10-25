// The combo cam: listens to the round's CheckpointResults (classic or v2 scoring) and records
// the camera while the player is on a streak. 3 Good-or-better in a row start a MediaRecorder;
// a streak that breaks before 8 is thrown away; 8 or more is kept, and the recorder stops 1 s
// after the streak ends. At most MAX_CLIPS clips are kept (a stronger one replaces the weakest).
// Clip videos go to a ClipStore (IndexedDB) and never leave the device.

import type { CheckpointResult } from '../game/scoring'
import { addWithCap, averageScore, bestMove, isFreezeMove, MAX_CLIPS } from './clips'
import type { ClipStore } from './clipStore'
import { StreakTracker, type StreakAction } from './streak'
import { isGoodOrBetter, type ClipJudgment, type ClipMeta, type PlayerRoundStats } from './types'

/** Recording continues this long (ms) after a kept streak ends. */
export const TAIL_MS = 1000
/** MediaRecorder timeslice (ms): data arrives in chunks, so a track that dies mid-clip loses little. */
const TIMESLICE_MS = 1000
const VIDEO_BITS_PER_SECOND = 2_000_000

/** The parts of MediaRecorder the clipper uses (a fake in tests). */
export interface RecorderLike {
  readonly state: RecordingState
  start(timesliceMs?: number): void
  stop(): void
  ondataavailable: ((e: { data: Blob }) => void) | null
  onstop: (() => void) | null
}

export type RecorderFactory = (stream: MediaStream, mimeType: string) => RecorderLike

export const mediaRecorderFactory: RecorderFactory = (stream, mimeType) => {
  const r = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: VIDEO_BITS_PER_SECOND })
  const like: RecorderLike = {
    get state() {
      return r.state
    },
    start: (ms) => r.start(ms),
    stop: () => r.stop(),
    ondataavailable: null,
    onstop: null,
  }
  r.ondataavailable = (e) => like.ondataavailable?.(e)
  r.onstop = () => like.onstop?.()
  return like
}

export interface ComboClipperOptions {
  /** Camera (or stage canvas) stream; null records no video but still keeps clip numbers. */
  stream: MediaStream | null
  /** The stream is a selfie camera (the reel shows it mirrored). */
  mirrorVideo?: boolean
  /** routine.moves (index = CheckpointResult.checkpoint.moveIndex). */
  moves: readonly { id: string; name: string }[]
  playerId: string
  playerName: string
  /** Camera + model latency (s), so overlays line up with the video. */
  latencySec: number
  /** Audible song time now. */
  songTime: () => number
  store: ClipStore
  /** null: no MediaRecorder (clips without video). */
  createRecorder: RecorderFactory | null
  mimeType: string
  /** Every kept clip (also ones the cap then drops: the combo still happened). */
  onKeep?: (clip: ClipMeta) => void
  maxClips?: number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  newId?: () => string
}

interface Recording {
  recorder: RecorderLike | null
  chunks: Blob[]
  startSongTime: number
  endSongTime: number | null
  judgments: ClipJudgment[]
  keep: boolean
  timer: unknown
  stopped: Promise<void>
  resolveStopped: () => void
}

let idCounter = 0
const defaultId = (): string => `clip-${Date.now().toString(36)}-${(idCounter++).toString(36)}`

export class ComboClipper {
  private readonly o: ComboClipperOptions
  private readonly tracker = new StreakTracker()
  private streak: ClipJudgment[] = []
  private current: Recording | null = null
  private readonly live = new Set<Recording>()
  private readonly saves = new Set<Promise<void>>()
  private kept: ClipMeta[] = []
  private perfects = 0
  private readonly freezeSums = new Map<number, { sum: number; n: number }>()
  private closed = false

  constructor(o: ComboClipperOptions) {
    this.o = o
  }

  get clips(): readonly ClipMeta[] {
    return this.kept
  }

  get recording(): boolean {
    return this.live.size > 0
  }

  /** A batch of finalized checkpoints (any order within the batch). */
  push(results: readonly CheckpointResult[]): void {
    if (this.closed) return
    const sorted = [...results].sort((a, b) => a.checkpoint.time - b.checkpoint.time)
    for (const r of sorted) this.pushOne(r)
  }

  private pushOne(r: CheckpointResult): void {
    const moveIndex = r.checkpoint.moveIndex
    const move = this.o.moves[moveIndex]
    const moveId = move?.id ?? `move${moveIndex}`
    if (r.judgment === 'perfect' && !r.unseen) this.perfects += 1
    if (isFreezeMove(moveId)) {
      const f = this.freezeSums.get(moveIndex) ?? { sum: 0, n: 0 }
      f.sum += r.score
      f.n += 1
      this.freezeSums.set(moveIndex, f)
    }
    const action = this.tracker.push(r.judgment, r.unseen)
    if (isGoodOrBetter(r.judgment) && !r.unseen) {
      const j: ClipJudgment = { time: r.checkpoint.time, judgment: r.judgment, score: r.score, moveId, moveIndex }
      this.streak.push(j)
      this.current?.judgments.push(j)
    } else {
      this.streak = []
    }
    this.apply(action)
  }

  private apply(action: StreakAction): void {
    if (action.type === 'start') {
      this.current = this.startRecording([...this.streak])
    } else if (action.type === 'discard') {
      const rec = this.current
      this.current = null
      if (rec) this.stopRecording(rec, false)
    } else if (action.type === 'keep') {
      const rec = this.current
      this.current = null
      if (!rec) return
      rec.keep = true
      rec.timer = (this.o.setTimer ?? setTimeout)(() => this.stopRecording(rec, true), TAIL_MS)
    }
  }

  private startRecording(judgments: ClipJudgment[]): Recording {
    let resolveStopped = (): void => {}
    const stopped = new Promise<void>((r) => (resolveStopped = r))
    const rec: Recording = {
      recorder: null,
      chunks: [],
      startSongTime: this.o.songTime(),
      endSongTime: null,
      judgments,
      keep: false,
      timer: null,
      stopped,
      resolveStopped,
    }
    const { stream, createRecorder } = this.o
    if (stream && createRecorder) {
      try {
        const recorder = createRecorder(stream, this.o.mimeType)
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) rec.chunks.push(e.data)
        }
        recorder.onstop = () => rec.resolveStopped()
        recorder.start(TIMESLICE_MS)
        rec.recorder = recorder
      } catch (err) {
        console.warn('Combo cam: could not start recording', err)
      }
    }
    this.live.add(rec)
    return rec
  }

  private stopRecording(rec: Recording, keep: boolean): void {
    if (rec.endSongTime !== null) return
    if (rec.timer !== null) (this.o.clearTimer ?? clearTimeout)(rec.timer as ReturnType<typeof setTimeout>)
    rec.timer = null
    rec.keep = keep
    rec.endSongTime = this.o.songTime()
    const r = rec.recorder
    if (r && r.state !== 'inactive') {
      try {
        r.stop()
      } catch {
        rec.resolveStopped()
      }
    } else {
      rec.resolveStopped()
    }
    const save = rec.stopped.then(() => this.finishRecording(rec))
    this.saves.add(save)
    void save.finally(() => this.saves.delete(save))
  }

  private async finishRecording(rec: Recording): Promise<void> {
    this.live.delete(rec)
    if (!rec.keep || this.closed) return
    const blob = rec.recorder && rec.chunks.length > 0 ? new Blob(rec.chunks, { type: this.o.mimeType || rec.chunks[0].type }) : null
    const meta = this.metaFor(rec, blob)
    this.o.onKeep?.(meta)
    const { clips, dropped } = addWithCap(this.kept, meta, this.o.maxClips ?? MAX_CLIPS)
    this.kept = clips
    try {
      if (dropped && dropped !== meta) await this.o.store.delete(dropped.id)
      if (blob && dropped !== meta) await this.o.store.put(meta.id, blob)
    } catch (err) {
      console.warn('Combo cam: could not store a clip', err)
    }
  }

  private metaFor(rec: Recording, blob: Blob | null): ClipMeta {
    const best = bestMove(rec.judgments)
    const bestMeta = best ? this.o.moves[best.moveIndex] : undefined
    return {
      id: (this.o.newId ?? defaultId)(),
      playerId: this.o.playerId,
      playerName: this.o.playerName,
      startSongTime: rec.startSongTime,
      endSongTime: rec.endSongTime ?? rec.startSongTime,
      videoLatencySec: this.o.latencySec,
      comboLength: rec.judgments.length,
      avgScore: averageScore(rec.judgments),
      bestMoveId: best?.moveId ?? '',
      bestMoveName: bestMeta?.name ?? best?.moveId ?? '',
      judgments: rec.judgments,
      mimeType: blob ? blob.type : '',
      hasVideo: blob !== null,
      mirrorVideo: this.o.mirrorVideo ?? false,
    }
  }

  /** The round's numbers for the awards. */
  stats(): PlayerRoundStats {
    const freezes = [...this.freezeSums].map(([moveIndex, f]) => {
      const m = this.o.moves[moveIndex]
      return { moveId: m?.id ?? '', moveName: m?.name ?? '', avgScore: f.n > 0 ? f.sum / f.n : 0 }
    })
    return { playerId: this.o.playerId, playerName: this.o.playerName, longestCombo: this.tracker.longest, perfects: this.perfects, freezes }
  }

  /** The song ended: a streak of 8+ is kept (stopped now, no tail), every recorder stops. Resolves once clips are stored. */
  async finish(): Promise<void> {
    if (!this.closed) {
      this.apply(this.tracker.end())
      for (const rec of [...this.live]) this.stopRecording(rec, rec.keep)
    }
    while (this.saves.size > 0) await Promise.all([...this.saves])
  }

  /** Stops every recorder and keeps nothing more (the session clears the store). */
  dispose(): void {
    this.closed = true
    this.current = null
    for (const rec of [...this.live]) this.stopRecording(rec, false)
  }
}
