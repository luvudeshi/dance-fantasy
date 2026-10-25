export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** localStorage, or null where it is missing or blocked (blocked storage throws on access). */
export function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** JSON from storage; null when missing, corrupt or unreadable. */
export function readJson(key: string, storage: StorageLike | null = defaultStorage()): unknown {
  try {
    const raw = storage?.getItem(key)
    return raw ? (JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

/** Best effort: quota / private mode just means it isn't remembered. */
export function writeJson(key: string, value: unknown, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    // not remembered
  }
}
