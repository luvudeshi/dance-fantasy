// Badges on the dance card (shared/README.md, "Badges endpoints"): shapes, response guards, ordering and
// labels, plus the queue of "Badge unlocked!" toasts that recordRound feeds and <BadgeToast /> drains.

import { ICON_NAMES, type IconName } from '../theme/icons'

export type Tier = 'bronze' | 'silver' | 'gold'

export interface BadgeInfo {
  id: string
  name: string
  description: string
  icon: IconName
  tier: Tier
  /** What the progress counts, as in "3 / 5 songs". */
  unit: string
}
export interface EarnedBadge extends BadgeInfo {
  earnedAt: number
}
export interface LockedBadge extends BadgeInfo {
  progress: { have: number; need: number }
}
export interface MyBadges {
  earned: EarnedBadge[]
  locked: LockedBadge[]
}

export const TIER_NAMES: Record<Tier, string> = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' }
const TIER_RANK: Record<Tier, number> = { gold: 0, silver: 1, bronze: 2 }

const ICONS: ReadonlySet<string> = new Set(ICON_NAMES)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isInfo(v: unknown): v is BadgeInfo {
  return (
    isRecord(v) &&
    isStr(v.id) &&
    isStr(v.name) &&
    isStr(v.description) &&
    isStr(v.icon) &&
    ICONS.has(v.icon) &&
    (v.tier === 'bronze' || v.tier === 'silver' || v.tier === 'gold') &&
    isStr(v.unit)
  )
}

export const isEarnedBadge = (v: unknown): v is EarnedBadge => isRecord(v) && isNum(v.earnedAt) && isInfo(v)

const isLockedBadge = (v: unknown): v is LockedBadge =>
  isRecord(v) && isRecord(v.progress) && isNum(v.progress.have) && isNum(v.progress.need) && isInfo(v)

export const isMyBadges = (v: unknown): v is MyBadges =>
  isRecord(v) && Array.isArray(v.earned) && v.earned.every(isEarnedBadge) && Array.isArray(v.locked) && v.locked.every(isLockedBadge)

/** POST /api/me/rounds: `{ ok: true, newBadges }` (a server without badges answers `{ ok: true }`: no badges). */
export const newBadgesOf = (v: unknown): EarnedBadge[] | null =>
  isRecord(v) && v.ok === true ? (Array.isArray(v.newBadges) ? v.newBadges.filter(isEarnedBadge) : []) : null

/** Gold first; ties keep the catalog order (Array.prototype.sort is stable). */
export const byTier = <T extends BadgeInfo>(list: readonly T[]): T[] => [...list].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])

/** "3 / 5 songs"; one-off badges (need 1) just say "Not yet". */
export const progressLabel = ({ progress, unit }: LockedBadge): string =>
  progress.need <= 1 ? 'Not yet' : `${Math.min(progress.have, progress.need)} / ${progress.need} ${unit}`

export const progressPct = ({ progress }: LockedBadge): number =>
  progress.need > 0 ? Math.round((100 * Math.min(progress.have, progress.need)) / progress.need) : 0

// --- toast queue -----------------------------------------------------------------------

let queue: readonly EarnedBadge[] = []
const listeners = new Set<() => void>()

function setQueue(next: readonly EarnedBadge[]): void {
  queue = next
  for (const l of listeners) l()
}

/** Queue "Badge unlocked!" toasts (skips badges already waiting). */
export function announceBadges(badges: readonly EarnedBadge[]): void {
  const waiting = new Set(queue.map((b) => b.id))
  const fresh = badges.filter((b) => !waiting.has(b.id))
  if (fresh.length) setQueue([...queue, ...fresh])
}

/** Drop the toast on screen (the head of the queue). */
export function dismissBadge(): void {
  setQueue(queue.slice(1))
}

export const subscribeBadges = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const badgeQueue = (): readonly EarnedBadge[] => queue
