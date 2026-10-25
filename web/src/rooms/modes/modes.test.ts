import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api'
import type { RoomPlayer } from '../client'
import type { BeatJudgement } from './api'
import { BeatReporter } from './beatReporter'
import { beatsWonLabel, hardestMoments, modeLine, nextSyncPoints, ordinal, syncBurst, syncMeter, teamStars, versusRows } from './modeStats'

const player = (id: string, over: Partial<RoomPlayer> = {}): RoomPlayer => ({
  id,
  name: id,
  isHost: false,
  ready: false,
  connected: true,
  score: 0,
  combo: 0,
  maxCombo: 0,
  accuracy: 0,
  progress: 0,
  finished: false,
  beatsWon: 0,
  dancing: true,
  ...over,
})

const crew = { teamScore: 0, syncBonus: 0, syncedBeats: 0, syncStreak: 0, bestSyncStreak: 0, lastSyncBeat: null }

describe('versus', () => {
  it('ranks by beats won, then score, with shared ranks and bar shares', () => {
    const room = {
      leaderId: 'b',
      players: [player('a', { beatsWon: 3, score: 900 }), player('b', { beatsWon: 6, score: 800 }), player('c', { beatsWon: 3, score: 900 })],
    }
    const rows = versusRows(room)
    expect(rows.map((r) => [r.player.id, r.rank, r.share, r.leader])).toEqual([
      ['b', 1, 1, true],
      ['a', 2, 0.5, false],
      ['c', 2, 0.5, false],
    ])
  })
  it('leaves watchers off the standings and the podium', () => {
    const players = [player('host', { dancing: false }), player('a', { beatsWon: 2, score: 300 }), player('b', { beatsWon: 5 })]
    expect(versusRows({ leaderId: 'b', players }).map((r) => [r.player.id, r.rank])).toEqual([
      ['b', 1],
      ['a', 2],
    ])
    expect(modeLine({ mode: 'versus', players, leaderId: 'b', crew }, 'a')).toBe('2nd of 2 · 2 beats won · b leads')
    expect(modeLine({ mode: 'versus', players, leaderId: 'b', crew }, 'host')).toBe('b leads') // the big screen
  })
  it('has zero-length bars before anyone wins a beat', () => {
    expect(versusRows({ leaderId: null, players: [player('a'), player('b')] }).map((r) => r.share)).toEqual([0, 0])
  })
  it('labels beats won and places', () => {
    expect(beatsWonLabel(1)).toBe('1 beat won')
    expect(beatsWonLabel(4)).toBe('4 beats won')
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 112].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '112th'])
  })
  it('sums the round up in one phone line', () => {
    const players = [player('Ana', { beatsWon: 6, score: 900 }), player('Ben', { beatsWon: 4 })]
    expect(modeLine({ mode: 'versus', players, leaderId: 'Ana', crew }, 'Ben')).toBe('2nd of 2 · 4 beats won · Ana leads')
    expect(modeLine({ mode: 'versus', players, leaderId: 'Ana', crew }, 'Ana')).toBe('1st of 2 · 6 beats won · you lead!')
    expect(modeLine({ mode: 'versus', players, leaderId: null, crew }, null)).toBe('')
    expect(modeLine({ mode: 'crew', players, leaderId: null, crew: { ...crew, teamScore: 12345, syncStreak: 5 } }, 'Ana')).toBe('Team 12,345 · in sync ×5')
    expect(modeLine({ mode: 'crew', players, leaderId: null, crew: { ...crew, teamScore: 50, syncStreak: 1 } }, 'Ana')).toBe('Team 50')
  })
})

describe('crew', () => {
  it('fills the sync meter toward the capped multiplier', () => {
    expect(syncMeter({ syncStreak: 0 })).toBe(0)
    expect(syncMeter({ syncStreak: 4 })).toBe(0.5)
    expect(syncMeter({ syncStreak: 20 })).toBe(1)
    expect(nextSyncPoints({ syncStreak: 0 })).toBe(25)
    expect(nextSyncPoints({ syncStreak: 7 })).toBe(200)
    expect(nextSyncPoints({ syncStreak: 30 })).toBe(200)
  })
  it('bursts only when a new beat was danced in sync', () => {
    expect(syncBurst(null, { lastSyncBeat: 4, syncStreak: 5 })).toBe(5)
    expect(syncBurst({ lastSyncBeat: null }, { lastSyncBeat: 0, syncStreak: 1 })).toBe(1)
    expect(syncBurst({ lastSyncBeat: 4 }, { lastSyncBeat: 6, syncStreak: 7 })).toBe(7)
    expect(syncBurst({ lastSyncBeat: 6 }, { lastSyncBeat: 6, syncStreak: 7 })).toBeNull() // same view again
    expect(syncBurst({ lastSyncBeat: 6 }, { lastSyncBeat: 6, syncStreak: 0 })).toBeNull() // streak broke
    expect(syncBurst({ lastSyncBeat: 6 }, { lastSyncBeat: null, syncStreak: 0 })).toBeNull() // rematch reset
  })
  it('rates the team from accuracy and the share of beats in sync', () => {
    const ps = [player('a', { accuracy: 80 }), player('b', { accuracy: 60 })]
    expect(teamStars(ps, { syncedBeats: 0 })).toBe(4) // 70 % -> 3.5 -> 4
    expect(teamStars(ps, { syncedBeats: 10 }, 100)).toBe(2) // (0.7 + 0.1) / 2 -> 2
    expect(teamStars(ps, { syncedBeats: 100 }, 100)).toBe(4)
    expect(teamStars([], { syncedBeats: 3 })).toBe(0)
  })
})

describe('hardestMoments', () => {
  it('picks the lowest averages, in song order, ignoring empty beats', () => {
    const beats = [
      { beat: 0, avgScore: 90, samples: 2 },
      { beat: 1, avgScore: 20, samples: 2 },
      { beat: 2, avgScore: 0, samples: 0 },
      { beat: 3, avgScore: 50, samples: 1 },
      { beat: 4, avgScore: 20, samples: 3 },
      { beat: 5, avgScore: 70, samples: 3 },
    ]
    expect(hardestMoments(beats).map((b) => b.beat)).toEqual([1, 3, 4])
    expect(hardestMoments([])).toEqual([])
  })
})

describe('BeatReporter', () => {
  const recorder = (fail: (call: number) => Error | null = () => null) => {
    const calls: BeatJudgement[][] = []
    const send = (beats: readonly BeatJudgement[]): Promise<void> => {
      calls.push([...beats])
      const err = fail(calls.length)
      return err ? Promise.reject(err) : Promise.resolve()
    }
    return { calls, send }
  }

  it('batches 64 a call, keeps the first judgement of a beat, and drops bad input', async () => {
    const { calls, send } = recorder()
    const r = new BeatReporter({ send })
    for (let b = 0; b < 70; b++) r.reportBeat(b, 50, 'ok')
    r.reportBeat(3, 100, 'perfect') // already reported
    r.reportBeat(-1, 50, 'ok')
    r.reportBeat(1.5, 50, 'ok')
    r.reportBeat(20_001, 50, 'ok')
    r.reportBeat(80, Number.NaN, 'ok')
    r.reportBeat(81, 150, 'perfect') // clamped
    expect(r.pending).toBe(71)
    await r.flush()
    expect(calls.map((c) => c.length)).toEqual([64, 7])
    expect(calls[0]?.[3]).toEqual({ beat: 3, score: 50, grade: 'ok' })
    expect(calls[1]?.at(-1)).toEqual({ beat: 81, score: 100, grade: 'perfect' })
    expect(r.pending).toBe(0)
  })

  it('retries a failed batch next time and sends late beats on stop', async () => {
    const { calls, send } = recorder((n) => (n === 1 ? new ApiError('Server not reachable', 0, true) : null))
    const r = new BeatReporter({ send })
    r.reportBeat(0, 95, 'perfect')
    await r.flush()
    expect(r.pending).toBe(1)
    r.reportBeat(1, 80, 'good')
    await r.stop()
    expect(calls.map((c) => c.map((j) => j.beat))).toEqual([[0], [0, 1]])
    expect(r.pending).toBe(0)
  })

  it('drops a rejected batch, and goes quiet once the seat is gone', async () => {
    const { calls, send } = recorder((n) => (n === 1 ? new ApiError('bad grade', 400, false) : n === 2 ? new ApiError('Unknown player', 401, false) : null))
    const r = new BeatReporter({ send })
    r.reportBeat(0, 10, 'miss')
    await r.flush()
    r.reportBeat(1, 10, 'miss')
    await r.flush()
    r.reportBeat(2, 10, 'miss')
    await r.flush()
    expect(calls).toHaveLength(2)
    expect(r.pending).toBe(0)
  })

  it('posts on its own timer once started', async () => {
    const { calls, send } = recorder()
    const r = new BeatReporter({ send, intervalMs: 10 })
    r.start()
    r.reportBeat(7, 77, 'good')
    await new Promise((res) => setTimeout(res, 40))
    await r.stop()
    expect(calls).toEqual([[{ beat: 7, score: 77, grade: 'good' }]])
  })
})
