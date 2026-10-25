// Where kept clip videos live until the reel closes: IndexedDB (off the JS heap), or memory
// where IndexedDB is missing / blocked (private mode, tests). Nothing here leaves the device.

export interface ClipStore {
  put(id: string, blob: Blob): Promise<void>
  get(id: string): Promise<Blob | null>
  delete(id: string): Promise<void>
  /** Removes every clip. */
  clear(): Promise<void>
}

export class MemoryClipStore implements ClipStore {
  readonly blobs = new Map<string, Blob>()
  put(id: string, blob: Blob): Promise<void> {
    this.blobs.set(id, blob)
    return Promise.resolve()
  }
  get(id: string): Promise<Blob | null> {
    return Promise.resolve(this.blobs.get(id) ?? null)
  }
  delete(id: string): Promise<void> {
    this.blobs.delete(id)
    return Promise.resolve()
  }
  clear(): Promise<void> {
    this.blobs.clear()
    return Promise.resolve()
  }
}

const DB_NAME = 'midnight-ball-reel'
const STORE = 'clips'

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  })
}

export class IdbClipStore implements ClipStore {
  private db: Promise<IDBDatabase> | null = null
  private readonly factory: IDBFactory

  constructor(factory: IDBFactory) {
    this.factory = factory
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = this.factory.open(DB_NAME, 1)
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE)
      }
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error ?? new Error('IndexedDB unavailable'))
      r.onblocked = () => reject(new Error('IndexedDB blocked'))
    })
    return this.db
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open()
    return request(fn(db.transaction(STORE, mode).objectStore(STORE)))
  }

  async put(id: string, blob: Blob): Promise<void> {
    await this.run('readwrite', (s) => s.put(blob, id))
  }
  async get(id: string): Promise<Blob | null> {
    const v: unknown = await this.run('readonly', (s) => s.get(id))
    return v instanceof Blob ? v : null
  }
  async delete(id: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(id))
  }
  async clear(): Promise<void> {
    await this.run('readwrite', (s) => s.clear())
  }
}

/** Uses IndexedDB, falling back to memory for the session when it fails (once). */
export class FallbackClipStore implements ClipStore {
  private primary: ClipStore | null
  private readonly memory = new MemoryClipStore()

  constructor(primary: ClipStore | null) {
    this.primary = primary
  }

  private async use<T>(fn: (s: ClipStore) => Promise<T>): Promise<T> {
    if (this.primary) {
      try {
        return await fn(this.primary)
      } catch (err) {
        console.warn('Combo cam: IndexedDB failed, keeping clips in memory', err)
        this.primary = null
      }
    }
    return fn(this.memory)
  }

  put(id: string, blob: Blob): Promise<void> {
    return this.use((s) => s.put(id, blob))
  }
  async get(id: string): Promise<Blob | null> {
    return (await this.use((s) => s.get(id))) ?? this.memory.get(id)
  }
  async delete(id: string): Promise<void> {
    await this.memory.delete(id)
    await this.use((s) => s.delete(id))
  }
  async clear(): Promise<void> {
    await this.memory.clear()
    await this.use((s) => s.clear())
  }
}

export function defaultClipStore(): ClipStore {
  let idb: IDBFactory | null = null
  try {
    idb = typeof indexedDB === 'undefined' ? null : indexedDB
  } catch {
    idb = null
  }
  return new FallbackClipStore(idb ? new IdbClipStore(idb) : null)
}
