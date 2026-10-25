// Room modes client (versus / crew): the RoomView fields the mode UI reads, and the mode endpoints
// (shared/README.md, "Stage 6 endpoints": /mode, /beats, /rematch, /songs/{id}/heatmap).
// ponytail: its own tiny fetch because src/api.ts's request() can't send X-Player-Token; fold into the
// rooms client once one exists.

import { ApiError, apiUrl, SERVER_UNREACHABLE_MESSAGE } from '../../api'
import { isAbortError } from '../../lib/errors'

export type RoomMode = 'versus' | 'crew'
export type Grade = 'perfect' | 'good' | 'ok' | 'miss'
export type RoomState = 'lobby' | 'countdown' | 'playing' | 'finished'

export interface BeatJudgement {
  /** the routine's checkpoint index (same on every device), 0..20000 */
  beat: number
  /** 0..100 */
  score: number
  grade: Grade
}

export interface ModePlayer {
  id: string
  name: string
  isHost: boolean
  ready: boolean
  connected: boolean
  score: number
  accuracy: number
  progress: number
  finished: boolean
  beatsWon: number
}

export interface CrewStats {
  teamScore: number
  syncBonus: number
  syncedBeats: number
  syncStreak: number
  bestSyncStreak: number
  lastSyncBeat: number | null
}

/** The part of the server's RoomView the mode UI uses (a full RoomView satisfies it). */
export interface ModeRoom {
  code: string
  state: RoomState
  hostId: string
  mode: RoomMode
  routine: { analysisId: string; title: string } | null
  players: ModePlayer[]
  leaderId: string | null
  crew: CrewStats
}

export interface HeatBeat {
  beat: number
  avgScore: number
  samples: number
}

export const MAX_BEATS_PER_POST = 64
export const MAX_BEAT = 20_000
export const GRADES: readonly Grade[] = ['perfect', 'good', 'ok', 'miss']

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isState = (v: unknown): v is RoomState => v === 'lobby' || v === 'countdown' || v === 'playing' || v === 'finished'
export const isRoomMode = (v: unknown): v is RoomMode => v === 'versus' || v === 'crew'

function isModePlayer(v: unknown): v is ModePlayer {
  return (
    isRecord(v) &&
    isStr(v.id) &&
    isStr(v.name) &&
    isBool(v.isHost) &&
    isBool(v.ready) &&
    isBool(v.connected) &&
    isNum(v.score) &&
    isNum(v.accuracy) &&
    isNum(v.progress) &&
    isBool(v.finished) &&
    isNum(v.beatsWon)
  )
}

function isCrew(v: unknown): v is CrewStats {
  return (
    isRecord(v) &&
    isNum(v.teamScore) &&
    isNum(v.syncBonus) &&
    isNum(v.syncedBeats) &&
    isNum(v.syncStreak) &&
    isNum(v.bestSyncStreak) &&
    (v.lastSyncBeat === null || isNum(v.lastSyncBeat))
  )
}

export function isModeRoom(v: unknown): v is ModeRoom {
  return (
    isRecord(v) &&
    isStr(v.code) &&
    isState(v.state) &&
    isStr(v.hostId) &&
    isRoomMode(v.mode) &&
    (v.routine === null || (isRecord(v.routine) && isStr(v.routine.analysisId) && isStr(v.routine.title))) &&
    Array.isArray(v.players) &&
    v.players.every(isModePlayer) &&
    (v.leaderId === null || isStr(v.leaderId)) &&
    isCrew(v.crew)
  )
}

function isHeatmap(v: unknown): v is { analysisId: string; beats: HeatBeat[] } {
  return (
    isRecord(v) &&
    isStr(v.analysisId) &&
    Array.isArray(v.beats) &&
    v.beats.every((b) => isRecord(b) && isNum(b.beat) && isNum(b.avgScore) && isNum(b.samples))
  )
}

function detailOf(text: string): string | null {
  try {
    const body: unknown = JSON.parse(text)
    if (isRecord(body) && isStr(body.detail)) return body.detail
  } catch {
    return null // not JSON (e.g. the dev proxy's empty 502)
  }
  return null
}

/** JSON request with the room token; throws ApiError like src/api.ts. */
export async function roomRequest<T>(
  path: string,
  guard: (v: unknown) => v is T,
  opts: { token?: string | null; body?: unknown; method?: 'GET' | 'POST'; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (opts.token) headers['X-Player-Token'] = opts.token
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    })
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new ApiError(SERVER_UNREACHABLE_MESSAGE, 0, true, { cause: err })
  }
  const text = await res.text()
  if (!res.ok) {
    const unreachable = res.status === 502 || res.status === 504
    throw new ApiError(detailOf(text) ?? (unreachable ? SERVER_UNREACHABLE_MESSAGE : `HTTP ${res.status}`), res.status, unreachable)
  }
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null // falls through to the guard's error below
  }
  if (!guard(body)) throw new ApiError(`Unexpected response from ${path}`, res.status, false)
  return body
}

const roomPath = (code: string, action: string): string => `/api/rooms/${encodeURIComponent(code)}/${action}`

export function setRoomMode(code: string, token: string, mode: RoomMode): Promise<ModeRoom> {
  return roomRequest(roomPath(code, 'mode'), isModeRoom, { token, body: { mode } })
}

export function postBeats(code: string, token: string, beats: readonly BeatJudgement[]): Promise<ModeRoom> {
  return roomRequest(roomPath(code, 'beats'), isModeRoom, { token, body: { beats } })
}

export function rematch(code: string, token: string): Promise<ModeRoom> {
  return roomRequest(roomPath(code, 'rematch'), isModeRoom, { token, method: 'POST' })
}

export async function getHeatmap(analysisId: string, signal?: AbortSignal): Promise<HeatBeat[]> {
  const res = await roomRequest(`/api/songs/${encodeURIComponent(analysisId)}/heatmap`, isHeatmap, { signal })
  return res.beats
}
