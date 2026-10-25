// Hash routes with an optional query: "#/play?routine=0123456789abcdef". The path picks the
// page; the query carries page parameters (deep links).

export interface HashRoute {
  /** "#/play" (no query); "" when the hash is empty. */
  path: string
  params: URLSearchParams
}

export function parseHash(hash: string): HashRoute {
  const q = hash.indexOf('?')
  return q < 0 ? { path: hash, params: new URLSearchParams() } : { path: hash.slice(0, q), params: new URLSearchParams(hash.slice(q + 1)) }
}

/** Server routine ids: 16 lowercase hex characters. */
export const isRoutineId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v)

/**
 * The routine a "#/play?routine=<id>" deep link asks for (null when absent / malformed, and for
 * other pages: "#/teach?routine=<id>" must not make a still-mounted Play page launch the game).
 */
export function routineFromHash(hash: string): string | null {
  const { path, params } = parseHash(hash)
  const id = params.get('routine')
  return path === '#/play' && isRoutineId(id) ? id : null
}

export const playRoutineHash = (routineId: string): string => `#/play?routine=${routineId}`
