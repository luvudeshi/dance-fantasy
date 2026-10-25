// SPIKE 2: server beat tracking + audio-clock playback. Visuals are derived every
// animation frame from the AudioContext clock (songTime), never from timers; this is the
// pattern the game loop will reuse.

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { beatsForSong, beatsForUpload, fetchSongAudio, listSongs, type BeatResult, type SongInfo } from '../api'
import { beatIndexAt, songTime, type SongClock } from '../audio/clock'
import { scheduleClicks, type ClickTrack } from '../audio/metronome'
import { prepareCanvas } from '../lib/canvas'
import { errorMessage, isAbortError } from '../lib/errors'
import { useLatest } from '../lib/useLatest'
import { UI_FONT } from '../theme/fonts'

type AudioSource = { kind: 'server'; file: string } | { kind: 'upload'; file: File }

interface Analysis {
  result: BeatResult
  source: AudioSource
}

interface Playback {
  clock: SongClock
  source: AudioBufferSourceNode
  clicks: ClickTrack
  beats: readonly number[]
  duration: number
  /** Monotonic clamp for the displayed song time. */
  lastT: number
}

const START_DELAY_SEC = 0.1
const FLASH_DECAY_SEC = 0.12

const sourceKey = (s: AudioSource): string =>
  s.kind === 'server' ? `server:${s.file}` : `upload:${s.file.name}:${s.file.size}:${s.file.lastModified}`

function formatTime(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
}

function drawTimeline(canvas: HTMLCanvasElement, beats: readonly number[], duration: number, t: number | null): void {
  const prepared = prepareCanvas(canvas)
  if (!prepared) return
  const { ctx, width, height } = prepared
  ctx.fillStyle = 'rgba(148, 163, 255, 0.06)'
  ctx.fillRect(0, 0, width, height)
  if (!(duration > 0)) return
  const xOf = (sec: number): number => (sec / duration) * width

  // Time labels: pick a step that keeps them >= 60 px apart.
  const steps = [1, 2, 5, 10, 15, 30, 60, 120]
  const step = steps.find((s) => xOf(s) >= 60) ?? 300
  ctx.font = `600 11px ${UI_FONT}`
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = 'rgba(203, 213, 255, 0.55)'
  ctx.strokeStyle = 'rgba(203, 213, 255, 0.12)'
  ctx.lineWidth = 1
  for (let s = 0; s <= duration; s += step) {
    const x = Math.round(xOf(s)) + 0.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
    ctx.fillText(formatTime(s), x + 3, height - 2)
  }

  // Beat ticks; played beats brighter.
  const tickTop = height * 0.18
  const tickBottom = height * 0.72
  const played = t === null ? -1 : beatIndexAt(beats, t)
  ctx.lineWidth = Math.max(1, Math.min(2, width / Math.max(1, beats.length) / 3))
  for (const [i, b] of beats.entries()) {
    const x = xOf(b)
    ctx.strokeStyle = i <= played ? 'rgba(196, 181, 253, 0.95)' : 'rgba(125, 211, 252, 0.45)'
    ctx.beginPath()
    ctx.moveTo(x, tickTop)
    ctx.lineTo(x, tickBottom)
    ctx.stroke()
  }

  if (t !== null) {
    const x = xOf(Math.min(Math.max(t, 0), duration))
    ctx.strokeStyle = '#facc15'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
}

export default function BeatSpike() {
  const [songs, setSongs] = useState<SongInfo[] | null>(null)
  const [songsError, setSongsError] = useState<string | null>(null)
  const [songsReload, setSongsReload] = useState(0)
  const [selected, setSelected] = useState('')
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [metronome, setMetronome] = useState(true)
  // Off by default: visuals use the spec'd raw clock (ctx.currentTime - startAt). Whether
  // Stage 3 compensates output latency for visuals/scoring is still to be decided.
  const [compensate, setCompensate] = useState(false)

  const ctxRef = useRef<AudioContext | null>(null)
  const bufferRef = useRef<{ key: string; buffer: AudioBuffer } | null>(null)
  const playbackRef = useRef<Playback | null>(null)
  const tokenRef = useRef(0)
  const rafRef = useRef(0)
  const requestRef = useRef<AbortController | null>(null)
  const timelineRef = useRef<HTMLCanvasElement>(null)
  const circleRef = useRef<HTMLDivElement>(null)
  const beatLabelRef = useRef<HTMLSpanElement>(null)
  const timeLabelRef = useRef<HTMLSpanElement>(null)
  const latencyLabelRef = useRef<HTMLSpanElement>(null)
  const analysisRef = useLatest(analysis)

  // --- song list ---------------------------------------------------------------------
  useEffect(() => {
    const ac = new AbortController()
    listSongs(ac.signal).then(
      (list) => {
        setSongs(list)
        setSongsError(null)
        setSelected((cur) => (cur && list.some((s) => s.file === cur) ? cur : (list[0]?.file ?? '')))
      },
      (err: unknown) => {
        if (!isAbortError(err)) setSongsError(errorMessage(err))
      },
    )
    return () => ac.abort()
  }, [songsReload])

  // --- playback ----------------------------------------------------------------------
  const resetVisuals = useCallback((): void => {
    const circle = circleRef.current
    if (circle) {
      circle.style.transform = 'scale(1)'
      circle.style.setProperty('--flash', '0')
    }
    if (beatLabelRef.current) beatLabelRef.current.textContent = '–'
    if (timeLabelRef.current) timeLabelRef.current.textContent = formatTime(0)
    if (latencyLabelRef.current) latencyLabelRef.current.textContent = '–'
    const a = analysisRef.current
    if (timelineRef.current) drawTimeline(timelineRef.current, a?.result.beats ?? [], a?.result.durationSec ?? 0, null)
  }, [analysisRef])

  const stop = useCallback((): void => {
    tokenRef.current++
    cancelAnimationFrame(rafRef.current)
    const pb = playbackRef.current
    playbackRef.current = null
    if (pb) {
      pb.source.onended = null
      try {
        pb.source.stop()
      } catch {
        // Not started yet in some browsers; disconnecting below silences it anyway.
      }
      pb.source.disconnect()
      pb.clicks.stop()
    }
    setPlaying(false)
    setLoadingAudio(false)
    resetVisuals()
  }, [resetVisuals])

  /** Starts the per-frame visual loop for the current playbackRef (stops when it is cleared). */
  const startFrameLoop = useCallback((): void => {
    function frame(): void {
      const pb = playbackRef.current
      if (!pb) return
      rafRef.current = requestAnimationFrame(frame)
      // The only clock: the AudioContext's (latency compensated when enabled).
      const t = Math.max(pb.lastT, songTime(pb.clock))
      pb.lastT = t

      const i = beatIndexAt(pb.beats, t)
      const since = i >= 0 ? t - pb.beats[i] : Number.POSITIVE_INFINITY
      const flash = Math.exp(-since / FLASH_DECAY_SEC)
      const circle = circleRef.current
      if (circle) {
        circle.style.transform = `scale(${(1 + 0.18 * flash).toFixed(4)})`
        circle.style.setProperty('--flash', flash.toFixed(4))
      }
      if (beatLabelRef.current) beatLabelRef.current.textContent = `${i + 1} / ${pb.beats.length}`
      if (timeLabelRef.current) timeLabelRef.current.textContent = `${formatTime(t)} / ${formatTime(pb.duration)}`
      if (latencyLabelRef.current) {
        const lag = (pb.clock.ctx.currentTime - pb.clock.startAt - t) * 1000
        latencyLabelRef.current.textContent = pb.clock.compensateLatency ? `${Math.max(0, lag).toFixed(0)} ms` : 'off'
      }
      if (timelineRef.current) drawTimeline(timelineRef.current, pb.beats, pb.duration, t)
    }
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(frame)
  }, [])

  const loadBuffer = async (ctx: AudioContext, source: AudioSource): Promise<AudioBuffer> => {
    const key = sourceKey(source)
    if (bufferRef.current?.key === key) return bufferRef.current.buffer
    const bytes = source.kind === 'server' ? await fetchSongAudio(source.file) : await source.file.arrayBuffer()
    const buffer = await ctx.decodeAudioData(bytes)
    // Keep only the latest decoded song: a few minutes of PCM is ~100 MB.
    bufferRef.current = { key, buffer }
    return buffer
  }

  const play = async (): Promise<void> => {
    const a = analysis
    if (!a) return
    stop()
    const token = ++tokenRef.current
    // Create/resume the AudioContext synchronously inside the click (autoplay policy).
    let ctx = ctxRef.current
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext({ latencyHint: 'interactive' })
      ctxRef.current = ctx
    }
    const resumed = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve()
    setError(null)
    setLoadingAudio(true)
    try {
      const buffer = await loadBuffer(ctx, a.source)
      await resumed
      if (token !== tokenRef.current) return // Stop/Play clicked meanwhile
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      const startAt = ctx.currentTime + START_DELAY_SEC
      source.start(startAt)
      const clicks = scheduleClicks(ctx, a.result.beats, startAt, { enabled: metronome })
      source.onended = () => {
        if (playbackRef.current?.source === source) stop()
      }
      playbackRef.current = {
        clock: { ctx, startAt, compensateLatency: compensate },
        source,
        clicks,
        beats: a.result.beats,
        duration: Math.max(buffer.duration, a.result.durationSec),
        lastT: Number.NEGATIVE_INFINITY,
      }
      setPlaying(true)
      startFrameLoop()
    } catch (err) {
      if (token === tokenRef.current && !isAbortError(err)) setError(`Playback: ${errorMessage(err)}`)
    } finally {
      if (token === tokenRef.current) setLoadingAudio(false)
    }
  }

  // Live toggles while playing.
  useEffect(() => {
    playbackRef.current?.clicks.setEnabled(metronome)
  }, [metronome])
  useEffect(() => {
    const pb = playbackRef.current
    if (pb) {
      pb.clock = { ...pb.clock, compensateLatency: compensate }
      pb.lastT = Number.NEGATIVE_INFINITY
    }
  }, [compensate])

  // Unmount: stop audio, close the context, cancel requests.
  useEffect(
    () => () => {
      requestRef.current?.abort()
      stop()
      void ctxRef.current?.close()
      ctxRef.current = null
    },
    [stop],
  )

  // Redraw the static timeline when the analysis or the canvas size changes.
  useEffect(() => {
    const canvas = timelineRef.current
    if (!canvas) return
    const redraw = (): void => {
      if (!playbackRef.current) drawTimeline(canvas, analysis?.result.beats ?? [], analysis?.result.durationSec ?? 0, null)
    }
    redraw()
    const ro = new ResizeObserver(redraw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [analysis])

  // --- analysis ----------------------------------------------------------------------
  const analyze = async (source: AudioSource): Promise<void> => {
    stop()
    requestRef.current?.abort()
    const ac = new AbortController()
    requestRef.current = ac
    setError(null)
    setBusy(source.kind === 'server' ? `Analyzing ${source.file}…` : `Uploading and analyzing ${source.file.name}…`)
    try {
      const result =
        source.kind === 'server' ? await beatsForSong(source.file, ac.signal) : await beatsForUpload(source.file, ac.signal)
      setAnalysis({ result, source })
    } catch (err) {
      if (!ac.signal.aborted && !isAbortError(err)) setError(errorMessage(err))
    } finally {
      if (requestRef.current === ac) {
        requestRef.current = null
        setBusy(null)
      }
    }
  }

  const onUpload = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same file again
    if (file) void analyze({ kind: 'upload', file })
  }

  const r = analysis?.result

  return (
    <section className="page beat-spike">
      <div className="toolbar">
        <label>
          Song
          <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={!songs?.length}>
            {!songs?.length && <option value="">{songs ? 'no songs in assets/songs/' : songsError ? 'unavailable' : 'loading…'}</option>}
            {songs?.map((s) => (
              <option key={s.file} value={s.file}>
                {s.title} ({formatBytes(s.sizeBytes)})
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          disabled={!selected || busy !== null}
          onClick={() => void analyze({ kind: 'server', file: selected })}
        >
          Analyze
        </button>
        <label className="file">
          Upload audio…
          <input type="file" accept="audio/*" onChange={onUpload} disabled={busy !== null} />
        </label>
        {busy && <span className="status">{busy}</span>}
      </div>

      {songsError && (
        <p className="error">
          {songsError}{' '}
          <button type="button" className="link" onClick={() => setSongsReload((n) => n + 1)}>
            Retry
          </button>
        </p>
      )}
      {error && <p className="error">{error}</p>}

      <div className="panel">
        <h2>{r ? r.song : 'No analysis yet'}</h2>
        <dl className="beat-stats">
          <dt>tempo</dt>
          <dd>{r ? `${r.tempo.toFixed(1)} BPM` : '–'}</dd>
          <dt>bpmFromBeats</dt>
          <dd>{r ? `${r.bpmFromBeats.toFixed(2)} BPM` : '–'}</dd>
          <dt>beats</dt>
          <dd>{r ? r.beats.length : '–'}</dd>
          <dt>duration</dt>
          <dd>{r ? formatTime(r.durationSec) : '–'}</dd>
          <dt>analysis</dt>
          <dd>{r ? `${r.elapsedMs.toFixed(0)} ms` : '–'}</dd>
          <dt>sample rate</dt>
          <dd>{r ? `${r.sampleRate} Hz` : '–'}</dd>
        </dl>

        <canvas ref={timelineRef} className="timeline" />

        <div className="transport">
          {playing || loadingAudio ? (
            <button type="button" onClick={stop}>
              {loadingAudio ? 'Loading audio… (stop)' : 'Stop'}
            </button>
          ) : (
            <button type="button" className="primary" disabled={!analysis || busy !== null} onClick={() => void play()}>
              Play
            </button>
          )}
          <label className="check">
            <input type="checkbox" checked={metronome} onChange={(e) => setMetronome(e.target.checked)} />
            Metronome click
          </label>
          <label className="check">
            <input type="checkbox" checked={compensate} onChange={(e) => setCompensate(e.target.checked)} />
            Compensate output latency
          </label>
        </div>

        <div className="beat-view">
          <div ref={circleRef} className="beat-circle" />
          <dl className="beat-live">
            <dt>beat</dt>
            <dd>
              <span ref={beatLabelRef}>–</span>
            </dd>
            <dt>time</dt>
            <dd>
              <span ref={timeLabelRef}>{formatTime(0)}</span>
            </dd>
            <dt>latency</dt>
            <dd>
              <span ref={latencyLabelRef}>–</span>
            </dd>
          </dl>
        </div>
      </div>
    </section>
  )
}
