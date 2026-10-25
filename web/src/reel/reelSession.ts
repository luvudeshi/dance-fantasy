// The combo cam's one object on the play screen: begin() when a scored round starts, feed()
// every batch of CheckpointResults, finish() when the song ends, then the reel reads clips()
// / awards() and close() wipes everything (object URLs + IndexedDB). A new round wipes the
// previous one too. Multi-player ready: a reel takes several players' clips (addPlayer()),
// v1 records only the local player.
//
// Privacy: clips stay on this device. sharedHighlights() exposes them only while the player
// has turned "Share my highlights" on (off by default); nothing is uploaded here.

import { apiUrl } from '../api'
import type { PreparedGame } from '../game/session'
import type { CheckpointResult } from '../game/scoring'
import { selectAwards, type Award } from './awards'
import { ComboClipper, mediaRecorderFactory, type RecorderFactory } from './comboClipper'
import { comboEventFor, emitComboEvent } from './comboEvents'
import { defaultClipStore, type ClipStore } from './clipStore'
import { pickMimeType } from './mime'
import type { ClipMeta, PlayerRoundStats } from './types'

export const LOCAL_PLAYER = { id: 'local', name: 'You' }

export interface ReelPlayer {
  stats: PlayerRoundStats
  clips: ClipMeta[]
}

export interface SharedHighlights {
  playerId: string
  clips: { meta: ClipMeta; blob: Blob | null }[]
}

export interface ReelSessionDeps {
  store?: ClipStore
  createRecorder?: RecorderFactory | null
  mimeType?: string | null
  roomId?: string | null
  /** Picks the stream to record (default recordableStream). */
  streamFor?: (srcObject: unknown) => MediaStream | null
}

/** Live stream from a <video>.srcObject; else the stage canvas (autoplay bot) when it can be captured. */
export function recordableStream(srcObject: unknown): MediaStream | null {
  if (typeof MediaStream !== 'undefined' && srcObject instanceof MediaStream && srcObject.getVideoTracks().some((t) => t.readyState === 'live')) {
    return srcObject
  }
  const canvas = typeof document === 'undefined' ? null : document.querySelector<HTMLCanvasElement>('.play-stage canvas')
  try {
    return canvas?.captureStream?.(30) ?? null
  } catch {
    return null
  }
}

export class ReelSession {
  private readonly store: ClipStore
  private readonly createRecorder: RecorderFactory | null
  private readonly mimeType: string | null
  private readonly roomId: string | null
  private readonly streamFor: (srcObject: unknown) => MediaStream | null
  private clipper: ComboClipper | null = null
  private finishing: Promise<void> | null = null
  private others: ReelPlayer[] = []
  private game: Pick<PreparedGame, 'analysis'> | null = null
  private shareOn = false
  private readonly listeners = new Set<() => void>()
  private ownStream: MediaStream | null = null

  constructor(deps: ReelSessionDeps = {}) {
    this.store = deps.store ?? defaultClipStore()
    this.mimeType = deps.mimeType === undefined ? pickMimeType() : deps.mimeType
    this.createRecorder = deps.createRecorder === undefined ? (this.mimeType === null ? null : mediaRecorderFactory) : deps.createRecorder
    this.roomId = deps.roomId ?? null
    this.streamFor = deps.streamFor ?? recordableStream
  }

  /** A scored round starts: drops the previous round's clips and starts listening. */
  begin(game: Pick<PreparedGame, 'analysis' | 'routine'>, srcObject: unknown, songTime: () => number, latencySec: number): void {
    void this.clear()
    const stream = this.streamFor(srcObject)
    // A captured canvas stream is ours to stop; the camera belongs to the play screen.
    this.ownStream = stream && stream !== srcObject ? stream : null
    this.game = game
    this.clipper = new ComboClipper({
      stream,
      mirrorVideo: stream !== null && this.ownStream === null,
      moves: game.routine.moves,
      playerId: LOCAL_PLAYER.id,
      playerName: LOCAL_PLAYER.name,
      latencySec: Number.isFinite(latencySec) ? latencySec : 0,
      songTime,
      store: this.store,
      createRecorder: this.createRecorder,
      mimeType: this.mimeType ?? '',
      onKeep: (clip) => emitComboEvent(comboEventFor(clip, { roomId: this.roomId, songId: game.analysis.id ?? null })),
    })
  }

  feed(results: readonly CheckpointResult[]): void {
    if (!this.finishing) this.clipper?.push(results)
  }

  /** The song ended. Resolves once every kept clip is stored. */
  finish(): Promise<void> {
    if (!this.clipper) return Promise.resolve()
    this.finishing ??= this.clipper.finish().then(() => {
      this.stopOwnStream()
      this.notify()
    })
    return this.finishing
  }

  get ready(): boolean {
    return this.finishing !== null
  }

  /** Every player's clips + stats (local first). */
  players(): ReelPlayer[] {
    const local = this.clipper ? [{ stats: this.clipper.stats(), clips: [...this.clipper.clips] }] : []
    return [...local, ...this.others]
  }

  clips(): ClipMeta[] {
    return this.players().flatMap((p) => p.clips)
  }

  awards(): Award[] {
    return selectAwards(this.players().map((p) => p.stats))
  }

  /** Rooms seam: another player's clips (their blobs must already be in this session's store). */
  addPlayer(p: ReelPlayer): void {
    this.others = [...this.others.filter((o) => o.stats.playerId !== p.stats.playerId), p]
    this.notify()
  }

  videoFor(id: string): Promise<Blob | null> {
    return this.store.get(id)
  }

  /** The round's song (same-origin path through the API base). */
  get audioUrl(): string | null {
    return this.game ? apiUrl(this.game.analysis.audioUrl) : null
  }

  get title(): string {
    return this.game?.analysis.title ?? 'Midnight Ball'
  }

  get sharing(): boolean {
    return this.shareOn
  }

  setSharing(on: boolean): void {
    this.shareOn = on
    this.notify()
  }

  /** For the rooms feature: the local player's clips, only while sharing is on (else null). */
  async sharedHighlights(): Promise<SharedHighlights | null> {
    if (!this.shareOn || !this.clipper) return null
    const clips = await Promise.all(this.clipper.clips.map(async (meta) => ({ meta, blob: await this.store.get(meta.id) })))
    return { playerId: LOCAL_PLAYER.id, clips }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  private stopOwnStream(): void {
    for (const t of this.ownStream?.getTracks() ?? []) t.stop()
    this.ownStream = null
  }

  /** Drops every clip (IndexedDB too) and turns sharing off. Safe to call repeatedly. */
  async clear(): Promise<void> {
    this.clipper?.dispose()
    this.clipper = null
    this.finishing = null
    this.others = []
    this.game = null
    this.shareOn = false
    this.stopOwnStream()
    this.notify()
    try {
      await this.store.clear()
    } catch (err) {
      console.warn('Combo cam: could not clear stored clips', err)
    }
  }
}

let current: ReelSession | null = null

/** The play page's reel session, or null when the feature flag is off. */
export function createReelSession(enabled: boolean, deps?: ReelSessionDeps): ReelSession | null {
  current = enabled ? new ReelSession(deps) : null
  return current
}

/** Rooms seam: the local player's highlights if they chose to share them, else null. */
export function getSharedHighlights(): Promise<SharedHighlights | null> {
  return current ? current.sharedHighlights() : Promise.resolve(null)
}
