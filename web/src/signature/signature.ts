// GET /api/songs/signature (shared/README.md "AI endpoints"): the song's well-known dance, found by
// SerpApi and summarised by the AI, with move ids from GET /api/moves. Asked by the song's analysis id (or a
// library file name): the server takes the title and artist from what it knows. Results are kept per song
// for the page's lifetime (the server caches them on disk too); failures are not kept, so a retry asks again.

import { apiUrl, getMoves } from '../api'

export interface KeyMoment {
  label: string
  approxTimeSec?: number | null
}

export interface SignatureSource {
  title: string
  link: string
  thumbnail?: string | null
  source: string
}

export interface Signature {
  found: boolean
  summary: string
  keyMoments: KeyMoment[]
  suggestedMoveIds: string[]
  sources: SignatureSource[]
}

/** Which song: an analysis the server has, or a file from the song library. */
export type SignatureSong = { analysisId: string } | { file: string }

const songParams = (song: SignatureSong): Record<string, string> => ('analysisId' in song ? { analysisId: song.analysisId } : { file: song.file })

export type SignatureResult =
  | { status: 'ok'; signature: Signature }
  /** 404: the server has no SERPAPI_API_KEY or no AI key, or doesn't know the song. */
  | { status: 'not-configured'; message: string }
  /** unreachable, 502 (search failed), 503 (no usable AI answer), a bad reply */
  | { status: 'error'; message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isOptNum = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v))
const isOptStr = (v: unknown): boolean => v === undefined || v === null || isStr(v)

export function isSignature(v: unknown): v is Signature {
  return (
    isRecord(v) &&
    typeof v.found === 'boolean' &&
    isStr(v.summary) &&
    Array.isArray(v.keyMoments) &&
    v.keyMoments.every((m) => isRecord(m) && isStr(m.label) && isOptNum(m.approxTimeSec)) &&
    Array.isArray(v.suggestedMoveIds) &&
    v.suggestedMoveIds.every(isStr) &&
    Array.isArray(v.sources) &&
    v.sources.every((s) => isRecord(s) && isStr(s.title) && isStr(s.link) && isStr(s.source) && isOptStr(s.thumbnail))
  )
}

/** The URL when it is http(s), else null (links from search results never get another scheme). */
export function safeUrl(url: string | null | undefined, httpsOnly = false): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (!httpsOnly && u.protocol === 'http:') ? u.href : null
  } catch {
    return null
  }
}

/** "1:05" for 65 s; null without a usable time. */
export function formatMoment(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return null
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Display names for move ids (unknown ids get a tidied id: the library may have changed since). */
export function moveNames(ids: readonly string[], names: ReadonlyMap<string, string>): { id: string; name: string }[] {
  return ids.map((id) => ({
    id,
    name: names.get(id) ?? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  }))
}

function detail(body: unknown): string | null {
  return isRecord(body) && isStr(body.detail) ? body.detail : null
}

export async function fetchSignature(song: SignatureSong, signal?: AbortSignal, endpoint = apiUrl('/api/songs/signature')): Promise<SignatureResult> {
  let res: Response
  try {
    res = await fetch(`${endpoint}?${new URLSearchParams(songParams(song))}`, { headers: { Accept: 'application/json' }, signal })
  } catch {
    return { status: 'error', message: 'The royal library is out of reach (server not reachable).' }
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // not JSON (e.g. the dev proxy's empty 502)
  }
  if (res.status === 404) return { status: 'not-configured', message: detail(body) ?? 'Signature dances are not set up on this server.' }
  if (!res.ok) return { status: 'error', message: detail(body) ?? `The scribes came back empty-handed (HTTP ${res.status}).` }
  if (!isSignature(body)) return { status: 'error', message: 'The scribes sent back something unreadable.' }
  return { status: 'ok', signature: body }
}

const signatures = new Map<string, Promise<SignatureResult>>()

/** The cache key of a song (also the card's React-ish identity). */
export const signatureKey = (song: SignatureSong): string => ('analysisId' in song ? `a:${song.analysisId}` : `f:${song.file}`)

/** fetchSignature, shared and kept per song unless it failed. */
export function loadSignature(song: SignatureSong): Promise<SignatureResult> {
  const key = signatureKey(song)
  const hit = signatures.get(key)
  if (hit) return hit
  const p = fetchSignature(song)
  signatures.set(key, p)
  void p.then((r) => {
    if (r.status === 'error' && signatures.get(key) === p) signatures.delete(key)
  })
  return p
}

let moveNameMap: Promise<ReadonlyMap<string, string>> | null = null

/** id -> display name from GET /api/moves (fetched once; an empty map if it fails, retried next time). */
export function loadMoveNames(): Promise<ReadonlyMap<string, string>> {
  moveNameMap ??= getMoves().then(
    (lib) => new Map(lib.moves.map((m) => [m.id, m.name])),
    () => {
      moveNameMap = null
      return new Map<string, string>()
    },
  )
  return moveNameMap
}
