// Session awards across every player in the reel: Longest Combo, Cleanest Freeze (highest mean
// score on a freeze move) and Hype Master (most Perfects). Ties go to the earlier player.

import type { PlayerRoundStats } from './types'

export type AwardKind = 'longestCombo' | 'cleanestFreeze' | 'hypeMaster'

export interface Award {
  kind: AwardKind
  title: string
  icon: string
  playerId: string
  playerName: string
  value: number
  /** "×24 combo", "Star Pose at 97%", "18 Perfects". */
  detail: string
}

export const AWARD_TITLES: Readonly<Record<AwardKind, { title: string; icon: string }>> = {
  longestCombo: { title: 'Longest Combo', icon: '🔥' },
  cleanestFreeze: { title: 'Cleanest Freeze', icon: '🧊' },
  hypeMaster: { title: 'Hype Master', icon: '📣' },
}

function award(kind: AwardKind, p: PlayerRoundStats, value: number, detail: string): Award {
  return { kind, ...AWARD_TITLES[kind], playerId: p.playerId, playerName: p.playerName, value, detail }
}

/** Awards that someone earned (none for a zero: no combo, no freeze move, no Perfect). */
export function selectAwards(players: readonly PlayerRoundStats[]): Award[] {
  const out: Award[] = []

  let combo: PlayerRoundStats | null = null
  for (const p of players) if (p.longestCombo > 0 && (!combo || p.longestCombo > combo.longestCombo)) combo = p
  if (combo) out.push(award('longestCombo', combo, combo.longestCombo, `×${combo.longestCombo} combo`))

  let freeze: { p: PlayerRoundStats; f: PlayerRoundStats['freezes'][number] } | null = null
  for (const p of players) for (const f of p.freezes) if (f.avgScore > 0 && (!freeze || f.avgScore > freeze.f.avgScore)) freeze = { p, f }
  if (freeze) out.push(award('cleanestFreeze', freeze.p, freeze.f.avgScore, `${freeze.f.moveName} at ${Math.round(freeze.f.avgScore)}%`))

  let hype: PlayerRoundStats | null = null
  for (const p of players) if (p.perfects > 0 && (!hype || p.perfects > hype.perfects)) hype = p
  if (hype) out.push(award('hypeMaster', hype, hype.perfects, `${hype.perfects} Perfect${hype.perfects === 1 ? '' : 's'}`))

  return out
}
