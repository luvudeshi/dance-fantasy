import { describe, expect, it, vi } from 'vitest'
import type { Analysis } from '@shared/analysis'
import type { Routine } from '@shared/routine'
import routineExample from '@shared/examples/routine.example.json'
import { ApiError, SERVER_UNREACHABLE_MESSAGE } from '../api'
import {
  describeFailure,
  lobbyRequest,
  prepareFromRecipe,
  prepareFromRoutine,
  prepareGame,
  recipeFromRoutine,
  routineFor,
  STEP_LABELS,
  type RoutineRecipe,
  type SessionDeps,
  type SessionRequest,
  type SessionState,
} from './session'

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

const ROUTINE_ID = '0123456789abcdef'
const SAVED: Routine = { ...ROUTINE, difficulty: 'hard', mode: 'seated', seed: 7, meta: { routineId: ROUTINE_ID, analysisId: ANALYSIS.id } }
const RECIPE: RoutineRecipe = { analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, songFile: 'synth_120bpm.wav' }
const gone = (what: string) => vi.fn(async () => Promise.reject(new ApiError(`${what} not found`, 404, false)))

const REQ: SessionRequest = { song: { kind: 'library', file: 'synth_120bpm.wav' }, difficulty: 'hard', mode: 'seated', seed: 7 }

function mockDeps(over: Partial<SessionDeps> = {}) {
  return {
    analyzeLibrarySong: vi.fn<SessionDeps['analyzeLibrarySong']>(async () => ANALYSIS),
    analyzeUpload: vi.fn<SessionDeps['analyzeUpload']>(async () => ({ ...ANALYSIS, source: { kind: 'upload' as const } })),
    choreograph: vi.fn<SessionDeps['choreograph']>(async () => ({ routine: ROUTINE })),
    loadAudio: vi.fn<SessionDeps['loadAudio']>(async () => 8.01),
    getRoutine: vi.fn<SessionDeps['getRoutine']>(async () => SAVED),
    getAnalysis: vi.fn<SessionDeps['getAnalysis']>(async () => ANALYSIS),
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
      { analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, moveSource: 'classic' },
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

  it('sends the lobby\'s "Moves from" choice', async () => {
    const deps = mockDeps()
    await run({ ...REQ, moveSource: 'aist' }, deps)
    expect(deps.choreograph).toHaveBeenCalledWith(
      { analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, moveSource: 'aist' },
      expect.any(AbortSignal),
    )
  })

  it('sends the signature pins together with the move source', async () => {
    const deps = mockDeps()
    const pinnedMoves = [{ moveId: 'sig_ymca_arms', placement: 'chorus' as const }]
    await run({ ...REQ, moveSource: 'aist', pinnedMoves }, deps)
    expect(deps.choreograph).toHaveBeenCalledWith(
      { analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, moveSource: 'aist', pinnedMoves },
      expect.any(AbortSignal),
    )
    await run({ ...REQ, moveSource: 'mix', pinnedMoves: [] }, deps)
    expect(deps.choreograph).toHaveBeenLastCalledWith(
      { analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, moveSource: 'mix' },
      expect.any(AbortSignal),
    )
  })

  it('lobbyRequest: "Moves from" always, signature pins only when on and found', async () => {
    const song = { kind: 'library' as const, file: 'synth_120bpm.wav' }
    const setup = { difficulty: 'hard' as const, mode: 'seated' as const, seed: 7, moveSource: 'aist' as const }
    const pins = [{ moveId: 'sig_ymca_arms', placement: 'chorus' as const }]
    expect(lobbyRequest(song, setup, pins)).toEqual({ song, ...setup, pinnedMoves: pins })
    expect(lobbyRequest(song, setup, [])).toEqual({ song, ...setup })
    expect(lobbyRequest(song, setup, null)).toEqual({ song, ...setup })
    const deps = mockDeps()
    await run(lobbyRequest(song, { ...setup, moveSource: 'mix' }, pins), deps)
    expect(deps.choreograph).toHaveBeenCalledWith(
      { analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, moveSource: 'mix', pinnedMoves: pins },
      expect.any(AbortSignal),
    )
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

describe('prepareFromRoutine (deep link / Your routines)', () => {
  const load = async (deps: SessionDeps, hint?: RoutineRecipe) => {
    const states: SessionState[] = []
    const game = await prepareFromRoutine(ROUTINE_ID, deps, (s) => states.push(s), new AbortController().signal, hint)
    return { game, states }
  }

  it('routine -> its analysis -> audio from analysis.audioUrl', async () => {
    const deps = mockDeps()
    const { game, states } = await load(deps)
    expect(statuses(states)).toEqual(['findingRoutine', 'loadingAudio', 'ready'])
    expect(states[0]).toMatchObject({ label: 'Finding your routine…' })
    expect(deps.getRoutine).toHaveBeenCalledWith(ROUTINE_ID, expect.any(AbortSignal))
    expect(deps.getAnalysis).toHaveBeenCalledWith(ANALYSIS.id, expect.any(AbortSignal))
    expect(deps.loadAudio).toHaveBeenCalledWith(ANALYSIS.id, { url: ANALYSIS.audioUrl }, expect.any(AbortSignal))
    expect(deps.choreograph).not.toHaveBeenCalled()
    expect(deps.analyzeLibrarySong).not.toHaveBeenCalled()
    expect(game?.routine).toBe(SAVED)
    expect(game?.analysis).toBe(ANALYSIS)
    expect(game?.timeline.countdown.times.length).toBeGreaterThan(0)
  })

  it('routine gone: a friendly error that offers the recipe (from the shelf hint)', async () => {
    const { game, states } = await load(mockDeps({ getRoutine: gone('routine') }), RECIPE)
    expect(game).toBeNull()
    expect(states.at(-1)).toEqual({
      status: 'error',
      step: 'findingRoutine',
      message: "Couldn't find that routine: it isn't on the server anymore (its cache was cleared)",
      recipe: RECIPE,
    })
    // No hint (a pasted link): nothing to rebuild from.
    const r2 = await load(mockDeps({ getRoutine: gone('routine') }))
    expect(r2.states.at(-1)).toMatchObject({ status: 'error' })
    expect(r2.states.at(-1)).not.toHaveProperty('recipe')
  })

  it("analysis gone: the recipe comes from the routine's meta", async () => {
    const { states } = await load(mockDeps({ getAnalysis: gone('analysis') }), { ...RECIPE, seed: 999 })
    expect(states.at(-1)).toMatchObject({
      status: 'error',
      message: expect.stringContaining('analysis'),
      recipe: { ...RECIPE, seed: 7 },
    })
  })

  it('other failures are plain errors', async () => {
    const { states } = await load(mockDeps({ getRoutine: vi.fn(async () => Promise.reject(new ApiError('boom', 500, false))) }), RECIPE)
    expect(states.at(-1)).toEqual({ status: 'error', step: 'findingRoutine', message: "Couldn't find that routine (500): boom" })
    const noMeta = await load(mockDeps({ getRoutine: vi.fn(async () => ({ ...SAVED, meta: {} })) }))
    expect(noMeta.states.at(-1)).toMatchObject({ status: 'error', message: expect.stringContaining('analysis') })
  })

  it('recipeFromRoutine', () => {
    expect(recipeFromRoutine(SAVED)).toEqual({ analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7 })
    expect(recipeFromRoutine(ROUTINE)).toBeNull()
    const mixed = { ...SAVED, meta: { ...SAVED.meta, moveSource: 'mix' } }
    expect(recipeFromRoutine(mixed)).toEqual({ analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, moveSource: 'mix' })
    expect(recipeFromRoutine({ ...SAVED, meta: { ...SAVED.meta, moveSource: 'disco' } })).not.toHaveProperty('moveSource')
    const pinnedMoves = [{ moveId: 'sig_whip', placement: 'chorus' }]
    expect(recipeFromRoutine({ ...SAVED, meta: { ...SAVED.meta, moveSource: 'aist', pinnedMoves } })).toEqual({
      analysisId: ANALYSIS.id,
      difficulty: 'hard',
      mode: 'seated',
      seed: 7,
      moveSource: 'aist',
      pinnedMoves,
    })
  })
})

describe('prepareFromRecipe (generate it again / new seed)', () => {
  const build = async (deps: SessionDeps, recipe: RoutineRecipe, reuse = {}) => {
    const states: SessionState[] = []
    const game = await prepareFromRecipe(recipe, deps, (s) => states.push(s), new AbortController().signal, reuse)
    return { game, states }
  }

  it('cached analysis -> same request as the original -> audio', async () => {
    const deps = mockDeps()
    const { game, states } = await build(deps, RECIPE)
    expect(statuses(states)).toEqual(['analyzing', 'choreographing', 'loadingAudio', 'ready'])
    // Recipes from before move sources are classic, explicitly (whatever the server's default).
    expect(deps.choreograph).toHaveBeenCalledWith(
      { analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, moveSource: 'classic' },
      expect.any(AbortSignal),
    )
    expect(deps.loadAudio).toHaveBeenCalledWith(ANALYSIS.id, { url: ANALYSIS.audioUrl }, expect.any(AbortSignal))
    expect(game).not.toBeNull()
  })

  it('re-analyzes a library song the server forgot', async () => {
    const deps = mockDeps({ getAnalysis: gone('analysis') })
    const { game } = await build(deps, RECIPE)
    expect(deps.analyzeLibrarySong).toHaveBeenCalledWith('synth_120bpm.wav', expect.anything())
    expect(game).not.toBeNull()
  })

  it('an upload the server forgot cannot be rebuilt here', async () => {
    const deps = mockDeps({ getAnalysis: gone('analysis') })
    const { game, states } = await build(deps, { ...RECIPE, songFile: undefined })
    expect(game).toBeNull()
    expect(states.at(-1)).toMatchObject({ status: 'error', step: 'analyzing', message: expect.stringContaining('upload it again') })
    expect(deps.choreograph).not.toHaveBeenCalled()
  })

  it('keeps the move source (real dancers) when rebuilding', async () => {
    const deps = mockDeps()
    await build(deps, { ...RECIPE, moveSource: 'aist' })
    expect(deps.choreograph).toHaveBeenCalledWith(
      { analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, moveSource: 'aist' },
      expect.any(AbortSignal),
    )
  })

  it('keeps the move source and the signature pins when rebuilding', async () => {
    const deps = mockDeps()
    const pinnedMoves = [{ moveId: 'sig_whip', placement: 'chorus' as const }]
    await build(deps, { ...RECIPE, moveSource: 'mix', pinnedMoves })
    expect(deps.choreograph).toHaveBeenCalledWith(
      { analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, moveSource: 'mix', pinnedMoves },
      expect.any(AbortSignal),
    )
  })

  it('reuses the analysis on stage (new seed)', async () => {
    const deps = mockDeps()
    const { states } = await build(deps, { ...RECIPE, seed: 8 }, { analysis: ANALYSIS })
    expect(statuses(states)).toEqual(['choreographing', 'loadingAudio', 'ready'])
    expect(deps.getAnalysis).not.toHaveBeenCalled()
    expect(deps.choreograph).toHaveBeenCalledWith(expect.objectContaining({ seed: 8 }), expect.any(AbortSignal))
  })
})

describe('routineFor ("Learn it first")', () => {
  it('analyzes and choreographs the lobby settings without loading audio', async () => {
    const deps = mockDeps({ choreograph: vi.fn<SessionDeps['choreograph']>(async () => ({ routine: SAVED })) })
    const steps: string[] = []
    const out = await routineFor(REQ, deps, new AbortController().signal, (s) => steps.push(s))
    expect(out.routine.meta?.routineId).toBe(ROUTINE_ID)
    expect(deps.choreograph).toHaveBeenCalledWith({ analysisId: ANALYSIS.id, difficulty: 'hard', mode: 'seated', seed: 7, moveSource: 'classic' }, expect.anything())
    expect(deps.loadAudio).not.toHaveBeenCalled()
    expect(steps).toEqual(['analyzing', 'choreographing'])
    await routineFor({ ...REQ, moveSource: 'mix' }, deps, new AbortController().signal)
    expect(deps.choreograph).toHaveBeenLastCalledWith(expect.objectContaining({ moveSource: 'mix' }), expect.anything())
    const pinnedMoves = [{ moveId: 'sig_ymca_arms', placement: 'chorus' as const }]
    await routineFor({ ...REQ, moveSource: 'aist', pinnedMoves }, deps, new AbortController().signal)
    expect(deps.choreograph).toHaveBeenLastCalledWith(expect.objectContaining({ moveSource: 'aist', pinnedMoves }), expect.anything())
  })

  it('rejects with the failing step in the message', async () => {
    const deps = mockDeps({ choreograph: vi.fn(async () => Promise.reject(new ApiError('boom', 500, false))) })
    await expect(routineFor(REQ, deps, new AbortController().signal)).rejects.toThrow(/choreograph/i)
  })
})
