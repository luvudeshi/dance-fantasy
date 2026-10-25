import { describe, expect, it } from 'vitest'
import { isSongBoard, placementLine, songFromHash, songOptions } from './client'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('leaderboard helpers', () => {
  it('merges your recent songs after the server list, once each', () => {
    const opts = songOptions(
      [{ analysisId: A, title: 'Vibe Ace', dancers: 3 }],
      [
        { analysisId: A, songTitle: 'Vibe Ace' },
        { analysisId: B, songTitle: 'Mine' },
        { analysisId: B, songTitle: 'Mine' },
      ],
    )
    expect(opts).toEqual([
      { analysisId: A, title: 'Vibe Ace', dancers: 3 },
      { analysisId: B, title: 'Mine', dancers: 0 },
    ])
  })

  it('says where you placed', () => {
    expect(placementLine({ rank: 3, score: 9 }, 'Vibe Ace')).toBe('You placed #3 on Vibe Ace!')
    expect(placementLine({ rank: 1, score: 9 }, null)).toBe('You placed #1 on this song!')
    expect(placementLine(null, 'Vibe Ace')).toBeNull()
  })

  it('reads the song from the hash query', () => {
    expect(songFromHash(`#/hall?song=${A}`)).toBe(A)
    expect(songFromHash('#/hall?song=nope')).toBeNull()
    expect(songFromHash('#/hall')).toBeNull()
  })

  it('validates a song board', () => {
    const entry = { rank: 1, accountId: 'x', name: 'Bo', avatar: 'wolf', color: 'blue', isYou: true, score: 5, accuracy: 80, maxCombo: 3, stars: 4, at: 1 }
    expect(isSongBoard({ scope: 'all', song: { analysisId: A, title: null }, entries: [entry], you: { rank: 1, score: 5 } })).toBe(true)
    expect(isSongBoard({ scope: 'all', song: { analysisId: A, title: null }, entries: [{ ...entry, avatar: 'nope' }], you: null })).toBe(false)
  })
})
