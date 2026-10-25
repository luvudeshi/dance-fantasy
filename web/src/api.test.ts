import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Analysis } from '@shared/analysis'
import type { Routine } from '@shared/routine'
import routineExample from '@shared/examples/routine.example.json'
import { DEMO_LIBRARY } from './routine/demo'
import {
  analyzeLibrarySong,
  choreograph,
  getMoves,
  getRoutine,
  isRoutine,
  analyzeUpload,
  ApiError,
  apiUrl,
  beatsForSong,
  beatsForUpload,
  fetchAudio,
  getAnalysis,
  isAnalysis,
  listSongs,
  SERVER_UNREACHABLE_MESSAGE,
  songAudioUrl,
} from './api'

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

const ANALYSIS: Analysis = {
  id: 'a'.repeat(64),
  analysisVersion: 1,
  title: 'Synth Ball 120',
  artist: 'Dance Fantasy test synth',
  source: { kind: 'library', file: 'synth_120bpm.wav' },
  audioUrl: '/api/songs/synth_120bpm.wav',
  durationSec: 4,
  sampleRate: 22050,
  bpm: 120,
  beatsPerBar: 4,
  beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
  filledBeats: [7],
  downbeats: [0, 2],
  downbeatPhase: 0,
  onsetEnvelope: { hopSec: 0.05, values: [0, 1, 0.5] },
  beatEnergy: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
  sections: [{ start: 0, end: 4, label: 'intro', energy: 0.4, group: 'A', startBeat: 0, endBeat: 8, bars: 2 }],
  elapsedMs: 812.5,
  cached: false,
}

describe('analysis api', () => {
  it('validates Analysis structurally', () => {
    expect(isAnalysis(ANALYSIS)).toBe(true)
    const { artist: _artist, ...noArtist } = ANALYSIS
    expect(isAnalysis(noArtist)).toBe(true)
    expect(isAnalysis({ ...ANALYSIS, beatsPerBar: 3 })).toBe(false)
    expect(isAnalysis({ ...ANALYSIS, cached: 'no' })).toBe(false)
    expect(isAnalysis({ ...ANALYSIS, source: { kind: 'disk' } })).toBe(false)
    expect(isAnalysis({ ...ANALYSIS, onsetEnvelope: { values: [] } })).toBe(false)
    expect(isAnalysis({ ...ANALYSIS, sections: [{ ...ANALYSIS.sections[0], label: 'drop' }] })).toBe(false)
    expect(isAnalysis({ ...ANALYSIS, beats: [0, 'x'] })).toBe(false)
  })

  it('GETs a library song analysis, with ?refresh=1 on demand', async () => {
    const f = mockFetch(async () => json(ANALYSIS))
    await expect(analyzeLibrarySong('my song.wav')).resolves.toEqual(ANALYSIS)
    expect(f.mock.calls[0][0]).toBe('/api/songs/my%20song.wav/analysis')
    await analyzeLibrarySong('a.wav', { refresh: true })
    expect(f.mock.calls[1][0]).toBe('/api/songs/a.wav/analysis?refresh=1')
  })

  it('POSTs uploads to /api/analyze with file + optional title', async () => {
    const f = mockFetch(async () => json({ ...ANALYSIS, source: { kind: 'upload', file: 'clip.mp3' } }))
    const file = new File([new Uint8Array([1, 2, 3])], 'clip.mp3', { type: 'audio/mpeg' })
    await analyzeUpload(file, { title: 'My Clip', refresh: true })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('/api/analyze?refresh=1')
    expect(init?.method).toBe('POST')
    const body = init?.body
    expect(body).toBeInstanceOf(FormData)
    if (body instanceof FormData) {
      expect(body.get('title')).toBe('My Clip')
      const sent = body.get('file')
      expect(sent instanceof File && sent.name).toBe('clip.mp3')
    }
    await analyzeUpload(file)
    const second = f.mock.calls[1]
    expect(second[0]).toBe('/api/analyze')
    const body2 = second[1]?.body
    expect(body2 instanceof FormData && body2.has('title')).toBe(false)
  })

  it('gets a cached analysis by id and reports 400/404 details', async () => {
    const f = mockFetch(async () => json(ANALYSIS))
    await getAnalysis(ANALYSIS.id)
    expect(f.mock.calls[0][0]).toBe(`/api/analysis/${ANALYSIS.id}`)
    mockFetch(async () => json({ detail: 'Could not analyze this audio (no beats).' }, 400))
    await expect(analyzeLibrarySong('x.wav')).rejects.toMatchObject({ status: 400, message: 'Could not analyze this audio (no beats).' })
    mockFetch(async () => json({ ...ANALYSIS, beats: null }))
    await expect(getAnalysis('x')).rejects.toThrow(/Unexpected response/)
  })

  it('fetches audio bytes from an audioUrl', async () => {
    const f = mockFetch(async () => new Response(new Uint8Array([7, 8, 9]), { status: 200 }))
    const buf = await fetchAudio('/api/audio/abc')
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([7, 8, 9]))
    expect(f.mock.calls[0][0]).toBe('/api/audio/abc')
    mockFetch(async () => json({ detail: 'unknown audio' }, 404))
    await expect(fetchAudio('/api/audio/nope')).rejects.toMatchObject({ status: 404, message: 'unknown audio' })
  })
})

describe('stage 2 api', () => {
  const routine = routineExample as unknown as Routine

  it('GETs and validates the move library', async () => {
    const f = mockFetch(async () => json(DEMO_LIBRARY))
    await expect(getMoves()).resolves.toEqual(DEMO_LIBRARY)
    expect(f.mock.calls[0][0]).toBe('/api/moves')
    const bad = { ...DEMO_LIBRARY, moves: [{ ...DEMO_LIBRARY.moves[0], keyframes: [{ t: 0, pose: { elbow: [0, 0] }, root: [0, 0] }] }] }
    mockFetch(async () => json(bad))
    await expect(getMoves()).rejects.toThrow(/Unexpected response from \/api\/moves/)
    mockFetch(async () => json({ ...DEMO_LIBRARY, moves: [{ ...DEMO_LIBRARY.moves[0], side: 'left' }] }))
    await expect(getMoves()).rejects.toBeInstanceOf(ApiError)
  })

  it('POSTs a choreograph request as JSON', async () => {
    const f = mockFetch(async () => {
      const res = json(routine)
      res.headers.set('X-Routine-Cache', 'hit')
      return res
    })
    const req = { analysisId: 'a'.repeat(64), difficulty: 'hard' as const, mode: 'seated' as const, seed: 7 }
    await expect(choreograph(req)).resolves.toEqual({ routine, cached: true })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('/api/choreograph')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual(req)
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    mockFetch(async () => new Response(JSON.stringify(routine), { status: 200, headers: { 'X-Routine-Cache': 'miss' } }))
    await expect(choreograph(req)).resolves.toMatchObject({ cached: false })
    mockFetch(async () => json(routine))
    await expect(choreograph(req)).resolves.toMatchObject({ cached: null })
    mockFetch(async () => json({ detail: 'analysis not found; analyze the song first' }, 404))
    await expect(choreograph(req)).rejects.toMatchObject({ status: 404, message: 'analysis not found; analyze the song first' })
  })

  it('GETs a routine by id and validates it', async () => {
    const f = mockFetch(async () => json(routine))
    await getRoutine('ab/c')
    expect(f.mock.calls[0][0]).toBe('/api/routines/ab%2Fc')
    expect(isRoutine(routine)).toBe(true)
    expect(isRoutine({ ...routine, version: 2 })).toBe(false)
    expect(isRoutine({ ...routine, mode: 'lying' })).toBe(false)
    expect(isRoutine({ ...routine, moves: [{ ...routine.moves[0], keyframes: [] }] })).toBe(false)
    expect(isRoutine({ ...routine, moves: [{ ...routine.moves[0], scoredJoints: ['tail'] }] })).toBe(false)
    const withRoot = { ...routine, moves: [{ ...routine.moves[0], keyframes: [{ ...routine.moves[0].keyframes[0], root: [0, 0.3] }] }] }
    expect(isRoutine(withRoot)).toBe(true)
    expect(isRoutine({ ...withRoot, moves: [{ ...withRoot.moves[0], keyframes: [{ ...withRoot.moves[0].keyframes[0], root: [0] }] }] })).toBe(false)
  })
})
