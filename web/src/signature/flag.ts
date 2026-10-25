// Feature flag for signature dances: "?signature=1" (page or hash query) or localStorage
// "mb.signature" = "1". Off by default; with it off nothing in this folder runs.

import { parseHash } from '../lib/hashRoute'
import { defaultStorage, type StorageLike } from '../lib/storage'

export const SIGNATURE_STORAGE_KEY = 'mb.signature'

export function signatureEnabled(
  loc: Pick<Location, 'search' | 'hash'> | null = typeof window === 'undefined' ? null : window.location,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (loc) {
    const fromQuery = new URLSearchParams(loc.search).get('signature') ?? parseHash(loc.hash).params.get('signature')
    if (fromQuery !== null) return fromQuery === '1'
  }
  try {
    return storage?.getItem(SIGNATURE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
