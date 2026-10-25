// The bridge between a room and the game page (pages/Play.tsx calls these; see the integration
// notes). The lobby counts 5-4-3-2-1 to the room's startAt, then opens the play URL; Play strips
// the query, so the round also lives in sessionStorage. Every device starts the song together at
// startAt + ROUND_LEAD_MS (time to load the routine, the audio and the camera), reports its live
// score at most once a second, and posts the final score with finished: true.

import { useEffect } from 'react'
import { isRoutineId } from '../lib/hashRoute'
import { useLatest } from '../lib/useLatest'
import type { ResultsSummary, ScoreKeeper } from '../game/scoring'
import { loadSeat, roomWrites, type ScoreBody } from './client'

/** From GO (startAt) to the song start on every device: loading the routine, the audio and the camera model. */
export const ROUND_LEAD_MS = 10_000
/** A stored round older than this is ignored (the server ends rounds 10 min after startAt). */
const ROUND_MAX_AGE_MS = 15 * 60 * 1000
const ROUND_KEY = 'dance-fantasy.room.round'

export interface RoomRound {
  code: string
  routineId: string
  /** server startAt (identifies the round) */
  serverStartAt: number
  /** local epoch ms of GO */
  startAt: number
  /** local epoch ms at which every device begins the song (count-in) */
  songAt: number
  /** the final score was posted */
  done: boolean
}

export const roomPlayHash = (routineId: string, code: string): string => `#/play?routine=${routineId}&room=${code}`

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function isRound(v: unknown): v is RoomRound {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.code === 'string' &&
    isRoutineId(r.routineId) &&
    typeof r.serverStartAt === 'number' &&
    typeof r.startAt === 'number' &&
    typeof r.songAt === 'number' &&
    typeof r.done === 'boolean'
  )
}

export function storedRound(now = Date.now()): RoomRound | null {
  try {
    const raw = session()?.getItem(ROUND_KEY)
    const v: unknown = raw ? JSON.parse(raw) : null
    return isRound(v) && now - v.startAt < ROUND_MAX_AGE_MS ? v : null
  } catch {
    return null
  }
}

function storeRound(r: RoomRound | null): void {
  try {
    if (r) session()?.setItem(ROUND_KEY, JSON.stringify(r))
    else session()?.removeItem(ROUND_KEY)
  } catch {
    // ponytail: without sessionStorage the game plays solo (no gate, no score posts)
  }
}

/** Remembers the round and opens the game on it (called by the lobby at GO). */
export function beginRoomRound(o: { code: string; routineId: string; serverStartAt: number; startAt: number }): void {
  storeRound({ ...o, songAt: o.startAt + ROUND_LEAD_MS, done: false })
  window.location.hash = roomPlayHash(o.routineId, o.code)
}

/** The live room round for this routine, or null (solo play, another routine, finished, stale). */
export function roomRoundFor(routineId: unknown, includeDone = false): RoomRound | null {
  const r = storedRound()
  return r && routineId === r.routineId && (includeDone || !r.done) ? r : null
}

/** A room round is on (not finished on this device): Play skips rehearsal and calibration for it. */
export const inRoomRound = (): boolean => roomRoundFor(storedRound()?.routineId) !== null

/** Resolves when this routine's room round starts the song (right away for solo play or when late). */
export function waitForRoomStart(routineId: unknown): Promise<void> {
  const wait = (roomRoundFor(routineId)?.songAt ?? 0) - Date.now()
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve()
}

// --- scores ---

export interface ScoreReporter {
  /** Latest numbers; sent at most once per gap (trailing), a finished score right away. */
  report(s: ScoreBody): void
  cancel(): void
}

const FINISH_TRIES = 3

/** Throttles posts to one per `gapMs` (the last value wins); retries the finished post. */
export function createScoreReporter(send: (s: ScoreBody) => Promise<unknown>, gapMs = 1000): ScoreReporter {
  let last = Number.NEGATIVE_INFINITY
  let pending: ScoreBody | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  // One post at a time, in order: the server keeps the last score it receives, so a live post
  // still in flight must not land after the finished one.
  let chain: Promise<void> = Promise.resolve()
  const post = (s: ScoreBody, triesLeft: number): void => {
    last = Date.now()
    chain = chain.then(
      () =>
        send(s).then(
          () => undefined,
          (err: unknown) => {
            console.warn('room score not sent', err)
            if (s.finished && triesLeft > 1) setTimeout(() => post(s, triesLeft - 1), gapMs)
          },
        ),
    )
  }
  const flush = (): void => {
    timer = undefined
    const s = pending
    pending = null
    if (s) post(s, FINISH_TRIES)
  }
  return {
    report(s) {
      if (closed) return
      pending = s
      if (s.finished) {
        closed = true
        clearTimeout(timer)
        flush()
      } else if (timer === undefined) {
        timer = setTimeout(flush, Math.max(0, last + gapMs - Date.now()))
      }
    },
    cancel() {
      closed = true
      clearTimeout(timer)
      timer = undefined
      pending = null
    },
  }
}

let current: { key: string; reporter: ScoreReporter } | null = null

/**
 * Posts the score of the current room round for `routineId` (no-op outside one), throttled to
 * once a second. `finished: true` posts right away and closes the round.
 */
export function reportScore(routineId: unknown, s: ScoreBody): void {
  const round = roomRoundFor(routineId)
  const seat = round ? loadSeat(round.code) : null
  if (!round || !seat) return
  const key = `${round.code}:${round.serverStartAt}`
  if (current?.key !== key) {
    current?.reporter.cancel()
    current = { key, reporter: createScoreReporter((body) => roomWrites.score(round.code, seat.token, body)) }
  }
  current.reporter.report(s)
  if (s.finished) storeRound({ ...round, done: true })
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** The live numbers of a scored run (accuracy = mean checkpoint score so far, like the results screen). */
export function liveScore(keeper: Pick<ScoreKeeper, 'state' | 'results'>, songTime: number, durationSec: number): ScoreBody {
  const { score, combo, maxCombo } = keeper.state
  const done = keeper.results()
  const accuracy = done.length > 0 ? done.reduce((sum, r) => sum + r.score, 0) / done.length : 0
  return { score, combo, maxCombo, accuracy: Math.min(100, Math.max(0, accuracy)), progress: clamp01(songTime / durationSec), finished: false }
}

/** The round's final score (call once with the results summary). */
export function finishRoomRound(routineId: unknown, summary: ResultsSummary): void {
  const { score, combo, maxCombo } = summary.state
  reportScore(routineId, { score, combo, maxCombo, accuracy: Math.min(100, Math.max(0, summary.accuracy)), progress: 1, finished: true })
}

export interface LiveSample {
  keeper: Pick<ScoreKeeper, 'state' | 'results'>
  songTime: number
  durationSec: number
}

/** While a room round of `routineId` is on, samples the run once a second and reports it. */
export function useRoomReporter(routineId: unknown, sample: () => LiveSample | null): void {
  const sampleRef = useLatest(sample)
  const inRound = roomRoundFor(routineId) !== null
  useEffect(() => {
    if (!inRound) return
    const id = setInterval(() => {
      const s = sampleRef.current()
      if (s) reportScore(routineId, liveScore(s.keeper, s.songTime, s.durationSec))
    }, 1000)
    return () => clearInterval(id)
  }, [inRound, routineId, sampleRef])
}
