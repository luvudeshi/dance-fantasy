// The end-of-round highlight reel: plays the recorded round's best moments back to back (seek to
// each clip's start, next clip once timeupdate passes its end) inside the magic mirror, with the
// combo ribbon and the moves danced. With `audioSrc` the song plays along from each clip's song
// time (the recording itself is silent); a browser that blocks it shows the reel without music.
// Replay, skip, jump to a moment, download the whole round, and Web Share where the browser can
// share the file. Opens by itself; closed, it leaves a launcher button on the results screen.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Modal } from '../theme/components'
import { Icon } from '../theme/Icon'
import type { HighlightRecording } from './recorder'
import './highlights.css'

/** Music further than this from the picture is re-seeked (checked on every timeupdate, ~4 Hz). */
const MAX_MUSIC_DRIFT_SEC = 0.08

interface Props {
  recording: HighlightRecording
  /** Opens the reel as soon as it mounts (default true). */
  autoOpen?: boolean
  /** The song (same timeline as the game's song time), played under each clip. */
  audioSrc?: string
}

export default function HighlightReel({ recording, autoOpen = true, audioSrc }: Props) {
  const { clips, url, fileName } = recording
  const [open, setOpen] = useState(autoOpen)
  const [index, setIndex] = useState(0)
  const [ended, setEnded] = useState(false)
  const [aspect, setAspect] = useState('16 / 9')
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const indexRef = useRef(0)
  const file = useMemo(() => new File([recording.blob], fileName, { type: recording.mimeType }), [recording, fileName])
  const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
  const clip = clips[Math.min(index, clips.length - 1)]

  // Keys pressed in the reel stay in it: the stage's shortcuts listen on window (Esc = lobby, R, Space).
  useEffect(() => {
    const dialog = videoRef.current?.closest('dialog')
    if (!dialog) return
    const keep = (e: KeyboardEvent): void => e.stopPropagation()
    dialog.addEventListener('keydown', keep)
    return () => dialog.removeEventListener('keydown', keep)
  }, [])

  const playClip = (i: number): void => {
    const v = videoRef.current
    const c = clips[i]
    if (!v || !c) return
    indexRef.current = i
    setIndex(i)
    setEnded(false)
    v.currentTime = c.start
    v.play().catch((err: unknown) => console.warn('[highlights] playback:', err))
    const a = audioRef.current
    if (!a) return
    a.currentTime = Math.max(0, c.songStart)
    a.play().catch((err: unknown) => console.warn('[highlights] music:', err))
  }

  const pause = (): void => {
    videoRef.current?.pause()
    audioRef.current?.pause()
  }

  const onTimeUpdate = (): void => {
    const v = videoRef.current
    const c = clips[indexRef.current]
    if (!v || !c || v.seeking || v.paused) return
    if (v.currentTime < c.end) {
      // The two seeks finish at different moments: pull the music back onto the picture.
      const a = audioRef.current
      const want = c.songStart + (v.currentTime - c.start)
      if (a && !a.paused && !a.seeking && Math.abs(a.currentTime - want) > MAX_MUSIC_DRIFT_SEC) a.currentTime = want
      return
    }
    if (indexRef.current + 1 < clips.length) playClip(indexRef.current + 1)
    else {
      pause()
      setEnded(true)
    }
  }

  const close = (): void => {
    pause()
    setOpen(false)
  }

  const reopen = (): void => {
    setOpen(true)
    playClip(0)
  }

  const share = (): void => {
    navigator.share({ files: [file], title: 'My Dance Fantasy highlights' }).catch((err: unknown) => {
      if (!(err instanceof DOMException && err.name === 'AbortError')) console.warn('[highlights] share:', err)
    })
  }

  return (
    <>
      {!open && (
        <Button className="hl-launch df-pop-in" icon="sparkles" onClick={reopen}>
          Your highlights
        </Button>
      )}
      <Modal
        open={open}
        onClose={close}
        title="Your best moments"
        actions={
          <>
            <Button variant="secondary" icon="play" onClick={() => playClip(0)}>
              Replay
            </Button>
            <Button variant="secondary" onClick={() => playClip(index + 1)} disabled={ended || index + 1 >= clips.length}>
              Skip
            </Button>
            <a className="df-btn df-btn-secondary" href={url} download={fileName}>
              Download
            </a>
            {canShare && (
              <Button icon="sparkles" onClick={share}>
                Share
              </Button>
            )}
          </>
        }
      >
        <div className="hl-reel">
          <div className="df-mirror df-st-live hl-mirror">
            <div className="df-mirror-glass df-mirror-night hl-glass" style={{ aspectRatio: aspect }}>
              <video
                ref={videoRef}
                src={url}
                muted
                playsInline
                preload="auto"
                aria-label="Highlight reel of your dance"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget
                  if (v.videoWidth > 0 && v.videoHeight > 0) setAspect(`${v.videoWidth} / ${v.videoHeight}`)
                  if (open) playClip(indexRef.current)
                }}
                onTimeUpdate={onTimeUpdate}
              />
              {audioSrc && <audio ref={audioRef} src={audioSrc} preload="auto" />}
            </div>
            {clip && (
              <span className="df-ribbon-wrap hl-ribbon" aria-live="polite">
                <span className={`df-ribbon${clip.best ? ' df-ribbon-gold' : ''}`}>{ended ? 'That’s a wrap!' : clip.label}</span>
              </span>
            )}
          </div>
          {clip && (
            <div className="df-spread hl-caption">
              <p className="df-voice hl-moves">{clip.moves.slice(0, 3).join(' · ') || 'Dancing up a storm'}</p>
              {clip.best && (
                <Badge tone="gold" icon="crown">
                  Best streak
                </Badge>
              )}
            </div>
          )}
          {clips.length > 1 && (
            <div className="df-cluster hl-clips" role="group" aria-label="Moments">
              {clips.map((c, i) => (
                <button key={c.start} type="button" className="df-chip" aria-pressed={i === index} onClick={() => playClip(i)}>
                  {c.best && <Icon name="crown" size="xs" cut="none" />}
                  <span className="df-num">{c.combo}x</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
