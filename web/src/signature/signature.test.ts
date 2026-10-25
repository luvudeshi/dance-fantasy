import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fetchSignature, formatMoment, isSignature, moveNames, safeUrl } from './signature'

// The server's JSON (pydantic serialises missing optionals as null).
const SAMPLE = {
  found: true,
  summary: 'Arms swing overhead, then a hip bump.',
  keyMoments: [{ label: 'Chorus arm swing', approxTimeSec: 42 }, { label: 'Hip bump', approxTimeSec: null }],
  suggestedMoveIds: ['hello_wave_R', 'clap_clap'],
  sources: [{ title: 'Tutorial', link: 'https://www.youtube.com/watch?v=x', thumbnail: null, source: 'YouTube' }],
}

describe('signature helpers', () => {
  it('accepts the server shape and rejects broken ones', () => {
    expect(isSignature(SAMPLE)).toBe(true)
    expect(isSignature({ ...SAMPLE, keyMoments: [{ label: 3 }] })).toBe(false)
    expect(isSignature({ ...SAMPLE, sources: [{ title: 't', link: 'https://x' }] })).toBe(false) // no source name
    expect(isSignature({ ...SAMPLE, suggestedMoveIds: [1] })).toBe(false)
    expect(isSignature({ detail: 'nope' })).toBe(false)
  })

  it('only lets http(s) links through (https for thumbnails)', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeUrl('http://example.com/a')).toBe('http://example.com/a')
    expect(safeUrl('http://example.com/a.jpg', true)).toBeNull()
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('not a url')).toBeNull()
    expect(safeUrl(null)).toBeNull()
  })

  it('formats key-moment times', () => {
    expect(formatMoment(65)).toBe('1:05')
    expect(formatMoment(0)).toBe('0:00')
    expect(formatMoment(null)).toBeNull()
    expect(formatMoment(-3)).toBeNull()
  })

  it('names moves, tidying ids the library no longer has', () => {
    expect(moveNames(['clap_clap', 'sky_clap'], new Map([['clap_clap', 'Clap Clap']]))).toEqual([
      { id: 'clap_clap', name: 'Clap Clap' },
      { id: 'sky_clap', name: 'Sky Clap' },
    ])
  })
})

describe('fetchSignature', () => {
  it('reports an unreachable server as an error, not as "not configured"', async () => {
    const probe = createServer()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/api/songs/signature`
    await new Promise<void>((r) => probe.close(() => r()))
    expect((await fetchSignature('Vibe Ace', '', undefined, url)).status).toBe('error')
  })
})
