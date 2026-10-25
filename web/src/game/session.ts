// Getting from "this song, these settings" to a playable game: analysis -> routine -> audio
// -> motion track, as explicit states the play screen renders. Also from a saved routine id
// (deep link / "Your routines") and from a recipe (rebuild a routine the server forgot). API
// calls are injected (SessionDeps) so the state machine is unit-tested without a server.

import type { Analysis } from '@shared/analysis'
import type { ChoreographRequest } from '@shared/moves'
import type { Difficulty, Mode, Routine } from '@shared/routine'
import { analyzeLibrarySong, analyzeUpload, ApiError, choreograph, getAnalysis, getRoutine } from '../api'
import { errorMessage, isAbortError } from '../lib/errors'
import { buildMotionTrack, type MotionTrack } from '../routine/track'
import type { AudioSource } from './clock'
import { buildGameTimeline, type GameTimeline } from './cues'

export type SongChoice = { kind: 'library'; file: string; title?: string } | { kind: 'upload'; file: File }

export interface SessionRequest {
  song: SongChoice
  difficulty: Difficulty
  mode: Mode
  seed: number
}

/** Everything that rebuilds a routine: same analysis + difficulty + mode + seed = same routine. */
export interface RoutineRecipe {
  analysisId: string
  difficulty: Difficulty
  mode: Mode
  seed: number
  /** Library song file, so a cleared analysis can be recomputed. */
  songFile?: string
}

export type SessionStep = 'findingRoutine' | 'analyzing' | 'choreographing' | 'loadingAudio'

export const STEP_LABELS: Readonly<Record<SessionStep, string>> = {
  findingRoutine: 'Finding your routine…',
  analyzing: 'Listening to the song…',
  choreographing: 'Choreographing your ball…',
  loadingAudio: 'Lacing up the glass slippers…',
}

const STEP_FAILURES: Readonly<Record<SessionStep, string>> = {
  findingRoutine: "Couldn't find that routine",
  analyzing: "Couldn't listen to the song",
  choreographing: "Couldn't choreograph the routine",
  loadingAudio: "Couldn't load the music",
}

export interface PreparedGame {
  analysis: Analysis
  routine: Routine
  track: MotionTrack
  timeline: GameTimeline
  /** Decoded audio duration, seconds. */
  durationSec: number
}

export type SessionState =
  | { status: 'idle' }
  | { status: 'loading'; step: SessionStep; label: string }
  | { status: 'ready'; game: PreparedGame }
  /** `recipe`: the routine is gone from the server but can be generated again. */
  | { status: 'error'; step: SessionStep; message: string; recipe?: RoutineRecipe }

export interface SessionDeps {
  analyzeLibrarySong(file: string, opts: { signal?: AbortSignal }): Promise<Analysis>
  analyzeUpload(file: File, opts: { signal?: AbortSignal }): Promise<Analysis>
  choreograph(req: ChoreographRequest, signal?: AbortSignal): Promise<{ routine: Routine }>
  /** Fetch + decode the audio; resolves its duration (seconds). */
  loadAudio(key: string, src: AudioSource, signal: AbortSignal): Promise<number>
  getRoutine(routineId: string, signal?: AbortSignal): Promise<Routine>
  getAnalysis(analysisId: string, signal?: AbortSignal): Promise<Analysis>
  buildTrack?(routine: Routine): MotionTrack
}

/** Real API + a GameClock for decoding. */
export function apiSessionDeps(clock: { load: SessionDeps['loadAudio'] }): SessionDeps {
  return {
    analyzeLibrarySong,
    analyzeUpload,
    choreograph,
    loadAudio: (key, src, signal) => clock.load(key, src, signal),
    getRoutine,
    getAnalysis,
  }
}

/** User-facing message for a failed step, with the server's detail when there is one. */
export function describeFailure(step: SessionStep, err: unknown): string {
  const what = STEP_FAILURES[step]
  if (err instanceof ApiError) {
    if (err.unreachable) return err.message
    return `${what} (${err.status}): ${err.message}`
  }
  return `${what}: ${errorMessage(err)}`
}

/** Same song? (Uploads compare by File identity.) */
export function sameSong(a: SongChoice, b: SongChoice): boolean {
  return a.kind === b.kind && a.file === b.file
}

/** The routine (or its song's analysis) is no longer on the server. */
class GoneError extends Error {
  readonly recipe: RoutineRecipe | undefined
  constructor(message: string, recipe: RoutineRecipe | undefined) {
    super(message)
    this.name = 'GoneError'
    this.recipe = recipe
  }
}

const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404

/** The recipe recorded in a generated routine's meta (null without an analysisId). */
export function recipeFromRoutine(routine: Routine): RoutineRecipe | null {
  const id = routine.meta?.analysisId
  return typeof id === 'string' && id ? { analysisId: id, difficulty: routine.difficulty, mode: routine.mode, seed: routine.seed } : null
}

type Enter = (step: SessionStep) => void

/**
 * Runs `body`, reporting each step through `onState` (never after `signal` aborts). Resolves
 * the prepared game, or null on failure / abort (the failure was reported as an error state).
 */
async function runSession(
  onState: (s: SessionState) => void,
  signal: AbortSignal,
  body: (enter: Enter) => Promise<PreparedGame>,
): Promise<PreparedGame | null> {
  let step: SessionStep = 'analyzing'
  const emit = (s: SessionState): void => {
    if (!signal.aborted) onState(s)
  }
  const enter: Enter = (next) => {
    step = next
    emit({ status: 'loading', step, label: STEP_LABELS[step] })
  }
  try {
    const game = await body(enter)
    emit({ status: 'ready', game })
    return signal.aborted ? null : game
  } catch (err) {
    if (signal.aborted || isAbortError(err)) return null
    const recipe = err instanceof GoneError ? err.recipe : undefined
    emit({ status: 'error', step, message: describeFailure(step, err), ...(recipe ? { recipe } : {}) })
    return null
  }
}

/** Choreography done: audio -> motion track. */
async function finishGame(
  analysis: Analysis,
  routine: Routine,
  src: AudioSource,
  deps: SessionDeps,
  enter: Enter,
  signal: AbortSignal,
): Promise<PreparedGame> {
  if (routine.moves.length === 0) throw new Error('the choreographer returned no moves for this song')
  enter('loadingAudio')
  const durationSec = await deps.loadAudio(analysis.id, src, signal)
  signal.throwIfAborted()
  return {
    analysis,
    routine,
    track: (deps.buildTrack ?? buildMotionTrack)(routine),
    timeline: buildGameTimeline(routine),
    durationSec,
  }
}

async function choreographFor(analysis: Analysis, r: Omit<RoutineRecipe, 'analysisId'>, deps: SessionDeps, enter: Enter, signal: AbortSignal): Promise<Routine> {
  enter('choreographing')
  const { routine } = await deps.choreograph({ analysisId: analysis.id, difficulty: r.difficulty, mode: r.mode, seed: r.seed }, signal)
  signal.throwIfAborted()
  return routine
}

/**
 * Runs analysis -> choreography -> audio. Pass `reuse.analysis` (same song) to skip the
 * analysis request. Resolves the prepared game, or null on failure / abort.
 */
export function prepareGame(
  req: SessionRequest,
  deps: SessionDeps,
  onState: (s: SessionState) => void,
  signal: AbortSignal,
  reuse: { analysis?: Analysis } = {},
): Promise<PreparedGame | null> {
  return runSession(onState, signal, async (enter) => {
    let analysis = reuse.analysis
    if (!analysis) {
      enter('analyzing')
      analysis =
        req.song.kind === 'library'
          ? await deps.analyzeLibrarySong(req.song.file, { signal })
          : await deps.analyzeUpload(req.song.file, { signal })
      signal.throwIfAborted()
    }
    const routine = await choreographFor(analysis, req, deps, enter, signal)
    const src: AudioSource = req.song.kind === 'upload' ? { file: req.song.file } : { url: analysis.audioUrl }
    return finishGame(analysis, routine, src, deps, enter, signal)
  })
}

/**
 * A saved routine by id: GET /api/routines/{id} -> GET /api/analysis/{meta.analysisId} ->
 * audio (analysis.audioUrl). When either is gone (server cache cleared) the error carries a
 * recipe (from the routine, else `hint`) so it can be generated again.
 */
export function prepareFromRoutine(
  routineId: string,
  deps: SessionDeps,
  onState: (s: SessionState) => void,
  signal: AbortSignal,
  hint?: RoutineRecipe,
): Promise<PreparedGame | null> {
  return runSession(onState, signal, async (enter) => {
    enter('findingRoutine')
    let routine: Routine
    try {
      routine = await deps.getRoutine(routineId, signal)
    } catch (err) {
      if (isNotFound(err)) throw new GoneError("it isn't on the server anymore (its cache was cleared)", hint)
      throw err
    }
    signal.throwIfAborted()
    const own = recipeFromRoutine(routine)
    if (!own) throw new Error('the routine does not say which song analysis it belongs to')
    const recipe: RoutineRecipe = hint?.songFile ? { ...own, songFile: hint.songFile } : own
    let analysis: Analysis
    try {
      analysis = await deps.getAnalysis(own.analysisId, signal)
    } catch (err) {
      if (isNotFound(err)) throw new GoneError("its song analysis isn't on the server anymore", recipe)
      throw err
    }
    signal.throwIfAborted()
    return finishGame(analysis, routine, { url: analysis.audioUrl }, deps, enter, signal)
  })
}

/**
 * Builds a routine from its recipe (same inputs -> the same routine): the cached analysis, or
 * a fresh analysis of the library song when the server forgot it; then choreography + audio.
 * `reuse.analysis` skips the analysis lookup (a new seed for the song on stage).
 */
export function prepareFromRecipe(
  recipe: RoutineRecipe,
  deps: SessionDeps,
  onState: (s: SessionState) => void,
  signal: AbortSignal,
  reuse: { analysis?: Analysis } = {},
): Promise<PreparedGame | null> {
  return runSession(onState, signal, async (enter) => {
    let analysis = reuse.analysis
    if (!analysis) {
      enter('analyzing')
      try {
        analysis = await deps.getAnalysis(recipe.analysisId, signal)
      } catch (err) {
        if (!isNotFound(err)) throw err
        if (!recipe.songFile) {
          throw new Error(
            `the uploaded song's analysis is gone from the server: upload it again in the lobby (${recipe.difficulty} · ${recipe.mode} · seed ${recipe.seed} gives the same routine)`,
          )
        }
        analysis = await deps.analyzeLibrarySong(recipe.songFile, { signal })
      }
      signal.throwIfAborted()
    }
    const routine = await choreographFor(analysis, recipe, deps, enter, signal)
    return finishGame(analysis, routine, { url: analysis.audioUrl }, deps, enter, signal)
  })
}

/**
 * "Learn it first": the routine Start would play (analysis -> choreography; no audio), so the
 * teach page can open it by id. Rejects with a user-facing message (describeFailure) on failure.
 */
export async function routineFor(
  req: SessionRequest,
  deps: Pick<SessionDeps, 'analyzeLibrarySong' | 'analyzeUpload' | 'choreograph'>,
  signal: AbortSignal,
  onStep?: (step: SessionStep) => void,
): Promise<{ analysis: Analysis; routine: Routine }> {
  let step: SessionStep = 'analyzing'
  try {
    onStep?.(step)
    const analysis =
      req.song.kind === 'library'
        ? await deps.analyzeLibrarySong(req.song.file, { signal })
        : await deps.analyzeUpload(req.song.file, { signal })
    signal.throwIfAborted()
    step = 'choreographing'
    onStep?.(step)
    const { routine } = await deps.choreograph({ analysisId: analysis.id, difficulty: req.difficulty, mode: req.mode, seed: req.seed }, signal)
    signal.throwIfAborted()
    if (routine.moves.length === 0) throw new Error('the choreographer returned no moves for this song')
    return { analysis, routine }
  } catch (err) {
    if (signal.aborted || isAbortError(err)) throw err
    throw new Error(describeFailure(step, err), { cause: err })
  }
}
