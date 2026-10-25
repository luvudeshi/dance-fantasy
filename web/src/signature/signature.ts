// Signature dances (shared/README.md "Signature dances"): GET /api/signature/lookup and
// /api/signature/moves, the pins they turn into, the in-game banner text and the 2x multiplier.

import type { LibraryMove, PinnedMoveRequest } from '@shared/moves'
import type { Routine, SignatureDance } from '@shared/routine'
import { apiUrl, ApiError, isLibraryMove, SERVER_UNREACHABLE_MESSAGE } from '../api'
import type { Checkpoint } from '../game/scoring'
import { isAbortError } from '../lib/errors'

export interface SignatureLink {
  title: string
  url: string
  source: string
}

export interface SignatureLookup {
  title: string
  artist: string
  found: boolean
  danceName: string | null
  /** "" when unknown: never guessed. */
  creator: string
  year: number | null
  confidence: number | null
  /** Videos as links only (https). */
  links: SignatureLink[]
  source: 'table' | 'serpapi' | 'gemini' | 'library' | 'none'
  /** A signature move to pin on the chorus, when the library has one for this dance. */
  moveId: string | null
  moveName: string | null
}

export type SignatureMove = LibraryMove & { signatureDance: string; songs: string[]; creator: string }

/** Points multiplier for a signature move's own checkpoints. */
export const SIGNATURE_MULTIPLIER = 2

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v)
const isNumOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v))

/** Only https links are ever rendered. */
export function safeLink(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

export function isSignatureLookup(v: unknown): v is SignatureLookup {
  return (
    isRecord(v) &&
    isStr(v.title) &&
    isStr(v.artist) &&
    typeof v.found === 'boolean' &&
    isStrOrNull(v.danceName) &&
    isStr(v.creator) &&
    isNumOrNull(v.year) &&
    isNumOrNull(v.confidence) &&
    Array.isArray(v.links) &&
    v.links.every((l) => isRecord(l) && isStr(l.title) && isStr(l.url) && isStr(l.source)) &&
    isStr(v.source) &&
    isStrOrNull(v.moveId) &&
    isStrOrNull(v.moveName)
  )
}

export function isSignatureMove(v: unknown): v is SignatureMove {
  return isLibraryMove(v) && isRecord(v) && isStr(v.signatureDance) && Array.isArray(v.songs) && v.songs.every(isStr) && isStr(v.creator)
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(apiUrl(path), { headers: { Accept: 'application/json' }, signal })
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new ApiError(SERVER_UNREACHABLE_MESSAGE, 0, true, { cause: err })
  }
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(isRecord(body) && isStr(body.detail) ? body.detail : `HTTP ${res.status}`, res.status, false)
  return body
}

/** GET /api/signature/lookup: the song's signature dance (bundled table, else SerpApi + Gemini). */
export async function lookupSignature(title: string, artist = '', signal?: AbortSignal): Promise<SignatureLookup> {
  const q = new URLSearchParams({ title: title.trim(), artist: artist.trim() })
  const body = await getJson(`/api/signature/lookup?${q.toString()}`, signal)
  if (!isSignatureLookup(body)) throw new ApiError('Unexpected response from /api/signature/lookup', 200, false)
  return { ...body, links: body.links.filter((l) => safeLink(l.url) !== null) }
}

/** GET /api/signature/moves: the signature move library (GET /api/moves format + dance, songs, creator). */
export async function getSignatureMoves(signal?: AbortSignal): Promise<SignatureMove[]> {
  const body = await getJson('/api/signature/moves', signal)
  if (!isRecord(body) || !Array.isArray(body.moves)) throw new ApiError('Unexpected response from /api/signature/moves', 200, false)
  return body.moves.filter(isSignatureMove)
}

/** The pins a lookup asks for: its signature move on every chorus, or none (dance known but no move). */
export function pinsFor(lookup: SignatureLookup | null): PinnedMoveRequest[] {
  return lookup?.found && lookup.moveId ? [{ moveId: lookup.moveId, placement: 'chorus' }] : []
}

/** Our moves approximate the real dances: always "inspired by". */
export const inspiredBy = (dance: string): string => `inspired by ${dance}`

/** "★ SIGNATURE: The Renegade, created by Jalaiah Harmon", or "★ SIGNATURE: inspired by YMCA arms". */
export function bannerText(sd: SignatureDance): string {
  return sd.creator ? `★ SIGNATURE: ${sd.name}, created by ${sd.creator}` : `★ SIGNATURE: ${inspiredBy(sd.name)}`
}

/** The signature move playing at `songTime`, or null. */
export function signatureAt(routine: Pick<Routine, 'moves'>, songTime: number): Routine['moves'][number] | null {
  for (const m of routine.moves) {
    if (m.startTime > songTime) break
    if (m.signatureDance && songTime < m.endTime) return m
  }
  return null
}

/** Checkpoints of signature moves score SIGNATURE_MULTIPLIER x (their own points only). */
export function withSignatureMultiplier(checkpoints: Checkpoint[], routine: Pick<Routine, 'moves'>): Checkpoint[] {
  return checkpoints.map((cp) => (routine.moves[cp.moveIndex]?.signatureDance ? { ...cp, multiplier: SIGNATURE_MULTIPLIER } : cp))
}

/** The gallery's library plus the signature moves (#/moves with the flag on); unchanged if they fail to load. */
export async function withSignatureMoves<L extends { moves: LibraryMove[] }>(lib: L, signal?: AbortSignal): Promise<L> {
  try {
    const sig = await getSignatureMoves(signal)
    return { ...lib, moves: [...lib.moves, ...sig] }
  } catch (err) {
    if (isAbortError(err)) throw err
    return lib
  }
}

/** "inspired by YMCA arms" for a signature move from GET /api/signature/moves, else null. */
export const signatureLabel = (move: LibraryMove): string | null => (isSignatureMove(move) ? inspiredBy(move.signatureDance) : null)
