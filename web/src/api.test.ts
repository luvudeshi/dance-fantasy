import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiUrl, beatsForSong, beatsForUpload, listSongs, SERVER_UNREACHABLE_MESSAGE, songAudioUrl } from './api'

const BEATS = {
  song: 'synth_120bpm.wav',
  durationSec: 64,
  sampleRate: 22050,
  tempo: 120.2,
  bpmFromBeats: 120,
  beats: [0.51, 1.01],
  elapsedMs: 412.3,
}

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api', () => {
  it('builds same-origin URLs and encodes file names', () => {
    expect(apiUrl('/api/health')).toBe('/api/health')
    expect(songAudioUrl('my song #1.mp3')).toBe('/api/songs/my%20song%20%231.mp3')
  })

  it('parses and validates a BeatResult', async () => {
    const f = mockFetch(async () => json(BEATS))
    await expect(beatsForSong('a b.wav')).resolves.toEqual(BEATS)
    expect(f.mock.calls[0][0]).toBe('/api/spike/beats?song=a%20b.wav')
  })

  it('uploads multipart with field "file"', async () => {
    const f = mockFetch(async () => json(BEATS))
    await beatsForUpload(new File([new Uint8Array([1, 2, 3])], 'clip.wav', { type: 'audio/wav' }))
    const init = f.mock.calls[0][1]
    expect(init?.method).toBe('POST')
    const body = init?.body
    expect(body).toBeInstanceOf(FormData)
    if (body instanceof FormData) {
      const file = body.get('file')
      expect(file).toBeInstanceOf(File)
      if (file instanceof File) expect(file.name).toBe('clip.wav')
    }
  })

  it('throws the FastAPI detail on errors', async () => {
    mockFetch(async () => json({ detail: 'unknown song: x.wav' }, 404))
    await expect(beatsForSong('x.wav')).rejects.toMatchObject({ message: 'unknown song: x.wav', status: 404, unreachable: false })
    mockFetch(async () => json({ detail: [{ msg: 'Field required' }, { msg: 'bad' }] }, 422))
    await expect(beatsForSong('x.wav')).rejects.toThrow('Field required; bad')
  })

  it('reports an unreachable server (network error or dev-proxy 502)', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(listSongs()).rejects.toMatchObject({ message: SERVER_UNREACHABLE_MESSAGE, unreachable: true, status: 0 })
    mockFetch(async () => new Response('', { status: 502 }))
    await expect(listSongs()).rejects.toMatchObject({ message: SERVER_UNREACHABLE_MESSAGE, unreachable: true, status: 502 })
  })

  it('rejects responses that do not match the contract', async () => {
    mockFetch(async () => json([{ file: 'a.wav', title: 'A' }]))
    await expect(listSongs()).rejects.toBeInstanceOf(ApiError)
    mockFetch(async () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    await expect(listSongs()).rejects.toThrow(/Unexpected response/)
  })

  it('passes AbortError through untouched', async () => {
    mockFetch(async () => {
      throw new DOMException('Aborted', 'AbortError')
    })
    await expect(listSongs()).rejects.toMatchObject({ name: 'AbortError' })
  })
})
