// Typed client for the FastAPI server (HTTP API in shared/README.md). In dev, Vite
// proxies /api to 127.0.0.1:8000, so VITE_API_BASE is normally unset ('' = same origin).

import { isAbortError } from './lib/errors'

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
export async function fetchSongAudio(file: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await send(`/api/songs/${encodeURIComponent(file)}`, { signal }, 'audio/*')
  if (!res.ok) throw errorFor(res, await res.text())
  return res.arrayBuffer()
}
