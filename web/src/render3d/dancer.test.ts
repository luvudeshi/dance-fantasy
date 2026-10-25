import { afterEach, describe, expect, it, vi } from 'vitest'

type DancerModule = typeof import('./dancer')

function memoryStorage(init: Record<string, string> = {}): { data: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const data = new Map(Object.entries(init))
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

/** A fresh copy of the store, as loaded on a page with this storage and hash. */
async function load(storage: ReturnType<typeof memoryStorage>, hash = ''): Promise<DancerModule> {
  vi.resetModules()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('location', { hash })
  return import('./dancer')
}

afterEach(() => vi.unstubAllGlobals())

describe('dancer store', () => {
  it('defaults to the princess (nothing saved, junk saved, unreadable storage)', async () => {
    expect((await load(memoryStorage())).getDancer()).toBe('princess')
    expect((await load(memoryStorage({ 'dance-fantasy:dancer': '"frog"' }))).getDancer()).toBe('princess')
    expect((await load(memoryStorage({ 'dance-fantasy:dancer': '{oops' }))).getDancer()).toBe('princess')
  })

  it('remembers the choice across loads', async () => {
    const storage = memoryStorage()
    const a = await load(storage)
    a.setDancer('prince')
    expect(a.getDancer()).toBe('prince')
    expect(storage.data.get(a.DANCER_KEY)).toBe('"prince"')
    expect((await load(storage)).getDancer()).toBe('prince')
  })

  it('lets ?dancer= in the hash query override the saved choice, without saving it', async () => {
    const storage = memoryStorage({ 'dance-fantasy:dancer': '"princess"' })
    const m = await load(storage, '#/moves?dancer=prince')
    expect(m.getDancer()).toBe('prince')
    expect(storage.data.get(m.DANCER_KEY)).toBe('"princess"')
    expect((await load(storage, '#/moves?dancer=wizard')).getDancer()).toBe('princess')
    expect(m.dancerFromHash('#/play?routine=0123456789abcdef&dancer=princess')).toBe('princess')
    expect(m.dancerFromHash('#/play')).toBeNull()
    // Picking one in Settings ends the override.
    m.setDancer('princess')
    expect(m.getDancer()).toBe('princess')
  })

  it('notifies subscribers on a change only, until they unsubscribe', async () => {
    const m = await load(memoryStorage())
    const seen: string[] = []
    const off = m.subscribeDancer(() => seen.push(m.getDancer()))
    m.setDancer('prince')
    m.setDancer('prince')
    m.setDancer('princess')
    off()
    m.setDancer('prince')
    expect(seen).toEqual(['prince', 'princess'])
  })
})
