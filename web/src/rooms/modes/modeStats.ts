// Pure numbers behind the mode HUDs and results (no React): versus standings, the crew sync meter,
// the "IN SYNC" burst trigger, team stars and the song's hardest moments.

import type { IconName } from '../../theme/icons'
import type { CrewStats, HeatBeat, ModePlayer, ModeRoom } from './api'

/** The sync bonus multiplier stops growing at this streak (server: 25 x min(streak, 8)). */
export const SYNC_STREAK_CAP = 8
export const SYNC_BEAT_POINTS = 25

/** Default player tokens, by join order. */
const TOKENS: readonly IconName[] = ['crown', 'slipper', 'frog-prince', 'red-hood', 'wolf', 'pumpkin', 'potion', 'wand']

export function tokenFor(players: readonly Pick<ModePlayer, 'id'>[], id: string): IconName {
  const i = players.findIndex((p) => p.id === id)
  return TOKENS[(i < 0 ? 0 : i) % TOKENS.length] ?? 'crown'
}

export interface VersusRow {
  player: ModePlayer
  /** beats won as a share of the top tally, 0..1 (bar length) */
  share: number
  leader: boolean
  rank: number
}

/** Players by beats won, then score (ties share a rank). */
export function versusRows(room: Pick<ModeRoom, 'players' | 'leaderId'>): VersusRow[] {
  const sorted = [...room.players].sort((a, b) => b.beatsWon - a.beatsWon || b.score - a.score)
  const top = Math.max(1, ...sorted.map((p) => p.beatsWon))
  let rank = 0
  return sorted.map((player, i) => {
    const prev = sorted[i - 1]
    if (!prev || prev.beatsWon !== player.beatsWon || prev.score !== player.score) rank = i + 1
    return { player, share: player.beatsWon / top, leader: player.id === room.leaderId, rank }
  })
}

/** Head-to-head split for exactly two dancers: the left player's share of the beats won, 0..1 (0.5 when none). */
export function tugShare(a: Pick<ModePlayer, 'beatsWon'>, b: Pick<ModePlayer, 'beatsWon'>): number {
  const total = a.beatsWon + b.beatsWon
  return total > 0 ? a.beatsWon / total : 0.5
}

/** The in-sync meter: how far the streak is toward the capped multiplier, 0..1. */
export const syncMeter = (crew: Pick<CrewStats, 'syncStreak'>): number => Math.min(1, crew.syncStreak / SYNC_STREAK_CAP)

/** Points the next synced beat adds. */
export const nextSyncPoints = (crew: Pick<CrewStats, 'syncStreak'>): number =>
  SYNC_BEAT_POINTS * Math.min(crew.syncStreak + 1, SYNC_STREAK_CAP)

/**
 * The streak to celebrate when a new RoomView arrives, or null: everyone hit at least one more beat together
 * since the last view (lastSyncBeat moved on) and the streak is still alive.
 */
export function syncBurst(prev: Pick<CrewStats, 'lastSyncBeat'> | null, next: Pick<CrewStats, 'lastSyncBeat' | 'syncStreak'>): number | null {
  if (next.lastSyncBeat === null || next.syncStreak < 1) return null
  if (prev && prev.lastSyncBeat !== null && next.lastSyncBeat <= prev.lastSyncBeat) return null
  return next.syncStreak
}

/**
 * Team stars 0..5: the dancers' mean accuracy, averaged with the share of beats danced in sync when the
 * routine's beat count is known.
 */
export function teamStars(players: readonly Pick<ModePlayer, 'accuracy'>[], crew: Pick<CrewStats, 'syncedBeats'>, totalBeats?: number): number {
  if (players.length === 0) return 0
  const acc = players.reduce((s, p) => s + Math.min(100, Math.max(0, p.accuracy)), 0) / players.length / 100
  const quality = totalBeats && totalBeats > 0 ? (acc + Math.min(1, crew.syncedBeats / totalBeats)) / 2 : acc
  return Math.round(5 * quality)
}

/** The `count` beats with the lowest average score (ties: earlier beat first), in song order. */
export function hardestMoments(beats: readonly HeatBeat[], count = 3): HeatBeat[] {
  return [...beats]
    .filter((b) => b.samples > 0)
    .sort((a, b) => a.avgScore - b.avgScore || a.beat - b.beat)
    .slice(0, count)
    .sort((a, b) => a.beat - b.beat)
}
