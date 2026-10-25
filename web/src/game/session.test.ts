import { describe, expect, it, vi } from 'vitest'
import type { Analysis } from '@shared/analysis'
import type { Routine } from '@shared/routine'
import routineExample from '@shared/examples/routine.example.json'
import { ApiError, SERVER_UNREACHABLE_MESSAGE } from '../api'
import { describeFailure, prepareGame, STEP_LABELS, type SessionDeps, type SessionRequest, type SessionState } from './session'

const ROUTINE = routineExample as unknown as Routine

const ANALYSIS: Analysis = {
  id: 'a'.repeat(64),
  analysisVersion: 1,
  title: 'Synth Ball 120',
  source: { kind: 'library', file: 'synth_120bpm.wav' },
  audioUrl: '/api/songs/synth_120bpm.wav',
  durationSec: 8,
  sampleRate: 22050,
  bpm: 120,
  beatsPerBar: 4,
  beats: ROUTINE.song.beats,
  filledBeats: [],
  downbeats: ROUTINE.song.downbeats,
  downbeatPhase: 0,
  onsetEnvelope: { hopSec: 0.05, values: [0] },
  beatEnergy: ROUTINE.song.beats.map(() => 0.5),
  sections: [{ start: 0, end: 8, label: 'verse', energy: 0.4, group: 'A', startBeat: 0, endBeat: 16, bars: 4 }],
  elapsedMs: 10,
  cached: true,
}

const REQ: SessionRequest = { song: { kind: 'library', file: 'synth_120bpm.wav' }, difficulty: 'hard', mode: 'seated', seed: 7 }

function mockDeps(over: Partial<SessionDeps> = {}) {
  return {
    analyzeLibrarySong: vi.fn<SessionDeps['analyzeLibrarySong']>(async () => ANALYSIS),
    analyzeUpload: vi.fn<SessionDeps['analyzeUpload']>(async () => ({ ...ANALYSIS, source: { kind: 'upload' as const } })),
    choreograph: vi.fn<SessionDeps['choreograph']>(async () => ({ routine: ROUTINE })),
    loadAudio: vi.fn<SessionDeps['loadAudio']>(async () => 8.01),
    ...over,
  }
}

async function run(req: SessionRequest, deps: SessionDeps, signal = new AbortController().signal, reuse = {}) {
  const states: SessionState[] = []
  const game = await prepareGame(req, deps, (s) => states.push(s), signal, reuse)
  return { game, states }
}

const statuses = (states: SessionState[]): string[] => states.map((s) => (s.status === 'loading' ? s.step : s.status))

describe('prepareGame', () => {
  it('library song: analysis -> routine -> audio -> ready, with playful labels', async () => {
    const deps = mockDeps()
    const { game, states } = await run(REQ, deps)
    expect(statuses(states)).toEqual(['analyzing', 'choreographing', 'loadingAudio', 'ready'])
    expect(states[0]).toEqual({ status: 'loading', step: 'analyzing', label: 'Listening to the song…' })
    expect(states[1]).toMatchObject({ label: 'Choreographing your ball…' })
    expect(states[2]).toMatchObject({ label: 'Lacing up the glass slippers…' })
    expect(deps.analyzeLibrarySong).toHaveBeenCalledWith('synth_120bpm.wav', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(deps.choreograph).toHaveBeenCalledWith(
      { analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7 },
      expect.any(AbortSignal),
    )
    expect(deps.loadAudio).toHaveBeenCalledWith(ANALYSIS.id, { url: ANALYSIS.audioUrl }, expect.any(AbortSignal))
    expect(game).not.toBeNull()
    expect(game?.durationSec).toBe(8.01)
    expect(game?.routine).toBe(ROUTINE)
    expect(game?.timeline.countdown.times).toHaveLength(4)
    expect(game?.track.sample(ROUTINE.moves[0].startTime).moveIndex).toBe(0)
    expect(states[3]).toEqual({ status: 'ready', game })
  })

  it('upload: POST /api/analyze and play the local file', async () => {
    const deps = mockDeps()
    const file = new File([new Uint8Array([1, 2, 3])], 'my song.mp3', { type: 'audio/mpeg' })
    const { game } = await run({ ...REQ, song: { kind: 'upload', file } }, deps)
    expect(game).not.toBeNull()
    expect(deps.analyzeUpload).toHaveBeenCalledWith(file, expect.anything())
    expect(deps.analyzeLibrarySong).not.toHaveBeenCalled()
    expect(deps.loadAudio).toHaveBeenCalledWith(ANALYSIS.id, { file }, expect.any(AbortSignal))
  })

  it('reuses a known analysis (new routine for the same song)', async () => {
    const deps = mockDeps()
    const { states } = await run(REQ, deps, undefined, { analysis: ANALYSIS })
    expect(statuses(states)).toEqual(['choreographing', 'loadingAudio', 'ready'])
    expect(deps.analyzeLibrarySong).not.toHaveBeenCalled()
  })

  it("surfaces the server's detail for the failing step", async () => {
    const deps = mockDeps({ analyzeLibrarySong: vi.fn(async () => Promise.reject(new ApiError('Song not found: x.wav', 404, false))) })
    const { game, states } = await run(REQ, deps)
    expect(game).toBeNull()
    expect(states.at(-1)).toEqual({ status: 'error', step: 'analyzing', message: "Couldn't listen to the song (404): Song not found: x.wav" })
    expect(deps.choreograph).not.toHaveBeenCalled()

    const choreo = mockDeps({ choreograph: vi.fn(async () => Promise.reject(new ApiError('analysis not cached', 404, false))) })
    const r2 = await run(REQ, choreo)
    expect(r2.states.at(-1)).toMatchObject({ status: 'error', step: 'choreographing', message: expect.stringContaining('analysis not cached') })
  })

  it('reports decode failures and empty routines', async () => {
    const bad = mockDeps({ loadAudio: vi.fn(async () => Promise.reject(new Error('The browser could not decode this audio (EncodingError)'))) })
    const r1 = await run(REQ, bad)
    expect(r1.states.at(-1)).toEqual({
      status: 'error',
      step: 'loadingAudio',
      message: "Couldn't load the music: The browser could not decode this audio (EncodingError)",
    })
    const empty = mockDeps({ choreograph: vi.fn(async () => ({ routine: { ...ROUTINE, moves: [] } })) })
    const r2 = await run(REQ, empty)
    expect(r2.states.at(-1)).toMatchObject({ status: 'error', step: 'choreographing', message: expect.stringContaining('no moves') })
    expect(empty.loadAudio).not.toHaveBeenCalled()
  })

  it('stops quietly when aborted mid-way (no states after the abort, no error)', async () => {
    const ac = new AbortController()
    const deps = mockDeps({
      choreograph: vi.fn(async (_req, signal?: AbortSignal) => {
        ac.abort()
        signal?.throwIfAborted()
        return { routine: ROUTINE }
      }),
    })
    const { game, states } = await run(REQ, deps, ac.signal)
    expect(game).toBeNull()
    expect(statuses(states)).toEqual(['analyzing', 'choreographing'])
    expect(deps.loadAudio).not.toHaveBeenCalled()
  })

  it('describeFailure: unreachable server keeps its own message', () => {
    expect(describeFailure('analyzing', new ApiError(SERVER_UNREACHABLE_MESSAGE, 0, true))).toBe(SERVER_UNREACHABLE_MESSAGE)
    expect(describeFailure('loadingAudio', 'boom')).toBe("Couldn't load the music: boom")
    expect(STEP_LABELS.analyzing).toBe('Listening to the song…')
  })
})
