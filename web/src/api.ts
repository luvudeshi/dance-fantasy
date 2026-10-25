// Typed client for the FastAPI server (HTTP API in shared/README.md). In dev, Vite
// proxies /api to 127.0.0.1:8000, so VITE_API_BASE is normally unset ('' = same origin).

import { ANALYSIS_SECTION_LABELS, type Analysis, type AnalysisSection, type SectionLabel } from '@shared/analysis'
import type { ChoreographRequest, LibraryMove, MoveKeyframe, MoveLibraryResponse } from '@shared/moves'
import type { Keyframe, Move, Routine } from '@shared/routine'
import { JOINTS, type JointName, type Pose2D, type Vec2 } from '@shared/skeleton'
import { isAbortError } from './lib/errors'

export type { Analysis, AnalysisSection, SectionLabel }
export type { ChoreographRequest, LibraryMove, MoveLibraryResponse, Routine }

export interface Health {
  status: string
  version: string
}

export interface SongInfo {
  file: string
  title: string
  sizeBytes: number
}

export interface BeatResult {
  song: string
  durationSec: number
  sampleRate: number
  /** librosa's global tempo estimate (BPM). */
  tempo: number
  /** 60 / median inter-beat interval (more precise). */
  bpmFromBeats: number
  /** Beat times in seconds, ascending. */
  beats: number[]
  elapsedMs: number
}

export const SERVER_UNREACHABLE_MESSAGE = 'Server not reachable — start it with `make server`'

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number
  /** True when the server (or the dev proxy's upstream) could not be reached. */
  readonly unreachable: boolean

  constructor(message: string, status: number, unreachable: boolean, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ApiError'
    this.status = status
    this.unreachable = unreachable
  }
}

const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

export function songAudioUrl(file: string): string {
  return apiUrl(`/api/songs/${encodeURIComponent(file)}`)
}

// --- response validation (unknown + narrowing, no `any`) ---------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNumArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum)
const isSectionLabel = (v: unknown): v is SectionLabel => ANALYSIS_SECTION_LABELS.some((l) => l === v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)
const JOINT_SET: ReadonlySet<string> = new Set(JOINTS)
const isJoint = (v: unknown): v is JointName => isStr(v) && JOINT_SET.has(v)
const isDifficulty = (v: unknown): v is Routine['difficulty'] => v === 'easy' || v === 'normal' || v === 'hard'
const isVec2 = (v: unknown): v is Vec2 => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1])
const isPose = (v: unknown): v is Pose2D => isRecord(v) && Object.entries(v).every(([k, p]) => JOINT_SET.has(k) && isVec2(p))

function isHealth(v: unknown): v is Health {
  return isRecord(v) && isStr(v.status) && isStr(v.version)
}

function isSongInfo(v: unknown): v is SongInfo {
  return isRecord(v) && isStr(v.file) && isStr(v.title) && isNum(v.sizeBytes)
}

function isBeatResult(v: unknown): v is BeatResult {
  return (
    isRecord(v) &&
    isStr(v.song) &&
    isNum(v.durationSec) &&
    isNum(v.sampleRate) &&
    isNum(v.tempo) &&
    isNum(v.bpmFromBeats) &&
    isNum(v.elapsedMs) &&
    Array.isArray(v.beats) &&
    v.beats.every(isNum)
  )
}

function isAnalysisSection(v: unknown): v is AnalysisSection {
  return (
    isRecord(v) &&
    isNum(v.start) &&
    isNum(v.end) &&
    isSectionLabel(v.label) &&
    isNum(v.energy) &&
    isStr(v.group) &&
    isNum(v.startBeat) &&
    isNum(v.endBeat) &&
    isNum(v.bars)
  )
}

/** Structural check of an Analysis (shared/analysis.schema.json); semantics are the server's job. */
export function isAnalysis(v: unknown): v is Analysis {
  if (!isRecord(v)) return false
  const { source, onsetEnvelope: env } = v
  return (
    isStr(v.id) &&
    isNum(v.analysisVersion) &&
    isStr(v.title) &&
    (v.artist === undefined || isStr(v.artist)) &&
    isRecord(source) &&
    (source.kind === 'library' || source.kind === 'upload') &&
    (source.file === undefined || isStr(source.file)) &&
    isStr(v.audioUrl) &&
    isNum(v.durationSec) &&
    isNum(v.sampleRate) &&
    isNum(v.bpm) &&
    v.beatsPerBar === 4 &&
    isNumArray(v.beats) &&
    isNumArray(v.filledBeats) &&
    isNumArray(v.downbeats) &&
    isNum(v.downbeatPhase) &&
    isRecord(env) &&
    isNum(env.hopSec) &&
    isNumArray(env.values) &&
    isNumArray(v.beatEnergy) &&
    Array.isArray(v.sections) &&
    v.sections.every(isAnalysisSection) &&
    isNum(v.elapsedMs) &&
    typeof v.cached === 'boolean'
  )
}

// --- Stage 2: moves + routines (shared/moves.ts, shared/routine.ts) ---

function isMoveKeyframe(v: unknown): v is MoveKeyframe {
  return isRecord(v) && isNum(v.t) && isPose(v.pose) && isVec2(v.root)
}

export function isLibraryMove(v: unknown): v is LibraryMove {
  return (
    isRecord(v) &&
    isStr(v.id) &&
    isStr(v.baseId) &&
    isStr(v.name) &&
    isNum(v.lengthBeats) &&
    isNum(v.intensity) &&
    isDifficulty(v.difficulty) &&
    isStrArray(v.bodyParts) &&
    isBool(v.upperBodyOnly) &&
    isStrArray(v.styles) &&
    Array.isArray(v.scoredJoints) &&
    v.scoredJoints.every(isJoint) &&
    Array.isArray(v.keyframes) &&
    v.keyframes.length > 0 &&
    v.keyframes.every(isMoveKeyframe) &&
    isStr(v.startAnchor) &&
    isStr(v.endAnchor) &&
    (v.side === 'L' || v.side === 'R' || v.side === 'both') &&
    (v.mirrorOf === null || isStr(v.mirrorOf))
  )
}

export function isMoveLibrary(v: unknown): v is MoveLibraryResponse {
  return isRecord(v) && isStr(v.version) && Array.isArray(v.moves) && v.moves.every(isLibraryMove)
}

function isRoutineKeyframe(v: unknown): v is Keyframe {
  return isRecord(v) && isNum(v.t) && isPose(v.pose) && (v.root === undefined || isVec2(v.root))
}

function isRoutineMove(v: unknown): v is Move {
  return (
    isRecord(v) &&
    isStr(v.id) &&
    isStr(v.name) &&
    isNum(v.startBeat) &&
    isNum(v.lengthBeats) &&
    isNum(v.startTime) &&
    isNum(v.endTime) &&
    isNum(v.intensity) &&
    Array.isArray(v.scoredJoints) &&
    v.scoredJoints.every(isJoint) &&
    Array.isArray(v.keyframes) &&
    v.keyframes.length > 0 &&
    v.keyframes.every(isRoutineKeyframe)
  )
}

/** Structural check of a routine.json (shared/routine.schema.json). */
export function isRoutine(v: unknown): v is Routine {
  if (!isRecord(v)) return false
  const { song } = v
  return (
    v.version === 1 &&
    isRecord(song) &&
    isStr(song.title) &&
    isNum(song.durationSec) &&
    isNum(song.bpm) &&
    isNumArray(song.beats) &&
    isNumArray(song.downbeats) &&
    Array.isArray(song.sections) &&
    song.sections.every((s) => isRecord(s) && isNum(s.start) && isNum(s.end) && isStr(s.label) && isNum(s.energy)) &&
    isDifficulty(v.difficulty) &&
    (v.mode === 'standing' || v.mode === 'seated') &&
    isNum(v.seed) &&
    Array.isArray(v.moves) &&
    v.moves.every(isRoutineMove) &&
    (v.meta === undefined || isRecord(v.meta))
  )
}

/** FastAPI errors: { detail: string } or, for validation errors, { detail: [{ msg }] }. */
function detailFrom(body: unknown): string | null {
  if (!isRecord(body)) return null
  const { detail } = body
  if (isStr(detail)) return detail
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (isRecord(d) && isStr(d.msg) ? d.msg : JSON.stringify(d)))
    return msgs.join('; ')
  }
  return null
}

type RequestOptions = Pick<RequestInit, 'method' | 'body' | 'signal'>

/** fetch() that turns network failures into an "unreachable" ApiError (aborts pass through). */
async function send(path: string, init: RequestOptions, accept: string, contentType?: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept }
  if (contentType) headers['Content-Type'] = contentType
  try {
    return await fetch(apiUrl(path), { ...init, headers })
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new ApiError(SERVER_UNREACHABLE_MESSAGE, 0, true, { cause: err })
  }
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** Error for a non-2xx response: FastAPI's detail when present. */
function errorFor(res: Response, text: string): ApiError {
  const detail = detailFrom(parseJson(text))
  if (detail) return new ApiError(detail, res.status, false)
  // Vite's dev proxy answers 502 with an empty body when nothing listens on :8000.
  const unreachable = res.status === 502 || res.status === 503 || res.status === 504 || (res.status === 500 && !text)
  return new ApiError(
    unreachable ? SERVER_UNREACHABLE_MESSAGE : `HTTP ${res.status} ${res.statusText}`.trim(),
    res.status,
    unreachable,
  )
}

async function requestWithResponse<T>(
  path: string,
  guard: (v: unknown) => v is T,
  init: RequestOptions = {},
  contentType?: string,
): Promise<{ body: T; res: Response }> {
  const res = await send(path, init, 'application/json', contentType)
  const text = await res.text()
  if (!res.ok) throw errorFor(res, text)
  const body = parseJson(text)
  if (!guard(body)) {
    throw new ApiError(`Unexpected response from ${path} (does the server match shared/README.md?)`, res.status, false)
  }
  return { body, res }
}

async function request<T>(path: string, guard: (v: unknown) => v is T, init: RequestOptions = {}): Promise<T> {
  return (await requestWithResponse(path, guard, init)).body
}

export function getHealth(signal?: AbortSignal): Promise<Health> {
  return request('/api/health', isHealth, { signal })
}

export function listSongs(signal?: AbortSignal): Promise<SongInfo[]> {
  return request('/api/songs', (v): v is SongInfo[] => Array.isArray(v) && v.every(isSongInfo), { signal })
}

export function beatsForSong(file: string, signal?: AbortSignal): Promise<BeatResult> {
  return request(`/api/spike/beats?song=${encodeURIComponent(file)}`, isBeatResult, { signal })
}

export function beatsForUpload(file: File | Blob, signal?: AbortSignal): Promise<BeatResult> {
  const form = new FormData()
  form.append('file', file, file instanceof File ? file.name : 'upload')
  return request('/api/spike/beats', isBeatResult, { method: 'POST', body: form, signal })
}

/** Raw bytes of a song in assets/songs/ (for AudioContext.decodeAudioData). */
export function fetchSongAudio(file: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  return fetchAudio(`/api/songs/${encodeURIComponent(file)}`, signal)
}

// --- Stage 1: song analysis ---------------------------------------------------------

export interface AnalyzeOptions {
  /** Bypass the server's analysis cache (?refresh=1). */
  refresh?: boolean
  signal?: AbortSignal
}

const refreshQuery = (refresh: boolean | undefined): string => (refresh ? '?refresh=1' : '')

/** GET /api/songs/{file}/analysis — analysis of a song in assets/songs/ (cached server-side). */
export function analyzeLibrarySong(file: string, opts: AnalyzeOptions = {}): Promise<Analysis> {
  return request(`/api/songs/${encodeURIComponent(file)}/analysis${refreshQuery(opts.refresh)}`, isAnalysis, {
    signal: opts.signal,
  })
}

/** Set at build time on deployments: Vercel caps request bodies at 4.5 MB, so songs go browser → Vercel Blob. */
const BLOB_UPLOADS = import.meta.env.VITE_BLOB_UPLOADS === '1'

/** POST /api/analyze (multipart `file`, optional `title`) — analyzes an uploaded song. */
export function analyzeUpload(file: File, opts: AnalyzeOptions & { title?: string } = {}): Promise<Analysis> {
  if (BLOB_UPLOADS) return analyzeViaBlob(file, opts)
  const form = new FormData()
  form.append('file', file, file.name)
  if (opts.title) form.append('title', opts.title)
  return request(`/api/analyze${refreshQuery(opts.refresh)}`, isAnalysis, { method: 'POST', body: form, signal: opts.signal })
}

/** Upload to Vercel Blob (token from POST /api/blob/upload), then POST /api/analyze/blob with its URL. */
async function analyzeViaBlob(file: File, opts: AnalyzeOptions & { title?: string }): Promise<Analysis> {
  const { upload } = await import('@vercel/blob/client')
  const rawExt = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : ''
  const ext = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : '' // the server only signs plain names
  let url: string
  try {
    // The real name travels in the analyze request; the Blob path only needs the extension.
    const blob = await upload(`uploads/song${ext ? `.${ext}` : ''}`, file, {
      access: 'public',
      handleUploadUrl: apiUrl('/api/blob/upload'),
      contentType: file.type.startsWith('audio/') ? file.type : `audio/${ext || 'mpeg'}`,
      abortSignal: opts.signal,
    })
    url = blob.url
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new ApiError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`, 0, false, { cause: err })
  }
  const req = { url, filename: file.name, ...(opts.title ? { title: opts.title } : {}) }
  const { body } = await requestWithResponse(
    `/api/analyze/blob${refreshQuery(opts.refresh)}`,
    isAnalysis,
    { method: 'POST', body: JSON.stringify(req), signal: opts.signal },
    'application/json',
  )
  return body
}

/** GET /api/analysis/{id} — a previously computed analysis (404 if never analyzed). */
export function getAnalysis(id: string, signal?: AbortSignal): Promise<Analysis> {
  return request(`/api/analysis/${encodeURIComponent(id)}`, isAnalysis, { signal })
}

/** Raw bytes behind a same-origin audio path such as Analysis.audioUrl. */
export async function fetchAudio(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await send(path, { signal }, 'audio/*')
  if (!res.ok) throw errorFor(res, await res.text())
  return res.arrayBuffer()
}

/** GET /api/moves — every compiled move (incl. mirrored variants) + the library version. */
export function getMoves(signal?: AbortSignal): Promise<MoveLibraryResponse> {
  return request('/api/moves', isMoveLibrary, { signal })
}

export interface ChoreographResult {
  routine: Routine
  /** From the X-Routine-Cache header ("hit" / "miss"); null when absent. */
  cached: boolean | null
}

/** POST /api/choreograph — a routine for a cached analysis (404 if the analysis isn't cached). */
export async function choreograph(req: ChoreographRequest, signal?: AbortSignal): Promise<ChoreographResult> {
  const { body, res } = await requestWithResponse(
    '/api/choreograph',
    isRoutine,
    { method: 'POST', body: JSON.stringify(req), signal },
    'application/json',
  )
  const cache = res.headers.get('X-Routine-Cache')?.toLowerCase()
  return { routine: body, cached: cache === 'hit' ? true : cache === 'miss' ? false : null }
}

/** GET /api/routines/{routineId} — a previously generated routine. */
export function getRoutine(routineId: string, signal?: AbortSignal): Promise<Routine> {
  return request(`/api/routines/${encodeURIComponent(routineId)}`, isRoutine, { signal })
}
