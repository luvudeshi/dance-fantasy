import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComboEvent } from '@shared/combo-event'
import { setComboEventSink } from './comboEvents'
import { MemoryClipStore } from './clipStore'
import { createReelSession, getSharedHighlights, ReelSession } from './reelSession'
import { fakeRecorders, fakeStream, results } from './testUtil'

const game = {
  analysis: { id: 'song1', title: 'Vibe Ace', audioUrl: '/api/songs/vibe.mp3' },
  routine: { moves: Array.from({ length: 10 }, (_, i) => ({ id: `move${i}`, name: `Move ${i}` })) },
} as unknown as Parameters<ReelSession['begin']>[0]

function session() {
  const store = new MemoryClipStore()
  const rec = fakeRecorders()
  const camera = fakeStream()
  const s = new ReelSession({ store, createRecorder: rec.factory, mimeType: 'video/webm', streamFor: (src) => (src === camera ? camera : null) })
  return { s, store, rec, camera }
}

let events: ComboEvent[] = []
beforeEach(() => {
  vi.useFakeTimers()
  events = []
  setComboEventSink((e) => events.push(e))
})
afterEach(() => {
  setComboEventSink(null)
  vi.useRealTimers()
})

describe('ReelSession', () => {
  it('records a round, then clears it (and its stored videos) on close', async () => {
    const { s, store, camera } = session()
    let t = 0
    s.begin(game, camera, () => t, 0.1)
    for (const r of results('PPPPPPPPPPM')) {
      t = r.checkpoint.time + 0.2
      s.feed([r])
    }
    expect(s.ready).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    await s.finish()
    expect(s.ready).toBe(true)
    expect(s.clips()).toHaveLength(1)
    expect(s.clips()[0].mirrorVideo).toBe(true)
    expect(store.blobs.size).toBe(1)
    expect(events.map((e) => [e.songId, e.comboLength, e.roomId])).toEqual([['song1', 10, null]])
    expect(s.awards().map((a) => a.kind)).toEqual(['longestCombo', 'hypeMaster'])
    expect(s.title).toBe('Vibe Ace')
    await s.clear()
    expect(s.clips()).toEqual([])
    expect(store.blobs.size).toBe(0)
    expect(s.ready).toBe(false)
  })

  it('a new round drops the previous round', async () => {
    const { s, store, camera } = session()
    s.begin(game, camera, () => 0, 0)
    s.feed(results('PPPPPPPP'))
    await s.finish()
    expect(store.blobs.size).toBe(1)
    s.begin(game, camera, () => 0, 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(s.clips()).toEqual([])
    expect(store.blobs.size).toBe(0)
  })

  it('results after the song ended are ignored', async () => {
    const { s, camera } = session()
    s.begin(game, camera, () => 0, 0)
    await s.finish()
    s.feed(results('PPPPPPPPPP'))
    expect(s.clips()).toEqual([])
  })

  it('shares highlights only while the toggle is on (off by default)', async () => {
    const { s, camera } = session()
    s.begin(game, camera, () => 0, 0)
    s.feed(results('PPPPPPPP'))
    await s.finish()
    expect(s.sharing).toBe(false)
    expect(await s.sharedHighlights()).toBeNull()
    s.setSharing(true)
    const shared = await s.sharedHighlights()
    expect(shared?.clips).toHaveLength(1)
    expect(shared?.clips[0].blob).toBeInstanceOf(Blob)
    await s.clear()
    expect(s.sharing).toBe(false)
    expect(await s.sharedHighlights()).toBeNull()
  })

  it('takes several players for one reel (rooms seam)', async () => {
    const { s, camera } = session()
    s.begin(game, camera, () => 0, 0)
    s.feed(results('PPPPPPPP'))
    await s.finish()
    s.addPlayer({
      stats: { playerId: 'p2', playerName: 'Ana', longestCombo: 20, perfects: 3, freezes: [] },
      clips: [{ ...s.clips()[0], id: 'remote1', playerId: 'p2', playerName: 'Ana', comboLength: 20 }],
    })
    expect(s.players().map((p) => p.stats.playerId)).toEqual(['local', 'p2'])
    expect(s.clips()).toHaveLength(2)
    const awards = s.awards()
    expect(awards.find((a) => a.kind === 'longestCombo')?.playerName).toBe('Ana')
    expect(awards.find((a) => a.kind === 'hypeMaster')?.playerId).toBe('local')
  })

  it('the flag decides whether there is a session at all', async () => {
    expect(createReelSession(false)).toBeNull()
    expect(await getSharedHighlights()).toBeNull()
    expect(createReelSession(true, { store: new MemoryClipStore(), createRecorder: null, mimeType: null })).toBeInstanceOf(ReelSession)
  })
})
