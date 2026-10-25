import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JointName, Pose2D } from '@shared/skeleton'
import { ScoreKeeper, type Checkpoint } from '../game/scoring'
import { NEUTRAL_POSE } from '../routine/pose'
import { isRoomView, mergeChat, normalizeCode, rankPlayers, type ChatMessage, type RoomPlayer, type ScoreBody } from './client'
import { createScoreReporter, liveScore } from './gameLink'
import { bestOffset, clockSample } from './useRoom'

// The RoomView example from shared/README.md ("Stage 6 endpoints").
const VIEW = {
  code: 'KQWX',
  state: 'lobby',
  hostId: 'Zp3k9QxA',
  serverNow: 1761380000000,
  startAt: null,
  routine: null,
  players: [{ id: 'Zp3k9QxA', name: 'Ana', isHost: true, ready: false, connected: true, score: 0, combo: 0, maxCombo: 0, accuracy: 0, progress: 0, finished: false }],
  chat: [{ id: 12, playerId: 'Zp3k9QxA', name: 'Ana', text: 'ready?', at: 1761379990000 }],
}

const player = (id: string, score: number, accuracy = 50): RoomPlayer => ({ ...VIEW.players[0]!, id, name: id, isHost: false, score, accuracy })
const msg = (id: number): ChatMessage => ({ id, playerId: 'p', name: 'Ana', text: `m${id}`, at: id })

describe('rooms client', () => {
  it('accepts the documented RoomView and a started one', () => {
    expect(isRoomView(VIEW)).toBe(true)
    const routine = { routineId: '0123456789abcdef', analysisId: 'a'.repeat(64), title: 'Waltz', difficulty: 'easy', mode: 'seated' }
    expect(isRoomView({ ...VIEW, state: 'countdown', startAt: 1761380005000, routine })).toBe(true)
  })

  it('rejects malformed views', () => {
    expect(isRoomView({ ...VIEW, state: 'paused' })).toBe(false)
    expect(isRoomView({ ...VIEW, startAt: '5' })).toBe(false)
    expect(isRoomView({ ...VIEW, routine: { title: 'x' } })).toBe(false)
    expect(isRoomView({ ...VIEW, players: [{ ...VIEW.players[0], score: '9' }] })).toBe(false)
    expect(isRoomView({ ...VIEW, chat: [{ id: 'x' }] })).toBe(false)
    expect(isRoomView(null)).toBe(false)
  })

  it('normalizes room codes (no I, L, O; four letters)', () => {
    expect(normalizeCode(' kqwx ')).toBe('KQWX')
    expect(normalizeCode('KQWI')).toBeNull()
    expect(normalizeCode('KQW')).toBeNull()
    expect(normalizeCode('KQ1X')).toBeNull()
    expect(normalizeCode(null)).toBeNull()
  })

  it('ranks by score, then accuracy, then join order', () => {
    const ranked = rankPlayers([player('a', 100), player('b', 300), player('c', 100, 90), player('d', 100)])
    expect(ranked.map((p) => p.id)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('appends only new chat messages and caps the history', () => {
    const have = [msg(1), msg(2)]
    expect(mergeChat(have, [msg(2), msg(3)]).map((m) => m.id)).toEqual([1, 2, 3])
    expect(mergeChat(have, [msg(1)])).toEqual(have)
    expect(mergeChat([], [msg(1), msg(2), msg(3)], 2).map((m) => m.id)).toEqual([2, 3])
  })
})

describe('server clock', () => {
  it('assumes serverNow sits mid round trip and trusts the quickest trip', () => {
    expect(clockSample(10_500, 1000, 2000)).toEqual({ offset: 9000, rtt: 1000 })
    const slow = clockSample(5000, 0, 400) // offset 4800, rtt 400
    const fast = clockSample(5100, 200, 220) // offset 4890, rtt 20
    expect(bestOffset([slow, fast, clockSample(9000, 0, 300)])).toBe(4890)
    expect(bestOffset([])).toBe(0)
  })
})

describe('score reporter', () => {
  const sent: ScoreBody[] = []
  const body = (score: number, finished = false): ScoreBody => ({ score, combo: 1, maxCombo: 2, accuracy: 50, progress: 0.5, finished })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    sent.length = 0
  })
  afterEach(() => vi.useRealTimers())

  it('sends at most once a second, the latest value winning', async () => {
    const r = createScoreReporter(async (s) => sent.push(s))
    r.report(body(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.map((s) => s.score)).toEqual([1])
    for (let i = 2; i <= 10; i++) r.report(body(i))
    await vi.advanceTimersByTimeAsync(999)
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sent.map((s) => s.score)).toEqual([1, 10])
  })

  it('sends the finished score at once, retries it, then ignores later reports', async () => {
    let fails = 1
    const r = createScoreReporter(async (s) => {
      if (fails-- > 0) throw new Error('offline')
      sent.push(s)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    r.report(body(5))
    r.report(body(7, true))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([]) // the first try failed
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent.map((s) => [s.score, s.finished])).toEqual([[7, true]])
    r.report(body(8))
    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveLength(1)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('liveScore', () => {
  /** Right arm straight up. */
  const RAISED: Pose2D = { ...NEUTRAL_POSE, r_elbow: [0.55, -1.55], r_wrist: [0.6, -2.1] }
  const visible = Object.fromEntries(Object.keys(NEUTRAL_POSE).map((j) => [j, 1])) as Record<JointName, number>
  const cp = (index: number, time: number): Checkpoint => ({ index, moveIndex: 0, time, target: RAISED, limbs: ['r_upper_arm', 'r_forearm'], resting: [] })

  it('reports points, combo, mean checkpoint accuracy and progress from a real ScoreKeeper', () => {
    const keeper = new ScoreKeeper([cp(0, 1), cp(1, 2)])
    keeper.addFrame({ songTime: 1, pose: RAISED, visibility: visible, valid: true })
    keeper.advanceTo(3) // checkpoint 2 gets no frame: a miss
    const s = liveScore(keeper, 15, 60)
    expect(s.accuracy).toBeCloseTo(50, 0)
    expect(s.score).toBe(keeper.state.score)
    expect(s.score).toBeGreaterThan(0)
    expect(s.combo).toBe(0)
    expect(s.maxCombo).toBe(1)
    expect(s.progress).toBe(0.25)
    expect(s.finished).toBe(false)
    expect(liveScore(keeper, 90, 60).progress).toBe(1)
    expect(liveScore(new ScoreKeeper([]), 1, 0).progress).toBe(0) // degenerate duration
  })
})
