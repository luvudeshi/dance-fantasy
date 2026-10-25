// Batches the game's per-beat judgements to POST /api/rooms/{code}/beats about once a second
// (gameLink.reportRoomBeat feeds it). stop() (await it) sends what is left; the final `finished: true`
// score must go after it, so the last beats land first (shared/README.md, "Beats").

import { ApiError } from '../../api'
import { GRADES, MAX_BEAT, MAX_BEATS_PER_POST, type BeatJudgement, type Grade } from './api'

export interface BeatReporterOptions {
  /** posts one batch, e.g. roomWrites.beats(code, token, batch) */
  send: (beats: readonly BeatJudgement[]) => Promise<unknown>
  intervalMs?: number
}

export class BeatReporter {
  private readonly send: BeatReporterOptions['send']
  private readonly intervalMs: number
  private queue: BeatJudgement[] = []
  private readonly seen = new Set<number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<void> | null = null
  private dead = false

  constructor(opts: BeatReporterOptions) {
    this.send = opts.send
    this.intervalMs = opts.intervalMs ?? 1000
  }

  /** Queue one judgement. Same beat twice keeps the first (like the server); bad input is ignored. */
  reportBeat(beat: number, score: number, grade: Grade): void {
    if (this.dead || !Number.isInteger(beat) || beat < 0 || beat > MAX_BEAT || !Number.isFinite(score)) return
    if (!GRADES.includes(grade) || this.seen.has(beat)) return
    this.seen.add(beat)
    this.queue.push({ beat, score: Math.round(Math.min(100, Math.max(0, score)) * 10) / 10, grade })
  }

  get pending(): number {
    return this.queue.length
  }

  start(): void {
    if (this.timer !== null || this.dead) return
    this.timer = setInterval(() => void this.flush(), this.intervalMs)
  }

  /** Send everything queued (64 a call). One flush at a time; a failed batch is retried on the next. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** Stop the timer and send what is left. Await it before the final score post. */
  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    await this.flush()
    if (this.queue.length > 0) await this.flush() // beats reported while the last flush was in flight
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.dead) {
      const batch = this.queue.slice(0, MAX_BEATS_PER_POST)
      try {
        await this.send(batch)
        this.queue = this.queue.slice(batch.length)
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
          // no longer a player of this room (left, or it expired): nothing will ever be accepted
          console.warn('[rooms] beats dropped: seat gone', err)
          this.dead = true
          this.queue = []
        } else if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          console.warn('[rooms] beats batch rejected', err)
          this.queue = this.queue.slice(batch.length)
        } else {
          console.warn('[rooms] beats post failed; retrying next second', err)
          return
        }
      }
    }
  }
}
