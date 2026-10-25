// The ballroom herald: reacts to game events (intro, combo milestones, a broken streak, the results),
// fetches lines from POST /api/announcer (shared/README.md "AI endpoints") and shows them one by one,
// optionally read aloud. It never blocks the game: lines for the next likely moment are prefetched, and
// a slow or failed request falls back to a local canned line.

import { useEffect, useState } from 'react'
import { apiUrl } from '../api'
import { rankTitle } from '../game/results'
import type { ResultsSummary } from '../game/scoring'
import { getAnnouncerPrefs, type AnnouncerPrefs } from './prefs'

export type AnnouncerEvent = 'intro' | 'combo' | 'streak_broken' | 'perfect_run' | 'results'

export interface AnnouncerContext {
  songTitle: string
  playerName?: string
  score?: number
  /** percent 0..100 */
  accuracy?: number
  combo?: number
  maxCombo?: number
  grade?: string
  /** 0..5 */
  stars?: number
  bestMove?: string
  hardestMove?: string
  difficulty?: string
}

export interface AnnouncerReply {
  lines: string[]
  source: 'muse' | 'gemini' | 'canned'
}

/** Combo counts the herald calls out: 10, 25, then every 50. */
export const isComboMilestone = (n: number): boolean => n === 10 || n === 25 || (n > 0 && n % 50 === 0)
/** A streak at least this long gets a "chin up" when it breaks. */
export const STREAK_MIN = 10
/** How long an in-game moment waits for the server before the local line (the moment is gone soon after). */
export const IN_GAME_WAIT_MS = 900
/** Intro and results can wait longer: the server answers within ~2.5 s. */
export const SCENE_WAIT_MS = 2800
const REQUEST_TIMEOUT_MS = 4000
const MAX_LINE = 90

// --- client -------------------------------------------------------------------------------------

export function isAnnouncerReply(v: unknown): v is AnnouncerReply {
  if (typeof v !== 'object' || v === null) return false
  const { lines, source } = v as Record<string, unknown>
  return (
    Array.isArray(lines) &&
    lines.length > 0 &&
    lines.every((l) => typeof l === 'string' && l.trim() !== '') &&
    (source === 'muse' || source === 'gemini' || source === 'canned')
  )
}

/** POST /api/announcer. Throws on network errors, non-2xx and malformed replies. */
export async function fetchAnnouncerLines(
  event: AnnouncerEvent,
  context: AnnouncerContext,
  signal?: AbortSignal,
  endpoint = apiUrl('/api/announcer'),
): Promise<AnnouncerReply> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ event, context }),
    signal,
  })
  if (!res.ok) throw new Error(`announcer: HTTP ${res.status}`)
  const body: unknown = await res.json()
  if (!isAnnouncerReply(body)) throw new Error('announcer: unexpected reply')
  return { ...body, lines: body.lines.slice(0, 3).map((l) => l.trim().slice(0, MAX_LINE)) }
}

// --- local fallback (server unreachable or too slow) --------------------------------------------

const LOCAL: Record<AnnouncerEvent, readonly ((c: AnnouncerContext) => string)[]> = {
  intro: [
    (c) => `Hear ye, hear ye! The ball begins with ${c.songTitle}!`,
    (c) => `Lords and ladies, take the floor: ${c.songTitle} is playing!`,
    () => 'The chandeliers sparkle and the orchestra bows. Let the dancing begin!',
  ],
  combo: [
    (c) => `${c.combo ?? 'So many'} in a row! The royal court is on its feet!`,
    () => 'Unstoppable! Your slippers are practically glowing!',
    () => 'Magic in motion! That combo is pure fairy dust!',
  ],
  streak_broken: [
    () => 'A little stumble! Even Cinderella lost a slipper. Back in step!',
    () => 'Shake it off! The next move is yours!',
    () => 'Dust off those glass slippers and twirl right back in!',
  ],
  perfect_run: [() => 'Flawless! Not a single step out of place!', () => 'A perfect dance! The fairy godmother is in happy tears!'],
  results: [
    (c) => (c.score !== undefined ? `The music fades, and the final score is ${c.score.toLocaleString('en-US')}!` : 'The music fades. What a dance!'),
    () => 'What a night at the ball! Curtsy, bow, and dance again soon!',
  ],
}

/** One canned line for `event`, filled from `context`. */
export function localLine(event: AnnouncerEvent, context: AnnouncerContext, random = Math.random): string {
  const bank = LOCAL[event]
  const pick = bank[Math.floor(random() * bank.length) % bank.length] ?? bank[0]
  return pick(context).slice(0, MAX_LINE)
}

// --- when to speak ------------------------------------------------------------------------------

export type ComboMoment = { event: 'combo' | 'streak_broken'; combo: number }

/**
 * The moment (if any) in one batch of finalized checkpoints, given the combo before it (GameRun's
 * onResults arguments): a milestone reached, or a streak of >= STREAK_MIN broken. The last one wins.
 */
export function comboMoment(results: readonly { combo?: number }[], comboBefore: number): ComboMoment | null {
  let prev = comboBefore
  let moment: ComboMoment | null = null
  for (const r of results) {
    const combo = r.combo ?? prev
    if (combo < prev) {
      if (prev >= STREAK_MIN) moment = { event: 'streak_broken', combo: prev }
    } else {
      for (let n = prev + 1; n <= combo; n++) if (isComboMilestone(n)) moment = { event: 'combo', combo: n }
    }
    prev = combo
  }
  return moment
}

/** The next milestone above `combo`. */
export function nextMilestone(combo: number): number {
  let n = Math.max(0, Math.floor(combo)) + 1
  while (!isComboMilestone(n)) n++
  return n
}

/** A run with no misses and at least 85% accuracy (the five-star line) is a perfect run. */
export function isPerfectRun(summary: Pick<ResultsSummary, 'state' | 'accuracy'>): boolean {
  return summary.state.judged > 0 && summary.state.counts.miss === 0 && summary.accuracy >= 85
}

/** The results screen's numbers as announcer context. */
export function resultsContext(summary: ResultsSummary): Omit<AnnouncerContext, 'songTitle'> {
  const { state } = summary
  const stars = Math.min(5, Math.max(0, Number.isFinite(state.stars) ? state.stars : 0))
  return {
    score: Math.max(0, Math.round(state.score)),
    accuracy: Math.min(100, Math.max(0, Math.round(summary.accuracy))),
    maxCombo: state.maxCombo,
    stars: Math.floor(stars),
    grade: rankTitle(stars),
    ...(summary.bestMove ? { bestMove: summary.bestMove.name } : {}),
    ...(summary.hardestMove ? { hardestMove: summary.hardestMove.name } : {}),
  }
}

// --- voice --------------------------------------------------------------------------------------

type VoiceLike = Pick<SpeechSynthesisVoice, 'name' | 'lang'>

/** A herald-ish English voice: a British one first (named favourites, then any en-GB), then any English. */
export function pickVoice<V extends VoiceLike>(voices: readonly V[]): V | null {
  const en = voices.filter((v) => /^en[-_]/i.test(v.lang) || v.lang.toLowerCase() === 'en')
  const gb = en.filter((v) => /^en[-_]gb/i.test(v.lang))
  return (
    gb.find((v) => /daniel|arthur|oliver|google uk english male/i.test(v.name)) ??
    gb.find((v) => /serena|kate|martha|google uk english female/i.test(v.name)) ??
    gb[0] ??
    en.find((v) => /us english|samantha|alex/i.test(v.name)) ??
    en[0] ??
    null
  )
}

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
}

/** Reads one line aloud (queued behind any line still being spoken). */
export function speakLine(line: string): void {
  const s = synth()
  if (!s || typeof SpeechSynthesisUtterance === 'undefined') return
  const u = new SpeechSynthesisUtterance(line)
  const voice = pickVoice(s.getVoices())
  if (voice) u.voice = voice
  u.lang = voice?.lang ?? 'en-GB'
  // ponytail: tuned by ear for a cheerful town crier; per-voice tuning if a voice sounds off.
  u.rate = 1.05
  u.pitch = 1.1
  s.speak(u)
}

export function stopSpeaking(): void {
  synth()?.cancel()
}

// --- the herald ---------------------------------------------------------------------------------

export interface HeraldLine {
  line: string
  event: AnnouncerEvent
  /** Changes with every new line (React key: replays the pop-in). */
  key: number
}

export interface Announcer {
  /** A new song: resets, announces the intro (call it at calibration / countdown) and prefetches the next moments. */
  intro(base: AnnouncerContext): void
  /** Hook into GameRun's onResults: combo milestones and broken streaks. */
  onResults(results: readonly { combo?: number }[], comboBefore: number): void
  /** The results screen: "perfect_run" or "results". */
  results(summary: ResultsSummary): void
  /** Pause / quit / leaving the stage: silence, hide the bubble, drop anything in flight. */
  hush(): void
  dispose(): void
  subscribe(listener: () => void): () => void
  getSnapshot(): HeraldLine | null
}

export interface AnnouncerOptions {
  endpoint?: string
  prefs?: () => AnnouncerPrefs
  speak?: (line: string) => void
  stop?: () => void
}

/** How long a line stays up: long enough to read (and to be spoken at ~15 chars/s). */
export const holdMs = (line: string): number => Math.min(7000, 2200 + line.length * 55)

export function createAnnouncer(opts: AnnouncerOptions = {}): Announcer {
  const prefs = opts.prefs ?? getAnnouncerPrefs
  const speak = opts.speak ?? speakLine
  const stop = opts.stop ?? stopSpeaking
  const listeners = new Set<() => void>()
  /** Prefetched requests by event + context; a settled one holds its lines (null: failed). */
  const pending = new Map<string, Promise<string[] | null>>()
  const ready = new Map<string, string[]>()
  let base: AnnouncerContext | null = null
  let epoch = 0
  let seq = 0
  let current: HeraldLine | null = null
  let queue: { line: string; event: AnnouncerEvent }[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const notify = (): void => {
    for (const l of listeners) l()
  }
  const keyOf = (event: AnnouncerEvent, ctx: AnnouncerContext): string => JSON.stringify([event, ctx])

  const request = (event: AnnouncerEvent, ctx: AnnouncerContext): Promise<string[] | null> =>
    fetchAnnouncerLines(event, ctx, AbortSignal.timeout(REQUEST_TIMEOUT_MS), opts.endpoint).then(
      (r) => r.lines,
      () => null,
    )

  const next = (): void => {
    clearTimeout(timer)
    const item = queue.shift()
    current = item ? { ...item, key: ++seq } : null
    notify()
    if (!item) return
    if (prefs().voice) speak(item.line)
    timer = setTimeout(next, holdMs(item.line))
  }

  const show = (event: AnnouncerEvent, lines: readonly string[]): void => {
    stop()
    queue = lines.map((line) => ({ line, event }))
    next()
  }

  const prefetch = (event: AnnouncerEvent, extra: Partial<AnnouncerContext> = {}): void => {
    if (!base || !prefs().enabled) return
    const ctx = { ...base, ...extra }
    const key = keyOf(event, ctx)
    if (pending.has(key) || ready.has(key)) return
    const p = request(event, ctx)
    pending.set(key, p)
    void p.then((lines) => {
      if (pending.get(key) !== p) return // reset meanwhile, or announce() took it
      pending.delete(key)
      if (lines) ready.set(key, lines)
    })
  }

  const announce = (event: AnnouncerEvent, extra: Partial<AnnouncerContext>, waitMs: number): void => {
    if (!base || !prefs().enabled) return
    const ctx = { ...base, ...extra }
    const key = keyOf(event, ctx)
    const prefetched = ready.get(key)
    if (prefetched) {
      ready.delete(key) // used once: the next time asks again
      epoch++
      show(event, prefetched)
      return
    }
    const p = pending.get(key) ?? request(event, ctx)
    pending.delete(key)
    const mine = ++epoch // a newer moment (or hush) drops this one if it is still waiting
    let done = false
    const fallback = setTimeout(() => {
      if (done || mine !== epoch) return
      done = true
      show(event, [localLine(event, ctx)])
    }, waitMs)
    void p.then((lines) => {
      if (done || mine !== epoch) return
      done = true
      clearTimeout(fallback)
      show(event, lines ?? [localLine(event, ctx)])
    })
  }

  const hush = (): void => {
    epoch++
    clearTimeout(timer)
    queue = []
    stop()
    if (current) {
      current = null
      notify()
    }
  }

  return {
    intro(ctx) {
      hush()
      pending.clear()
      ready.clear()
      base = { ...ctx }
      announce('intro', {}, SCENE_WAIT_MS)
      prefetch('combo', { combo: nextMilestone(0) })
      prefetch('streak_broken')
    },
    onResults(results, comboBefore) {
      const moment = comboMoment(results, comboBefore)
      if (!moment) return
      if (moment.event === 'combo') {
        announce('combo', { combo: moment.combo }, IN_GAME_WAIT_MS)
        prefetch('combo', { combo: nextMilestone(moment.combo) })
      } else {
        announce('streak_broken', {}, IN_GAME_WAIT_MS)
        prefetch('streak_broken')
        prefetch('combo', { combo: nextMilestone(0) })
      }
    },
    results(summary) {
      announce(isPerfectRun(summary) ? 'perfect_run' : 'results', resultsContext(summary), SCENE_WAIT_MS)
    },
    hush,
    dispose() {
      hush()
      pending.clear()
      ready.clear()
      base = null
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => current,
  }
}

/** One announcer for the component's lifetime; silenced on unmount. */
export function useAnnouncer(): Announcer {
  const [announcer] = useState(() => createAnnouncer())
  useEffect(() => () => announcer.dispose(), [announcer])
  return announcer
}
