import { describe, expect, it } from 'vitest'
import { selectAwards } from './awards'
import type { PlayerRoundStats } from './types'

const p = (playerId: string, longestCombo: number, perfects: number, freezes: PlayerRoundStats['freezes'] = []): PlayerRoundStats => ({
  playerId,
  playerName: playerId.toUpperCase(),
  longestCombo,
  perfects,
  freezes,
})

describe('selectAwards', () => {
  it('picks a winner per award across players', () => {
    const awards = selectAwards([
      p('ana', 12, 30, [{ moveId: 'star_pose', moveName: 'Star Pose', avgScore: 88 }]),
      p('ben', 24, 10, [{ moveId: 'superhero', moveName: 'Superhero Pose', avgScore: 97.4 }]),
      p('cy', 5, 31),
    ])
    expect(awards.map((a) => [a.kind, a.playerId, a.detail])).toEqual([
      ['longestCombo', 'ben', '×24 combo'],
      ['cleanestFreeze', 'ben', 'Superhero Pose at 97%'],
      ['hypeMaster', 'cy', '31 Perfects'],
    ])
  })

  it('ties go to the earlier player', () => {
    const awards = selectAwards([p('ana', 10, 5), p('ben', 10, 5)])
    expect(awards.every((a) => a.playerId === 'ana')).toBe(true)
  })

  it('no award for zeros (and no freeze award without freeze moves)', () => {
    expect(selectAwards([p('ana', 0, 0)])).toEqual([])
    expect(selectAwards([p('ana', 9, 0)]).map((a) => a.kind)).toEqual(['longestCombo'])
  })

  it('single Perfect is singular', () => {
    expect(selectAwards([p('ana', 1, 1)])[1].detail).toBe('1 Perfect')
  })
})
