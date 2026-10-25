import { describe, expect, it } from 'vitest'
import { addWithCap, averageScore, bestMove, byStrength, clipStrength, isFreezeMove, MAX_CLIPS } from './clips'
import type { ClipJudgment } from './types'

const clip = (id: string, comboLength: number, avgScore: number, startSongTime = 0) => ({ id, comboLength, avgScore, startSongTime })

describe('clip cap', () => {
  it('keeps up to 6 clips', () => {
    let list: ReturnType<typeof clip>[] = []
    for (let i = 0; i < MAX_CLIPS; i++) {
      const r = addWithCap(list, clip(`c${i}`, 8 + i, 90))
      expect(r.dropped).toBeNull()
      list = r.clips
    }
    expect(list).toHaveLength(6)
  })

  it('a stronger clip replaces the weakest', () => {
    const full = [clip('a', 10, 90), clip('b', 8, 80), clip('c', 12, 85), clip('d', 9, 95), clip('e', 20, 70), clip('f', 11, 88)]
    const r = addWithCap(full, clip('new', 9, 99))
    expect(r.dropped?.id).toBe('b')
    expect(r.clips.map((c) => c.id).sort()).toEqual(['a', 'c', 'd', 'e', 'f', 'new'])
  })

  it('a weaker (or equal) clip is the one dropped', () => {
    const full = Array.from({ length: 6 }, (_, i) => clip(`c${i}`, 12, 90))
    const r = addWithCap(full, clip('meh', 8, 90))
    expect(r.dropped?.id).toBe('meh')
    expect(r.clips).toHaveLength(6)
    expect(addWithCap(full, clip('tie', 12, 90)).dropped?.id).toBe('tie')
  })

  it('strength favors length weighted by quality', () => {
    expect(clipStrength(clip('x', 16, 75))).toBeGreaterThan(clipStrength(clip('y', 8, 100)))
    expect(byStrength([clip('a', 8, 90, 5), clip('b', 16, 90, 9), clip('c', 8, 90, 1)]).map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('clip metadata', () => {
  const j = (moveIndex: number, score: number, moveId = `m${moveIndex}`): ClipJudgment => ({ time: 0, judgment: 'good', score, moveId, moveIndex })

  it('average and best move', () => {
    const js = [j(0, 80), j(0, 90), j(1, 95), j(1, 85), j(2, 70)]
    expect(averageScore(js)).toBe(84)
    expect(bestMove(js)).toEqual({ moveId: 'm1', moveIndex: 1 })
    expect(bestMove([])).toBeNull()
  })

  it('best move ties go to the move with more checkpoints', () => {
    expect(bestMove([j(0, 90), j(1, 90), j(1, 90)])?.moveIndex).toBe(1)
  })

  it('freeze moves, mirrored or not', () => {
    expect(isFreezeMove('star_pose')).toBe(true)
    expect(isFreezeMove('superhero_L')).toBe(true)
    expect(isFreezeMove('arm_wave_L')).toBe(false)
  })
})
