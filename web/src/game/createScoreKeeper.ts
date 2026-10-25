// Picks the scorer for a run: classic (game/scoring.ts) by default, v2 (game/scoringV2/) when the
// URL has ?scoring=v2 (also inside the hash route, e.g. #/play?scoring=v2) or localStorage
// "mb.scoring" is "v2", and always for a preset carrying v2 settings (Relaxed). v2 shadows
// classic on the same frames; keeperDebugText shows both.

import type { MotionTrack } from '../routine/track'
import type { KeeperLike } from './run'
import { DEFAULT_SCORING, ScoreKeeper, type Checkpoint, type ScoringConfig } from './scoring'
import { hasV2Settings, ScoreKeeperV2 } from './scoringV2'

export type ScoringVersion = 'classic' | 'v2'

export const SCORING_STORAGE_KEY = 'mb.scoring'

interface LocationLike {
  search: string
  hash: string
}

interface StorageLike {
  getItem(key: string): string | null
}

function param(loc: LocationLike): string | null {
  const fromSearch = new URLSearchParams(loc.search).get('scoring')
  if (fromSearch) return fromSearch
  const q = loc.hash.indexOf('?')
  return q >= 0 ? new URLSearchParams(loc.hash.slice(q + 1)).get('scoring') : null
}

/** The URL wins (?scoring=classic forces classic), then localStorage, then classic. */
export function scoringVersion(loc: LocationLike | null = globalThis.location ?? null, storage: StorageLike | null = safeStorage()): ScoringVersion {
  const p = loc ? param(loc) : null
  if (p === 'v2' || p === 'classic') return p
  try {
    return storage?.getItem(SCORING_STORAGE_KEY) === 'v2' ? 'v2' : 'classic'
  } catch {
    return 'classic'
  }
}

function safeStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function createScoreKeeper(
  checkpoints: readonly Checkpoint[],
  config: ScoringConfig = DEFAULT_SCORING,
  track: MotionTrack | null = null,
  version: ScoringVersion = scoringVersion(),
): KeeperLike {
  return version === 'v2' || hasV2Settings(config) ? new ScoreKeeperV2(checkpoints, config, { track }) : new ScoreKeeper(checkpoints, config)
}

/** Debug-overlay lines comparing v2 with its classic shadow; null for the classic keeper. */
export function keeperDebugText(keeper: KeeperLike | null | undefined): string | null {
  if (!(keeper instanceof ScoreKeeperV2)) return null
  const line = (name: string, k: KeeperLike): string => {
    const s = k.state
    const rs = k.results()
    const acc = rs.length > 0 ? rs.reduce((a, r) => a + r.score, 0) / rs.length : 0
    const c = s.counts
    return `${name.padEnd(8)} ${String(s.score).padStart(6)} pts  acc ${acc.toFixed(1).padStart(5)}  P/G/O/M ${c.perfect}/${c.good}/${c.ok}/${c.miss}`
  }
  const last = keeper.results().at(-1)
  const tail = last?.v2
    ? `last     ${last.judgment}${last.timing ? ` (${last.timing})` : ''} ${last.score.toFixed(0)}  pose ${last.v2.pose.toFixed(0)} path ${last.v2.path === null ? '–' : last.v2.path.toFixed(0)} x${last.v2.timingFactor.toFixed(2)} +dir ${last.v2.bonus.direction.toFixed(1)} +snap ${last.v2.bonus.snap.toFixed(1)}  off ${last.offsetSec === null ? '–' : `${(last.offsetSec * 1000).toFixed(0)} ms`}`
    : ''
  return ['scoring  v2 (shadow: classic)', line('v2', keeper), keeper.shadow ? line('classic', keeper.shadow) : '', tail].filter(Boolean).join('\n')
}
