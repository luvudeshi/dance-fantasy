import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api'
import { isModeRoom, type BeatJudgement, type ModePlayer, type ModeRoom } from './api'
import { BeatReporter } from './beatReporter'
import { beatsWonLabel, hardestMoments, nextSyncPoints, syncBurst, syncMeter, teamStars, tokenFor, tugShare, versusRows } from './modeStats'

const player = (id: string, over: Partial<ModePlayer> = {}): ModePlayer => ({
  id,
  name: id,
  isHost: false,
  ready: false,
  connected: true,
  score: 0,
  accuracy: 0,
  progress: 0,
  finished: false,
  beatsWon: 0,
  ...over,
})

const crew = { teamScore: 0, syncBonus: 0, syncedBeats: 0, syncStreak: 0, bestSyncStreak: 0, lastSyncBeat: null }

// the RoomView example from shared/README.md, plus the extra fields a real response carries
const VIEW = {
  code: 'KQWX',
  state: 'lobby',
  hostId: 'Zp3k9QxA',
  serverNow: 1761380000000,
  startAt: null,
  routine: null,
  mode: 'versus',
  players: [
    { id: 'Zp3k9QxA', name: 'Ana', isHost: true, ready: false, connected: true, score: 0, combo: 0, maxCombo: 0, accuracy: 0, progress: 0, finished: false, beatsWon: 0 },
  ],
  leaderId: null,
  crew,
  chat: [{ id: 12, playerId: 'Zp3k9QxA', name: 'Ana', text: 'ready?', at: 1761379990000 }],
}

describe('isModeRoom', () => {
  it('accepts the documented RoomView', () => {
    expect(isModeRoom(VIEW)).toBe(true)
    expect(isModeRoom({ ...VIEW, mode: 'crew', routine: { routineId: 'r', analysisId: 'a', title: 'Song', difficulty: 'easy', mode: 'standing' } })).toBe(true)
  })
  it('rejects a view without the mode fields', () => {
    expect(isModeRoom({ ...VIEW, mode: 'solo' })).toBe(false)
    expect(isModeRoom({ ...VIEW, crew: undefined })).toBe(false)
    expect(isModeRoom({ ...VIEW, players: [{ ...VIEW.players[0], beatsWon: undefined }] })).toBe(false)
    expect(isModeRoom(null)).toBe(false)
  })
})

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
  it('has zero-length bars before anyone wins a beat', () => {
    expect(versusRows({ leaderId: null, players: [player('a'), player('b')] }).map((r) => r.share)).toEqual([0, 0])
  })
  it('splits head to head', () => {
    expect(tugShare({ beatsWon: 3 }, { beatsWon: 1 })).toBe(0.75)
    expect(tugShare({ beatsWon: 0 }, { beatsWon: 0 })).toBe(0.5)
  })
  it('gives tokens by join order', () => {
    const ps = [player('a'), player('b')]
    expect(tokenFor(ps, 'a')).toBe('slipper')
    expect(tokenFor(ps, 'b')).toBe('frog-prince')
    expect(beatsWonLabel(1)).toBe('1 beat won')
    expect(beatsWonLabel(4)).toBe('4 beats won')
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
  const room = VIEW as ModeRoom
  const recorder = (fail: (call: number) => Error | null = () => null) => {
    const calls: BeatJudgement[][] = []
    const send = (beats: readonly BeatJudgement[]): Promise<ModeRoom> => {
      calls.push([...beats])
      const err = fail(calls.length)
      return err ? Promise.reject(err) : Promise.resolve(room)
    }
    return { calls, send }
  }

  it('batches 64 a call, keeps the first judgement of a beat, and drops bad input', async () => {
    const { calls, send } = recorder()
    const views: ModeRoom[] = []
    const r = new BeatReporter({ send, onRoom: (v) => views.push(v) })
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
    expect(views).toHaveLength(2)
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
