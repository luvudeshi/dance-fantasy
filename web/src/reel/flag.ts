// Feature flag for the combo cam + highlight reel: on with ?reel=1 (in the page query or the
// hash route, e.g. #/play?reel=1) or localStorage "mb.reel" = "1"; off by default.

import { defaultStorage, type StorageLike } from '../lib/storage'

export const REEL_STORAGE_KEY = 'mb.reel'

function queryFlag(query: string): string | null {
  const q = query.indexOf('?')
  return q < 0 ? null : new URLSearchParams(query.slice(q + 1)).get('reel')
}

export function reelEnabled(
  loc: { search: string; hash: string } | null = typeof window === 'undefined' ? null : window.location,
  storage: Pick<StorageLike, 'getItem'> | null = defaultStorage(),
): boolean {
  const fromUrl = loc ? (queryFlag(loc.hash) ?? queryFlag(loc.search)) : null
  if (fromUrl !== null) return fromUrl === '1'
  try {
    return storage?.getItem(REEL_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
