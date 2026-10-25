// Party podium: rank by score, then hand out storybook titles. Every title goes to whoever truly
// earned it (ties share it, one dancer can hold several); a dancer with none is the Heart of the Party.

import type { CheckpointResult, ResultsSummary } from '../game/scoring'

export type AwardId = 'belle' | 'sync' | 'combo' | 'perfect' | 'heart'

export interface Award {
  id: AwardId
  title: string
  /** Why, in a few words ("41 ms off the beat on average"). */
  detail: string
}

export const AWARD_TITLES: Readonly<Record<AwardId, string>> = {
  belle: 'Belle of the Ball',
  sync: 'Most in Sync',
  combo: 'Unbroken Spell',
  perfect: 'Glass Slipper',
  heart: 'Heart of the Party',
}

/** "Most in Sync" needs at least this many on-beat hits to be measured. */
export const MIN_SYNC_HITS = 4
/** "Unbroken Spell" needs a combo at least this long. */
export const MIN_SPELL_COMBO = 5

export interface PartyEntry {
  summary: ResultsSummary
  results: readonly Pick<CheckpointResult, 'offsetSec' | 'judgment'>[]
}

export interface Placing {
  /** Index into the entries. */
  index: number
  /** 1-based; equal score and accuracy share a rank. */
  rank: number
  awards: Award[]
  /** Mean |timing offset| of the hits (ms), null with too few hits. */
  syncMs: number | null
}

/** Mean |offset| (s) of the non-miss results with a timing, null below MIN_SYNC_HITS. */
export function meanAbsOffset(results: PartyEntry['results']): number | null {
  const hits = results.filter((r) => r.judgment !== 'miss' && r.offsetSec !== null)
  if (hits.length < MIN_SYNC_HITS) return null
  return hits.reduce((a, r) => a + Math.abs(r.offsetSec ?? 0), 0) / hits.length
}

/** Placings in podium order (rank 1 first). */
export function rankParty(entries: readonly PartyEntry[]): Placing[] {
  const order = entries
    .map((e, index) => ({ e, index }))
    .sort((a, b) => b.e.summary.state.score - a.e.summary.state.score || b.e.summary.accuracy - a.e.summary.accuracy || a.index - b.index)
  const placings: Placing[] = []
  order.forEach(({ e, index }, k) => {
    const prev = order[k - 1]
    const tied = prev && prev.e.summary.state.score === e.summary.state.score && prev.e.summary.accuracy === e.summary.accuracy
    const off = meanAbsOffset(e.results)
    placings.push({ index, rank: tied ? placings[k - 1].rank : k + 1, awards: [], syncMs: off === null ? null : off * 1000 })
  })

  const give = (id: AwardId, winners: Placing[], detail: (p: Placing) => string): void => {
    for (const p of winners) p.awards.push({ id, title: AWARD_TITLES[id], detail: detail(p) })
  }
  const best = (value: (p: Placing) => number | null, min: number): Placing[] => {
    let top = Number.NEGATIVE_INFINITY
    for (const p of placings) {
      const v = value(p)
      if (v !== null && v >= min && v > top) top = v
    }
    return Number.isFinite(top) ? placings.filter((p) => value(p) === top) : []
  }
  const st = (p: Placing): ResultsSummary['state'] => entries[p.index].summary.state

  give('belle', best((p) => (p.rank === 1 ? st(p).score : null), 1), () => 'top score of the night')
  give('sync', best((p) => (p.syncMs === null ? null : -p.syncMs), Number.NEGATIVE_INFINITY), (p) => `${Math.round(p.syncMs ?? 0)} ms off the beat on average`)
  give('combo', best((p) => st(p).maxCombo, MIN_SPELL_COMBO), (p) => `${st(p).maxCombo} steps without a miss`)
  give('perfect', best((p) => st(p).counts.perfect, 1), (p) => `${st(p).counts.perfect} perfect steps`)
  give('heart', placings.filter((p) => p.awards.length === 0), () => 'danced the whole night')
  return placings
}
