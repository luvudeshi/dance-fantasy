// Typed client for the FastAPI server (HTTP API in shared/README.md). In dev, Vite
// proxies /api to 127.0.0.1:8000, so VITE_API_BASE is normally unset ('' = same origin).

import { ANALYSIS_SECTION_LABELS, type Analysis, type AnalysisSection, type SectionLabel } from '@shared/analysis'
import { isAbortError } from './lib/errors'

export type { Analysis, AnalysisSection, SectionLabel }

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
async function send(path: string, init: RequestOptions, accept: string): Promise<Response> {
  try {
    return await fetch(apiUrl(path), { ...init, headers: { Accept: accept } })
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

async function request<T>(path: string, guard: (v: unknown) => v is T, init: RequestOptions = {}): Promise<T> {
  const res = await send(path, init, 'application/json')
  const text = await res.text()
  if (!res.ok) throw errorFor(res, text)
  const body = parseJson(text)
  if (!guard(body)) {
    throw new ApiError(`Unexpected response from ${path} (does the server match shared/README.md?)`, res.status, false)
  }
  return body
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

/** POST /api/analyze (multipart `file`, optional `title`) — analyzes an uploaded song. */
export function analyzeUpload(file: File, opts: AnalyzeOptions & { title?: string } = {}): Promise<Analysis> {
  const form = new FormData()
  form.append('file', file, file.name)
  if (opts.title) form.append('title', opts.title)
  return request(`/api/analyze${refreshQuery(opts.refresh)}`, isAnalysis, { method: 'POST', body: form, signal: opts.signal })
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
