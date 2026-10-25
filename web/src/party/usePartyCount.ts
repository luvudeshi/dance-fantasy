// "#/play?party=3" -> 3 for the router (App.tsx): null outside party mode. Re-renders on hash changes,
// also when only the query changes (App's own route store only follows the path).

import { useSyncExternalStore } from 'react'
import { partyCountFromHash } from './players'

const subscribeHash = (cb: () => void): (() => void) => {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function usePartyCount(): number | null {
  return useSyncExternalStore(subscribeHash, () => partyCountFromHash(window.location.hash))
}
