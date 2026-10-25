import { describe, expect, it } from 'vitest'
import {
  announceBadges,
  badgeQueue,
  byTier,
  dismissBadge,
  isMyBadges,
  newBadgesOf,
  progressLabel,
  progressPct,
  type EarnedBadge,
  type LockedBadge,
} from './model'

// Shapes from shared/README.md, "Badges endpoints".
const base = { description: 'Dance to 5 different songs.', icon: 'music-note', unit: 'songs' } as const
const earned = (id: string, tier: EarnedBadge['tier']): EarnedBadge => ({ ...base, id, name: id, tier, earnedAt: 1 })
const locked = (have: number, need: number): LockedBadge => ({ ...base, id: 'songbird', name: 'Songbird', tier: 'silver', progress: { have, need } })

describe('badge guards', () => {
  it('accepts the documented shapes and rejects unknown icons', () => {
    expect(isMyBadges({ earned: [earned('a', 'gold')], locked: [locked(3, 5)] })).toBe(true)
    expect(isMyBadges({ earned: [{ ...earned('a', 'gold'), icon: 'nope' }], locked: [] })).toBe(false)
    expect(isMyBadges({ earned: [{ ...earned('a', 'gold'), tier: 'platinum' }], locked: [] })).toBe(false)
  })

  it('reads newBadges from the rounds response, old servers included', () => {
    expect(newBadgesOf({ ok: true, newBadges: [earned('a', 'bronze'), { junk: 1 }] })?.map((b) => b.id)).toEqual(['a'])
    expect(newBadgesOf({ ok: true })).toEqual([])
    expect(newBadgesOf({ detail: 'nope' })).toBeNull()
  })
})

describe('badge display', () => {
  it('sorts gold first, keeping catalog order within a tier', () => {
    const list = [earned('b1', 'bronze'), earned('g1', 'gold'), earned('s1', 'silver'), earned('g2', 'gold')]
    expect(byTier(list).map((b) => b.id)).toEqual(['g1', 'g2', 's1', 'b1'])
  })

  it('labels progress', () => {
    expect(progressLabel(locked(3, 5))).toBe('3 / 5 songs')
    expect(progressLabel(locked(9, 5))).toBe('5 / 5 songs')
    expect(progressLabel(locked(0, 1))).toBe('Not yet')
    expect(progressPct(locked(3, 5))).toBe(60)
  })

  it('queues toasts without duplicates and shows them one at a time', () => {
    announceBadges([earned('a', 'gold'), earned('b', 'silver')])
    announceBadges([earned('b', 'silver'), earned('c', 'bronze')])
    expect(badgeQueue().map((b) => b.id)).toEqual(['a', 'b', 'c'])
    dismissBadge()
    expect(badgeQueue()[0]?.id).toBe('b')
    dismissBadge()
    dismissBadge()
    expect(badgeQueue()).toEqual([])
  })
})
