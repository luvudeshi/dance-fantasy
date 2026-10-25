// Teach mode, the pure parts (unit-tested): the routine cut into 8-counts, the loop around one
// (a "5 6 7 8" count-in, then the 8-count), scoring a pass at slow speed, the pass history and
// when to suggest the next speed.
//
// Scoring at speed: the music (and every checkpoint) runs `rate` times slower, but the player's
// timing slack and the camera latency are real-time quantities, so both cover `x rate` of song
// time: windowSec * rate and latencySec * rate.

import type { Routine } from '@shared/routine'
import { beatIndexAt } from '../audio/clock'
import { beatPeriod, sectionAt } from './cues'
import { TEACH_RATES, type TeachRate } from './mediaClock'
import type { PlayerFrame } from './poseSource'
import { FRAME_STALL_SEC, scoringHorizon } from './run'
import { DEFAULT_SCORING, ScoreKeeper, type Checkpoint, type CheckpointResult, type ScoringConfig } from './scoring'

/** Beats in a teach segment ("an 8-count" = 2 bars of 4/4). */
export const COUNT_BEATS = 8
/** Count-in beats before each pass ("5 6 7 8"). */
export const COUNT_IN_BEATS = 4
/** Each pass starts this many beats before the first count-in beat (the seek never cuts the "5"). */
export const LOOP_PREROLL_BEATS = 0.5
/** Real seconds after the last checkpoint's window (+ latency) before the loop jumps back. */
export const LOOP_TAIL_SEC = 0.15
/** A pass at or above this accuracy (%) counts toward the next speed. */
export const PASS_ACCURACY = 80
/** Consecutive good passes that unlock the next speed (or "Nailed it!" at 1x). */
export const PASSES_TO_ADVANCE = 2
/** Pass history kept on screen. */
export const MAX_HISTORY = 12

const EPS = 0.02

export interface CountInBeat {
  time: number
  /** "5" | "6" | "7" | "8" (the dance-teacher count into "1"). */
  label: string
}

export interface TeachSegment {
  index: number
  /** Song time of the 8-count's "1" (a move start). */
  start: number
  /** Song time where it ends (the next segment's start, or the last move's end). */
  end: number
  /** Index into song.beats of the "1". */
  startBeat: number
  /** Exclusive: beats startBeat..endBeat-1 lie inside. */
  endBeat: number
  /** The count-in beats before `start` (never before 0 s; extrapolated before the first beat). */
  countIn: CountInBeat[]
  /** Where every pass starts: a little before the first count-in beat, >= 0. */
  loopStart: number
  /** Section label at the start (intro | verse | chorus | bridge | outro). */
  section: string
  /** 1-based bar numbers covered. */
  barStart: number
  barEnd: number
  moveIndices: number[]
  /** Distinct move names, in order. */
  moveNames: string[]
  /** "Chorus · bars 9–10". */
  label: string
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** Beat indices that are downbeats (bar lines), matched by time. */
export function downbeatIndices(song: Pick<Routine['song'], 'beats' | 'downbeats'>): Set<number> {
  const out = new Set<number>()
  for (const d of song.downbeats) {
    const i = beatIndexAt(song.beats, d + EPS)
    if (i >= 0 && Math.abs(song.beats[i] - d) < EPS) out.add(i)
  }
  return out
}

/** 1-based bar containing song time t (counting downbeats at or before it); at least 1. */
export function barAt(downbeats: readonly number[], t: number): number {
  return Math.max(1, beatIndexAt(downbeats, t + EPS) + 1)
}

/**
 * The routine as 8-counts: each segment starts at a move start and takes the moves starting in
 * the next 8 beats, plus any following moves that don't start on a bar line (up to 4 more beats),
 * so the next segment starts on a bar line whenever the choreography allows.
 */
export function buildSegments(routine: Pick<Routine, 'song' | 'moves'>): TeachSegment[] {
  const { song, moves } = routine
  const beats = song.beats
  if (moves.length === 0 || beats.length === 0) return []
  const period = beatPeriod(song)
  const down = downbeatIndices(song)
  const beatTime = (i: number): number =>
    i < 0 ? beats[0] + i * period : i < beats.length ? beats[i] : beats[beats.length - 1] + (i - beats.length + 1) * period
  const out: TeachSegment[] = []
  let i = 0
  while (i < moves.length) {
    const b0 = moves[i].startBeat
    const target = b0 + COUNT_BEATS
    let j = i + 1
    while (j < moves.length && moves[j].startBeat < target) j++
    while (j < moves.length && !down.has(moves[j].startBeat) && moves[j].startBeat < target + COUNT_BEATS / 2) j++
    const last = moves[j - 1]
    const start = moves[i].startTime
    const end = j < moves.length ? Math.min(Math.max(last.endTime, beatTime(target)), moves[j].startTime) : last.endTime
    const countIn: CountInBeat[] = []
    for (let k = COUNT_IN_BEATS; k >= 1; k--) {
      const time = beatTime(b0 - k)
      if (time >= 0) countIn.push({ time, label: String(COUNT_BEATS + 1 - k) })
    }
    const loopStart = Math.max(0, (countIn[0]?.time ?? start) - LOOP_PREROLL_BEATS * period)
    const section = sectionAt(song.sections, start + EPS)?.label ?? 'intro'
    const barStart = barAt(song.downbeats, start)
    const barEnd = Math.max(barStart, barAt(song.downbeats, end - 2 * EPS))
    const moveIndices: number[] = []
    for (let k = i; k < j; k++) moveIndices.push(k)
    const moveNames = [...new Set(moveIndices.map((k) => moves[k].name))]
    out.push({
      index: out.length,
      start,
      end,
      startBeat: b0,
      endBeat: Math.max(b0 + 1, beatIndexAt(beats, end - EPS) + 1),
      countIn,
      loopStart,
      section,
      barStart,
      barEnd,
      moveIndices,
      moveNames,
      label: `${cap(section)} · ${barEnd > barStart ? `bars ${barStart}–${barEnd}` : `bar ${barStart}`}`,
    })
    i = j
  }
  return out
}

/** The segment containing move `moveIndex` (0 when unknown / out of range). */
export function segmentForMove(segments: readonly TeachSegment[], moveIndex: number | null | undefined): number {
  if (moveIndex === null || moveIndex === undefined || !Number.isInteger(moveIndex)) return 0
  const i = segments.findIndex((s) => s.moveIndices.includes(moveIndex))
  return i >= 0 ? i : 0
}

/** "5" / "6" / "7" / "8" while that count-in beat is the latest one at t (null outside the count-in). */
export function countInAt(seg: Pick<TeachSegment, 'countIn' | 'start'>, t: number): { label: string; phase: number } | null {
  if (t >= seg.start) return null
  for (let k = seg.countIn.length - 1; k >= 0; k--) {
    const b = seg.countIn[k]
    if (t >= b.time) {
      const next = k + 1 < seg.countIn.length ? seg.countIn[k + 1].time : seg.start
      const span = next - b.time
      return { label: b.label, phase: span > 0 ? Math.min(1, (t - b.time) / span) : 0 }
    }
  }
  return null
}

/** 1-based beat of the 8-count at t (1..8, wrapping for longer segments); 0 outside the segment. */
export function beatInSegment(beats: readonly number[], seg: Pick<TeachSegment, 'startBeat' | 'endBeat' | 'start' | 'end'>, t: number): number {
  if (t < seg.start - EPS || t >= seg.end) return 0
  const i = beatIndexAt(beats, t + EPS)
  if (i < seg.startBeat) return 1
  return ((Math.min(i, seg.endBeat - 1) - seg.startBeat) % COUNT_BEATS) + 1
}

// --- scoring a pass --------------------------------------------------------------------------

/** The checkpoints inside a segment (both ends included). */
export function segmentCheckpoints(all: readonly Checkpoint[], seg: Pick<TeachSegment, 'start' | 'end'>): Checkpoint[] {
  return all.filter((cp) => cp.time >= seg.start - EPS && cp.time <= seg.end + EPS)
}

/** A scoring config at playback rate `rate`: the ±window is real time, so it covers window x rate of song. */
export function teachScoring(base: ScoringConfig, rate: number): ScoringConfig {
  return { ...base, windowSec: base.windowSec * rate }
}

/**
 * Song time at which a pass jumps back: the segment end plus (window + camera latency + a short
 * tail) of real time, so the last checkpoint's frames are in before the pass is judged.
 */
export function passEnd(seg: Pick<TeachSegment, 'end'>, rate: number, windowSec: number, latencySec: number): number {
  return seg.end + (windowSec + Math.max(0, latencySec) + LOOP_TAIL_SEC) * rate
}

/** One pass through a segment at one speed: frames in, judged checkpoints out. */
export class PassScorer {
  readonly keeper: ScoreKeeper
  readonly rate: number
  private lastFrameTime = Number.NEGATIVE_INFINITY

  constructor(checkpoints: readonly Checkpoint[], rate: number, base: ScoringConfig = DEFAULT_SCORING) {
    this.rate = rate
    this.keeper = new ScoreKeeper(checkpoints, teachScoring(base, rate))
  }

  get total(): number {
    return this.keeper.checkpoints.length
  }

  get judged(): number {
    return this.keeper.state.judged
  }

  addFrame(frame: PlayerFrame): CheckpointResult[] {
    if (!Number.isFinite(frame.songTime)) return []
    this.lastFrameTime = Math.max(this.lastFrameTime, frame.songTime)
    return this.keeper.addFrame(frame)
  }

  /** Every animation frame: closes windows up to the newest delivered frame (or the clock when frames stall). */
  advance(songTime: number): CheckpointResult[] {
    return this.keeper.advanceTo(scoringHorizon(songTime, this.lastFrameTime, FRAME_STALL_SEC * this.rate))
  }

  /** Judges every remaining checkpoint (end of the pass). */
  close(): CheckpointResult[] {
    return this.keeper.advanceTo(Number.POSITIVE_INFINITY)
  }

  /** Mean checkpoint score of the pass so far (0..100); null before anything was judged. */
  accuracy(): number | null {
    const r = this.keeper.results()
    return r.length > 0 ? r.reduce((s, x) => s + x.score, 0) / r.length : null
  }
}

// --- progression ---------------------------------------------------------------------------

export interface PassRecord {
  segment: number
  rate: TeachRate
  /** 0..100 */
  accuracy: number
}

export type Suggestion = { kind: 'speed-up'; next: TeachRate } | { kind: 'nailed' } | null

export function nextRate(rate: TeachRate): TeachRate | null {
  const i = TEACH_RATES.indexOf(rate)
  return i >= 0 && i + 1 < TEACH_RATES.length ? TEACH_RATES[i + 1] : null
}

/** Appends a pass, keeping the last MAX_HISTORY. */
export function addPass(history: readonly PassRecord[], rec: PassRecord, max = MAX_HISTORY): PassRecord[] {
  return [...history, rec].slice(-max)
}

/** Consecutive latest passes of `segment` danced at `rate` with accuracy >= PASS_ACCURACY. */
export function passStreak(history: readonly PassRecord[], segment: number, rate: TeachRate): number {
  let n = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (h.segment !== segment) continue
    if (h.rate !== rate || !(h.accuracy >= PASS_ACCURACY)) break
    n++
  }
  return n
}

/** After PASSES_TO_ADVANCE good passes in a row: the next speed, or "nailed" at full speed. */
export function suggestionFor(history: readonly PassRecord[], segment: number, rate: TeachRate): Suggestion {
  if (passStreak(history, segment, rate) < PASSES_TO_ADVANCE) return null
  const next = nextRate(rate)
  return next ? { kind: 'speed-up', next } : { kind: 'nailed' }
}

// --- the no-camera demo ----------------------------------------------------------------------

/**
 * "Teach me with the bot": a sloppy, slightly late bot that improves with every pass of a
 * segment, so the tips (and the speed-up / "Nailed it!" flow) can be shown without a camera.
 * Lag is real time (multiply by the rate for song time).
 */
export function botPlan(pass: number): { noiseDeg: number; lagSec: number } {
  const p = Math.max(0, Math.floor(pass))
  return { noiseDeg: Math.max(5, 45 - 15 * p), lagSec: Math.max(0, 0.2 - 0.08 * p) }
}

// --- recent frames ---------------------------------------------------------------------------

/** The last few seconds of player frames, to look up the pose behind a judged checkpoint. */
export class FrameBuffer {
  private frames: PlayerFrame[] = []
  private readonly max: number

  constructor(max = 240) {
    this.max = max
  }

  push(frame: PlayerFrame): void {
    if (!Number.isFinite(frame.songTime) || !frame.valid) return
    this.frames.push(frame)
    if (this.frames.length > this.max) this.frames.splice(0, this.frames.length - this.max)
  }

  clear(): void {
    this.frames = []
  }

  /** The frame closest to song time t (within maxGapSec), or null. */
  nearest(t: number, maxGapSec = 0.25): PlayerFrame | null {
    let best: PlayerFrame | null = null
    let gap = maxGapSec
    for (const f of this.frames) {
      const d = Math.abs(f.songTime - t)
      if (d <= gap) {
        gap = d
        best = f
      }
    }
    return best
  }
}
