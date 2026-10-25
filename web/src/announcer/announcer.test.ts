import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { rankTitle } from '../game/results'
import type { ResultsSummary } from '../game/scoring'
import {
  comboMoment,
  createAnnouncer,
  holdMs,
  IN_GAME_WAIT_MS,
  isAnnouncerReply,
  isPerfectRun,
  localLine,
  nextMilestone,
  pickVoice,
  resultsContext,
} from './announcer'

function summary(o: { miss?: number; accuracy?: number; stars?: number; judged?: number } = {}): ResultsSummary {
  const move = (name: string) => ({ moveIndex: 0, id: name, name, avgScore: 50, checkpoints: 4 })
  return {
    state: {
      score: 9820.4,
      combo: 0,
      maxCombo: 34,
      counts: { perfect: 30, good: 10, ok: 3, miss: o.miss ?? 2 },
      stars: o.stars ?? 4.6,
      judged: o.judged ?? 45,
      total: 45,
    },
    accuracy: o.accuracy ?? 88.4,
    perMove: [],
    hardestMove: move('Disco Fever Left'),
    bestMove: move('Raise the Roof'),
  }
}

describe('comboMoment', () => {
  it('calls out 10, 25, then every 50', () => {
    expect(comboMoment([{ combo: 10 }], 9)).toEqual({ event: 'combo', combo: 10 })
    expect(comboMoment([{ combo: 25 }], 24)).toEqual({ event: 'combo', combo: 25 })
    expect(comboMoment([{ combo: 50 }], 49)).toEqual({ event: 'combo', combo: 50 })
    expect(comboMoment([{ combo: 100 }], 99)).toEqual({ event: 'combo', combo: 100 })
    expect(comboMoment([{ combo: 11 }], 10)).toBeNull()
    expect(comboMoment([{ combo: 75 }], 74)).toBeNull()
  })

  it('finds a milestone crossed inside a batch', () => {
    expect(comboMoment([{ combo: 9 }, { combo: 10 }, { combo: 11 }], 8)).toEqual({ event: 'combo', combo: 10 })
  })

  it('flags a broken streak only from STREAK_MIN up', () => {
    expect(comboMoment([{ combo: 0 }], 14)).toEqual({ event: 'streak_broken', combo: 14 })
    expect(comboMoment([{ combo: 0 }], 9)).toBeNull()
  })

  it('lets the last moment of a batch win', () => {
    expect(comboMoment([{ combo: 10 }, { combo: 0 }], 9)).toEqual({ event: 'streak_broken', combo: 10 })
    expect(comboMoment([{}, {}], 12)).toBeNull() // results without a combo keep the previous one
  })
})

describe('results helpers', () => {
  it('next milestones', () => {
    expect([0, 9, 10, 24, 25, 50, 51].map(nextMilestone)).toEqual([10, 10, 25, 25, 50, 100, 100])
  })

  it('a perfect run has no misses and five-star accuracy', () => {
    expect(isPerfectRun(summary({ miss: 0, accuracy: 90 }))).toBe(true)
    expect(isPerfectRun(summary({ miss: 1, accuracy: 99 }))).toBe(false)
    expect(isPerfectRun(summary({ miss: 0, accuracy: 70 }))).toBe(false)
    expect(isPerfectRun(summary({ miss: 0, accuracy: 90, judged: 0 }))).toBe(false)
  })

  it('maps the summary to announcer context like the results screen shows it', () => {
    expect(resultsContext(summary())).toEqual({
      score: 9820,
      accuracy: 88,
      maxCombo: 34,
      stars: 4,
      grade: rankTitle(4.6),
      bestMove: 'Raise the Roof',
      hardestMove: 'Disco Fever Left',
    })
  })

  it('a round with no hits names no combo and no best move', () => {
    const s = summary({ accuracy: 0, stars: 0 })
    const ctx = resultsContext({ ...s, state: { ...s.state, maxCombo: 0 }, bestMove: s.bestMove && { ...s.bestMove, avgScore: 0 } })
    expect(ctx.maxCombo).toBeUndefined()
    expect(ctx.bestMove).toBeUndefined()
  })

  it('local lines fill in the song and score', () => {
    expect(localLine('intro', { songTitle: 'Vibe Ace' }, () => 0)).toContain('Vibe Ace')
    expect(localLine('results', { songTitle: 'x', score: 12345 }, () => 0)).toContain('12,345')
    for (const event of ['intro', 'combo', 'streak_broken', 'perfect_run', 'results'] as const) {
      const line = localLine(event, { songTitle: 'S'.repeat(200), combo: 10 }, () => 0.999)
      expect(line.length).toBeGreaterThan(0)
      expect(line.length).toBeLessThanOrEqual(90)
    }
  })

  it('validates replies', () => {
    expect(isAnnouncerReply({ lines: ['Hear ye!'], source: 'canned' })).toBe(true)
    expect(isAnnouncerReply({ lines: [], source: 'canned' })).toBe(false)
    expect(isAnnouncerReply({ lines: [' '], source: 'muse' })).toBe(false)
    expect(isAnnouncerReply({ lines: ['x'], source: 'gpt' })).toBe(false)
    expect(isAnnouncerReply(null)).toBe(false)
  })

  it('holds a line long enough to read, never forever', () => {
    expect(holdMs('Hi!')).toBeGreaterThanOrEqual(2200)
    expect(holdMs('x'.repeat(90))).toBeLessThanOrEqual(7000)
  })
})

describe('pickVoice', () => {
  const v = (name: string, lang: string) => ({ name, lang })
  it('prefers a named British voice, then any British, then any English', () => {
    expect(pickVoice([v('Samantha', 'en-US'), v('Kate', 'en-GB'), v('Daniel', 'en-GB')])?.name).toBe('Daniel')
    expect(pickVoice([v('Samantha', 'en-US'), v('Fiona', 'en-GB')])?.name).toBe('Fiona')
    expect(pickVoice([v('Thomas', 'fr-FR'), v('Samantha', 'en-US')])?.name).toBe('Samantha')
    expect(pickVoice([v('Thomas', 'fr-FR')])).toBeNull()
  })
})

// The herald against real sockets: a port nobody listens on (server down) and a server that never answers.
describe('createAnnouncer', () => {
  let closedUrl = ''
  let silent: Server
  let silentUrl = ''

  beforeAll(async () => {
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    closedUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/api/announcer`
    await new Promise<void>((r) => probe.close(() => r()))
    silent = createServer(() => {
      // never answers
    })
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
    silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/api/announcer`
  })
  afterAll(() => {
    silent.closeAllConnections()
    silent.close()
  })

  const on = { enabled: true, voice: true }

  it('falls back to a local line when the server is down, and speaks it', async () => {
    const spoken: string[] = []
    const a = createAnnouncer({ endpoint: closedUrl, prefs: () => on, speak: (l) => spoken.push(l), stop: () => {} })
    a.intro({ songTitle: 'Vibe Ace' })
    await vi.waitFor(() => expect(a.getSnapshot()?.event).toBe('intro'))
    expect(spoken).toEqual([a.getSnapshot()?.line])
    a.hush()
    expect(a.getSnapshot()).toBeNull()
    a.dispose()
  })

  it('does not wait for a slow server during the song', async () => {
    const a = createAnnouncer({ endpoint: silentUrl, prefs: () => ({ enabled: true, voice: false }), speak: () => {}, stop: () => {} })
    a.intro({ songTitle: 'Vibe Ace' })
    const t0 = performance.now()
    a.onResults([{ combo: 10 }], 9)
    await vi.waitFor(() => expect(a.getSnapshot()?.event).toBe('combo'), { timeout: IN_GAME_WAIT_MS + 1000 })
    expect(performance.now() - t0).toBeLessThan(IN_GAME_WAIT_MS + 500)
    a.dispose()
  })

  it('stays silent while switched off, and hush drops a moment still waiting', async () => {
    const off = createAnnouncer({ endpoint: closedUrl, prefs: () => ({ enabled: false, voice: true }), speak: () => {}, stop: () => {} })
    off.intro({ songTitle: 'Vibe Ace' })
    const waiting = createAnnouncer({ endpoint: silentUrl, prefs: () => on, speak: () => {}, stop: () => {} })
    waiting.intro({ songTitle: 'Vibe Ace' })
    waiting.onResults([{ combo: 10 }], 9)
    waiting.hush()
    await new Promise((r) => setTimeout(r, IN_GAME_WAIT_MS + 200))
    expect(off.getSnapshot()).toBeNull()
    expect(waiting.getSnapshot()).toBeNull()
    off.dispose()
    waiting.dispose()
  })
})
