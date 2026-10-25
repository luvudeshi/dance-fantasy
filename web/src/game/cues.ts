// Pure timing + layout for the play screen (unit-tested): beat pulse, the 3-2-1 count-in,
// per-move beat countdown, section lookup and the cue strip (move cards sliding right->left
// that reach the hit marker exactly at their move's startTime). Everything is a function of
// song time t, so the visuals follow the audio clock with no state between frames.

import type { Move, Routine, Section } from '@shared/routine'
import { beatIndexAt } from '../audio/clock'
import { lastStartedIndex } from '../routine/pose'

const clamp01 = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : Number.isNaN(u) ? 0 : u)

// --- beats -----------------------------------------------------------------------------

export const BEAT_PULSE_SEC = 0.15

/** 1 exactly on a beat, easing to 0 over `decaySec` after it (quadratic). 0 before the first beat. */
export function beatPulse(beats: readonly number[], t: number, decaySec = BEAT_PULSE_SEC): number {
  const i = beatIndexAt(beats, t)
  if (i < 0) return 0
  const u = (t - beats[i]) / decaySec
  return u >= 1 ? 0 : (1 - u) * (1 - u)
}

/** Seconds per beat: 60 / bpm, else the median beat gap, else 0.5. */
export function beatPeriod(song: Pick<Routine['song'], 'beats' | 'bpm'>): number {
  if (song.bpm > 0 && Number.isFinite(song.bpm)) return 60 / song.bpm
  const gaps = song.beats.slice(1).map((b, i) => b - song.beats[i]).filter((g) => g > 0)
  if (gaps.length === 0) return 0.5
  gaps.sort((a, b) => a - b)
  return gaps[gaps.length >> 1]
}

/** `beats` with the grid extended backwards (beats[0] - k * period) down to `fromT` (count-in beats). */
export function withLeadInBeats(beats: readonly number[], period: number, fromT: number): number[] {
  if (beats.length === 0 || !(period > 0)) return [...beats]
  const lead: number[] = []
  for (let k = 1; beats[0] - k * period >= fromT; k++) lead.push(beats[0] - k * period)
  return [...lead.reverse(), ...beats]
}

// --- count-in ----------------------------------------------------------------------------

export const COUNTDOWN_BEATS = 3
/** The "3" shows at least this long after pressing Start (room for the start delay + a breath). */
export const COUNTDOWN_LEAD_SEC = 0.6
/** How long "Dance!" stays up after the first move starts. */
export const GO_HOLD_SEC = 0.7

export interface CountdownPlan {
  /** Song times of "3", "2", "1" (the beats before the first move) and of the first move start ("Dance!"). */
  times: number[]
  /** Seconds of silence before song time 0 so the count-in fits (0 when the song has room). */
  preRollSec: number
}

/**
 * The count-in: the COUNTDOWN_BEATS beats before the first move. When the first move starts
 * near 0 those beats are extrapolated before the song (negative times) and preRollSec says
 * how much silent lead-in to play first.
 */
export function countdownPlan(
  song: Pick<Routine['song'], 'beats' | 'bpm'>,
  firstMove: Pick<Move, 'startBeat' | 'startTime'> | undefined,
  count = COUNTDOWN_BEATS,
): CountdownPlan {
  if (!firstMove || song.beats.length === 0) return { times: [], preRollSec: 0 }
  const period = beatPeriod(song)
  const times: number[] = []
  for (let k = count; k >= 1; k--) {
    const idx = firstMove.startBeat - k
    times.push(idx >= 0 && idx < song.beats.length ? song.beats[idx] : song.beats[0] + idx * period)
  }
  times.push(firstMove.startTime)
  return { times, preRollSec: Math.max(0, COUNTDOWN_LEAD_SEC - times[0]) }
}

export interface CountdownCue {
  /** "3", "2", "1" or "Dance!". */
  label: string
  /** 0..1 through this count (for the pop animation). */
  phase: number
  /** 0-based step; the last one is "Dance!". */
  step: number
}

/** Which count-in label is showing at song time t (null before "3" and after "Dance!" fades). */
export function countdownAt(plan: CountdownPlan, t: number): CountdownCue | null {
  const { times } = plan
  const n = times.length - 1
  if (n < 0 || t < times[0]) return null
  for (let i = 0; i < n; i++) {
    if (t < times[i + 1]) {
      const span = times[i + 1] - times[i]
      return { label: String(n - i), phase: span > 0 ? clamp01((t - times[i]) / span) : 0, step: i }
    }
  }
  if (t < times[n] + GO_HOLD_SEC) return { label: 'Dance!', phase: clamp01((t - times[n]) / GO_HOLD_SEC), step: n }
  return null
}

/**
 * Beats left until the next move starts (3, 2, 1) on the last beats before a move change;
 * 0 otherwise (also on the start beat itself, before the first beat (the count-in covers
 * that) and after the last move).
 */
export function moveCountdown(
  beats: readonly number[],
  moves: readonly Pick<Move, 'startBeat' | 'startTime' | 'endTime'>[],
  t: number,
  count = COUNTDOWN_BEATS,
): number {
  const next = lastStartedIndex(moves, t) + 1
  const beat = beatIndexAt(beats, t)
  if (next >= moves.length || beat < 0) return 0
  const n = moves[next].startBeat - beat
  return n >= 1 && n <= count ? n : 0
}

// --- sections ----------------------------------------------------------------------------

/** Section playing at t (clamped to the first / last section); null when there are none. */
export function sectionAt(sections: readonly Section[], t: number): Section | null {
  if (sections.length === 0) return null
  for (const s of sections) if (t < s.end) return s
  return sections[sections.length - 1]
}

// --- cue strip -----------------------------------------------------------------------------

type TimedMove = Pick<Move, 'startTime' | 'endTime'>

/** Shortest gap between consecutive move starts (floored at 0.25 s): one card slot of travel. */
export function cueSlotSec(moves: readonly TimedMove[]): number {
  let slot = Infinity
  for (let i = 1; i < moves.length; i++) slot = Math.min(slot, moves[i].startTime - moves[i - 1].startTime)
  if (!Number.isFinite(slot)) slot = moves.length > 0 ? moves[0].endTime - moves[0].startTime : 2
  return Math.max(0.25, slot)
}

export interface CueStripGeometry {
  /** Centre x of the hit marker (CSS px). */
  hitX: number
  /** Visible strip [leftX, rightX]: cards outside are culled, cards entering on the right fade in. */
  leftX: number
  rightX: number
  cardW: number
  gap: number
  /** cueSlotSec(moves): cards travel one (cardW + gap) per slot, so upcoming cards never overlap. */
  slotSec: number
}

export interface CueCard {
  /** Index into moves. */
  index: number
  /** Card centre x. */
  x: number
  alpha: number
  /** The move is playing now. */
  active: boolean
  /** 0..1 through the move while active. */
  progress: number
}

/** Upcoming cards shown after the current one. */
export const CUE_AHEAD = 2

/**
 * Card positions at song time t. An upcoming move's card sits at hitX + (startTime - t) * speed,
 * so it reaches the hit marker exactly at startTime; there it parks (the current move) until
 * the next card arrives and pushes it out to the left, fading. Shows the previous card (on its
 * way out), the current one and every upcoming card that has entered the strip (at least the
 * next CUE_AHEAD), so cards only ever appear at the right edge, never mid-strip.
 */
export function layoutCueStrip(moves: readonly TimedMove[], t: number, g: CueStripGeometry): CueCard[] {
  if (moves.length === 0 || !(g.slotSec > 0)) return []
  const spacing = g.cardW + g.gap
  const speed = spacing / g.slotSec
  const cur = lastStartedIndex(moves, t)
  const first = Math.max(0, cur - 1)
  const rawX = (start: number): number => g.hitX + (start - t) * speed
  let last = Math.min(moves.length - 1, Math.max(cur, 0) + CUE_AHEAD)
  while (last + 1 < moves.length && rawX(moves[last + 1].startTime) - g.cardW / 2 < g.rightX) last++

  // The card after `last` (or, after the final move, a phantom one slot/move later) pushes it.
  const pusherStart =
    last + 1 < moves.length ? moves[last + 1].startTime : Math.max(moves[last].endTime, moves[last].startTime + g.slotSec)
  let nextX = rawX(pusherStart)
  const xs: number[] = []
  for (let i = last; i >= first; i--) {
    const x = Math.min(Math.max(rawX(moves[i].startTime), g.hitX), nextX - spacing)
    xs[i] = x
    nextX = x
  }

  const cards: CueCard[] = []
  for (let i = first; i <= last; i++) {
    const x = xs[i]
    const left = x - g.cardW / 2
    const right = x + g.cardW / 2
    if (right <= g.leftX || left >= g.rightX) continue
    let alpha = x < g.hitX ? clamp01(1 - (g.hitX - x) / spacing) : 1
    if (right > g.rightX) alpha *= clamp01((g.rightX - left) / g.cardW)
    if (alpha <= 0.001) continue
    const m = moves[i]
    const active = i === cur && t < m.endTime
    const dur = m.endTime - m.startTime
    cards.push({ index: i, x, alpha, active, progress: active && dur > 0 ? clamp01((t - m.startTime) / dur) : 0 })
  }
  return cards
}

// --- per-game precomputation ---------------------------------------------------------------

export interface GameTimeline {
  /** Song beats plus the count-in beats extrapolated before 0 (drives the beat pulse). */
  pulseBeats: number[]
  countdown: CountdownPlan
  /** Count-in beats before song time 0 (soft clicks during the silent lead-in). */
  countInClicks: number[]
  slotSec: number
}

export function buildGameTimeline(routine: Pick<Routine, 'song' | 'moves'>): GameTimeline {
  const { song, moves } = routine
  const countdown = countdownPlan(song, moves[0])
  const period = beatPeriod(song)
  return {
    pulseBeats: withLeadInBeats(song.beats, period, -countdown.preRollSec - period),
    countdown,
    countInClicks: countdown.times.slice(0, -1).filter((c) => c < 0),
    slotSec: cueSlotSec(moves),
  }
}
