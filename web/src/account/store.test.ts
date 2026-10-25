import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The remembered room ("You are in room BQKV" / "Invite to my room") against a mocked server.

const ROOM_KEY = 'df.account.room'
const GONE = { detail: 'No room with that code (it may have expired).' }
const PEEK = { code: 'BQKV', state: 'finished', playerCount: 2, mode: 'versus' } // results screen: still open

function memoryStorage(init: Record<string, string>): Storage {
  const m = new Map(Object.entries(init))
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  }
}

/** A fresh store in a tab that remembers `room` (the store reads sessionStorage once, on import). */
async function storeIn(room: string) {
  const storage = memoryStorage({ [ROOM_KEY]: room })
  vi.stubGlobal('sessionStorage', storage)
  vi.resetModules()
  return { store: await import('./store'), storage }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** fetch answering "METHOD /path" routes; anything else fails the test. */
function mockServer(routes: Record<string, () => Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = routes[`${init?.method ?? 'GET'} ${String(input)}`]
    if (!route) throw new Error(`unexpected ${init?.method} ${String(input)}`)
    return route()
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('checkRoom', () => {
  it('forgets a room that has closed', async () => {
    const { store, storage } = await storeIn('BQKV')
    const server = mockServer({ 'GET /api/rooms/BQKV': () => json(GONE, 404) })
    await expect(store.checkRoom()).resolves.toBeNull()
    expect(storage.getItem(ROOM_KEY)).toBeNull()
    await expect(store.checkRoom()).resolves.toBeNull() // nothing left to ask about
    expect(server).toHaveBeenCalledTimes(1)
  })

  it('keeps an open room, and keeps it when the check itself fails', async () => {
    const { store, storage } = await storeIn('BQKV')
    mockServer({ 'GET /api/rooms/BQKV': () => json(PEEK) })
    await expect(store.checkRoom()).resolves.toBe('BQKV')
    mockServer({ 'GET /api/rooms/BQKV': () => json({ detail: 'Too many unknown room codes; wait a minute.' }, 429) })
    await expect(store.checkRoom()).resolves.toBe('BQKV')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(store.checkRoom()).resolves.toBe('BQKV')
    expect(storage.getItem(ROOM_KEY)).toBe('BQKV')
  })
})

describe('inviteToRoom', () => {
  it('says the room has closed and forgets it', async () => {
    const { store, storage } = await storeIn('BQKV')
    mockServer({
      'POST /api/friends/f1/invite': () => json(GONE, 404),
      'GET /api/rooms/BQKV': () => json(GONE, 404),
    })
    await expect(store.inviteToRoom('f1', 'BQKV')).rejects.toThrow('Room BQKV has closed.')
    expect(storage.getItem(ROOM_KEY)).toBeNull()
  })

  it('passes other failures through and keeps an open room', async () => {
    const { store, storage } = await storeIn('BQKV')
    mockServer({
      'POST /api/friends/f1/invite': () => json({ detail: "That dancer isn't in your friends list." }, 404),
      'GET /api/rooms/BQKV': () => json(PEEK),
    })
    await expect(store.inviteToRoom('f1', 'BQKV')).rejects.toThrow("That dancer isn't in your friends list.")
    expect(storage.getItem(ROOM_KEY)).toBe('BQKV')

    const server = mockServer({ 'POST /api/friends/f1/invite': () => json({ ok: true }) })
    await expect(store.inviteToRoom('f1', 'BQKV')).resolves.toBeUndefined()
    expect(JSON.parse(String(server.mock.calls[0][1]?.body))).toEqual({ roomCode: 'BQKV' })
  })
})
