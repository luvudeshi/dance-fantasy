import { describe, expect, it } from 'vitest'
import {
  cleanFriendCode,
  cleanUsername,
  iconLabel,
  isFriend,
  isFriendCode,
  isHistory,
  isInvite,
  isMe,
  isPartner,
  isUsername,
  normalizeRound,
} from './client'

// Shapes from shared/README.md, "Accounts endpoints".
const ME = {
  id: 'q3V9kZ2xAb1c',
  name: 'Twirling Pumpkin',
  avatar: 'pumpkin',
  color: 'rasp',
  friendCode: 'K7QX2M',
  isGuest: true,
  username: null,
  stats: { rounds: 12, bestScore: 48210, friends: 3 },
}

describe('response guards', () => {
  it('accepts the documented shapes', () => {
    expect(isMe(ME)).toBe(true)
    expect(isMe({ ...ME, isGuest: false, username: 'maya' })).toBe(true)
    expect(isFriend({ id: 'a', name: 'Bo', avatar: 'wolf', color: 'blue', online: true, inRoom: 'KQWX' })).toBe(true)
    expect(isFriend({ id: 'a', name: 'Bo', avatar: 'wolf', color: 'blue', online: false, inRoom: null })).toBe(true)
    expect(
      isPartner({ id: 'c', name: 'Cy', avatar: 'crown', color: 'gold', friendCode: 'P4RT9Z', online: false, isFriend: false, lastPlayedAt: 1 }),
    ).toBe(true)
    expect(isInvite({ id: 7, fromId: 'x', fromName: 'Ana', fromAvatar: 'slipper', fromColor: 'rasp', roomCode: 'KQWX', at: 1 })).toBe(true)
    const round = { analysisId: 'a'.repeat(64), songTitle: 'Vibe Ace', score: 48210, accuracy: 91.5, maxCombo: 80, stars: 4.5, mode: 'solo', at: 1 }
    expect(isHistory({ rounds: [round], totalRounds: 12, bestScore: 48210, avgAccuracy: 84.27, dayStreak: 3 })).toBe(true)
  })

  it('rejects unknown avatars, colours, modes and missing fields', () => {
    expect(isMe({ ...ME, avatar: 'dragon' })).toBe(false)
    expect(isMe({ ...ME, color: 'pink' })).toBe(false)
    expect(isMe({ ...ME, stats: undefined })).toBe(false)
    expect(isMe(null)).toBe(false)
    expect(isFriend({ id: 'a', name: 'Bo', avatar: 'wolf', color: 'blue', online: 'yes', inRoom: null })).toBe(false)
    const round = { analysisId: 'a', songTitle: 'x', score: 1, accuracy: 1, maxCombo: 1, stars: 1, mode: 'duet', at: 1 }
    expect(isHistory({ rounds: [round], totalRounds: 1, bestScore: 1, avgAccuracy: 1, dayStreak: 0 })).toBe(false)
  })
})

describe('input helpers', () => {
  it('normalizes a round to what the server accepts', () => {
    const r = normalizeRound({
      analysisId: 'id',
      songTitle: '   ',
      score: 1234.6,
      accuracy: 104,
      maxCombo: -3,
      stars: 7,
      mode: 'room',
    })
    expect(r).toEqual({ analysisId: 'id', songTitle: 'Untitled', score: 1235, accuracy: 100, maxCombo: 0, stars: 5, mode: 'room' })
    expect(normalizeRound({ ...r, songTitle: '  Vibe   Ace ', accuracy: Number.NaN, stars: 3.5 })).toMatchObject({
      songTitle: 'Vibe Ace',
      accuracy: 0,
      stars: 3.5,
    })
    expect(normalizeRound({ ...r, songTitle: 'x'.repeat(300) }).songTitle).toHaveLength(200)
  })

  it('cleans friend codes and usernames like the server', () => {
    expect(cleanFriendCode(' k7q-x2m ')).toBe('K7QX2M')
    expect(isFriendCode('K7QX2M')).toBe(true)
    expect(isFriendCode('K7QX2')).toBe(false)
    expect(isFriendCode('K7QX2O')).toBe(false) // no O / 0 / I / L / 1
    expect(cleanUsername('  Maya_1 ')).toBe('maya_1')
    expect(isUsername('maya_1')).toBe(true)
    expect(isUsername('ma')).toBe(false)
    expect(isUsername('maya!')).toBe(false)
  })

  it('names icons for people', () => {
    expect(iconLabel('clock-tower')).toBe('Clock tower')
    expect(iconLabel('wolf')).toBe('Wolf')
  })
})
