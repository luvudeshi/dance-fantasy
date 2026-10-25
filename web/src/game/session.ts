// Getting from "this song, these settings" to a playable game: analysis -> routine -> audio
// -> motion track, as explicit states the play screen renders. API calls are injected
// (SessionDeps) so the state machine is unit-tested without a server.

import type { Analysis } from '@shared/analysis'
import type { ChoreographRequest } from '@shared/moves'
import type { Difficulty, Mode, Routine } from '@shared/routine'
import { analyzeLibrarySong, analyzeUpload, ApiError, choreograph } from '../api'
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

export type SessionStep = 'analyzing' | 'choreographing' | 'loadingAudio'

export const STEP_LABELS: Readonly<Record<SessionStep, string>> = {
  analyzing: 'Listening to the song…',
  choreographing: 'Choreographing your ball…',
  loadingAudio: 'Lacing up the glass slippers…',
}

const STEP_FAILURES: Readonly<Record<SessionStep, string>> = {
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
  | { status: 'error'; step: SessionStep; message: string }

export interface SessionDeps {
  analyzeLibrarySong(file: string, opts: { signal?: AbortSignal }): Promise<Analysis>
  analyzeUpload(file: File, opts: { signal?: AbortSignal }): Promise<Analysis>
  choreograph(req: ChoreographRequest, signal?: AbortSignal): Promise<{ routine: Routine }>
  /** Fetch + decode the audio; resolves its duration (seconds). */
  loadAudio(key: string, src: AudioSource, signal: AbortSignal): Promise<number>
  buildTrack?(routine: Routine): MotionTrack
}

/** Real API + a GameClock for decoding. */
export function apiSessionDeps(clock: { load: SessionDeps['loadAudio'] }): SessionDeps {
  return {
    analyzeLibrarySong,
    analyzeUpload,
    choreograph,
    loadAudio: (key, src, signal) => clock.load(key, src, signal),
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

/**
 * Runs analysis -> choreography -> audio, reporting each state through `onState` (never after
 * `signal` aborts). Pass `reuse.analysis` (same song) to skip the analysis request. Resolves
 * the prepared game, or null on failure / abort (the failure was reported as an error state).
 */
export async function prepareGame(
  req: SessionRequest,
  deps: SessionDeps,
  onState: (s: SessionState) => void,
  signal: AbortSignal,
  reuse: { analysis?: Analysis } = {},
): Promise<PreparedGame | null> {
  let step: SessionStep = 'analyzing'
  const emit = (s: SessionState): void => {
    if (!signal.aborted) onState(s)
  }
  const enter = (next: SessionStep): void => {
    step = next
    emit({ status: 'loading', step, label: STEP_LABELS[step] })
  }
  try {
    let analysis = reuse.analysis
    if (!analysis) {
      enter('analyzing')
      analysis =
        req.song.kind === 'library'
          ? await deps.analyzeLibrarySong(req.song.file, { signal })
          : await deps.analyzeUpload(req.song.file, { signal })
      signal.throwIfAborted()
    }

    enter('choreographing')
    const { routine } = await deps.choreograph(
      { analysisId: analysis.id, difficulty: req.difficulty, mode: req.mode, seed: req.seed },
      signal,
    )
    signal.throwIfAborted()
    if (routine.moves.length === 0) throw new Error('the choreographer returned no moves for this song')

    enter('loadingAudio')
    const src: AudioSource = req.song.kind === 'upload' ? { file: req.song.file } : { url: analysis.audioUrl }
    const durationSec = await deps.loadAudio(analysis.id, src, signal)
    signal.throwIfAborted()

    const game: PreparedGame = {
      analysis,
      routine,
      track: (deps.buildTrack ?? buildMotionTrack)(routine),
      timeline: buildGameTimeline(routine),
      durationSec,
    }
    emit({ status: 'ready', game })
    return signal.aborted ? null : game
  } catch (err) {
    if (signal.aborted || isAbortError(err)) return null
    emit({ status: 'error', step, message: describeFailure(step, err) })
    return null
  }
}
