// "Watch your highlights": a button over the results, then the full-screen highlight reel
// (reelPlayer.ts) with the awards, "Save my clips" and the "Share my highlights" toggle (off by
// default). Closing the reel frees the object URLs and deletes the clips from IndexedDB.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getCaption } from './captions'
import { exportHighlights, type ExportableClip } from './exportClips'
import { ReelPlayback, type ReelItem, type ReelScene } from './reelPlayer'
import type { ReelSession } from './reelSession'
import { AWARDS_SEC, TITLE_SEC } from './reelPlayer'
import { MAX_REEL_SEC, reelOrder } from './timeline'
import './reel.css'

function useSession(session: ReelSession): number {
  const version = useRef(0)
  return useSyncExternalStore(
    (cb) =>
      session.subscribe(() => {
        version.current++
        cb()
      }),
    () => version.current,
  )
}

export function ReelLauncher({ session }: { session: ReelSession }) {
  useSession(session)
  const [open, setOpen] = useState(false)
  const clips = session.clips()
  if (open) return <HighlightReel session={session} onClose={() => setOpen(false)} />
  if (!session.ready) return null
  return (
    <div className="reel-launcher" data-overlay-peer>
      {clips.length > 0 ? (
        <button type="button" className="primary reel-launch" onClick={() => setOpen(true)}>
          🎬 Watch your highlights <span className="reel-count">{clips.length}</span>
        </button>
      ) : (
        <p className="reel-none">No highlights this time: string 8 Good-or-better in a row to earn one.</p>
      )}
    </div>
  )
}

function HighlightReel({ session, onClose }: { session: ReelSession; onClose: () => void }) {
  useSession(session)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [scene, setScene] = useState<ReelScene | null>(null)
  const [items, setItems] = useState<ReelItem[] | null>(null)
  const [run, setRun] = useState(0)
  const [saved, setSaved] = useState<string | null>(null)
  const players = session.players()
  const showPlayer = players.length > 1

  // Load blobs -> object URLs + captions once; revoke them when the reel closes.
  useEffect(() => {
    let cancelled = false
    const urls: string[] = []
    const ordered = reelOrder(session.clips(), MAX_REEL_SEC - TITLE_SEC - AWARDS_SEC)
    void Promise.all(
      ordered.map(async (clip): Promise<ReelItem> => {
        const [blob, caption] = await Promise.all([session.videoFor(clip.id).catch(() => null), getCaption(clip)])
        const url = blob ? URL.createObjectURL(blob) : null
        if (url) urls.push(url)
        return { clip, url, caption }
      }),
    ).then((loaded) => {
      if (!cancelled) setItems(loaded)
    })
    return () => {
      cancelled = true
      for (const u of urls) URL.revokeObjectURL(u)
    }
  }, [session])

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!items || !canvas || !video) return
    const p = new ReelPlayback({ canvas, video, audio: audioRef.current, items, awards: session.awards(), title: session.title, showPlayer, onScene: setScene })
    p.start()
    return () => p.stop()
  }, [items, run, session, showPlayer])

  const close = (): void => {
    void session.clear()
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const save = async (): Promise<void> => {
    const withVideo: ExportableClip[] = []
    for (const item of items ?? []) {
      const blob = await session.videoFor(item.clip.id)
      if (blob) withVideo.push({ meta: item.clip, blob })
    }
    const r = await exportHighlights(withVideo, { title: session.title })
    setSaved(r.kind === 'files' ? `Saved ${r.count} clip${r.count === 1 ? '' : 's'} to this device` : 'Your reel is ready')
  }

  const done = scene?.kind === 'done'
  return (
    <div className="reel-overlay" role="dialog" aria-modal="true" aria-label="Highlight reel">
      <div className="reel-frame">
        <canvas ref={canvasRef} className="reel-canvas" aria-label="Your highlight reel" />
        {!items && <p className="reel-loading">Threading the film…</p>}
      </div>
      <video ref={videoRef} className="reel-hidden" muted playsInline />
      {session.audioUrl && <audio ref={audioRef} className="reel-hidden" src={session.audioUrl} preload="auto" />}
      <div className="reel-controls">
        {done && (
          <button type="button" className="primary" onClick={() => setRun((n) => n + 1)}>
            ↻ Watch again
          </button>
        )}
        <button type="button" onClick={() => void save()} disabled={!items} title="Saves the clips as video files on this device">
          💾 Save my clips
        </button>
        <label className="reel-share" title="Lets a room show your clips to the other players. Off by default; nothing is uploaded.">
          <input type="checkbox" checked={session.sharing} onChange={(e) => session.setSharing(e.target.checked)} />
          Share my highlights
        </label>
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
      <p className="reel-privacy">{saved ?? 'Your clips never leave this device. Closing the reel deletes them.'}</p>
    </div>
  )
}
