// Dev page for the room modes (web/modes-lab.html, dev server only): create or join a room, pick the mode,
// start, and see the HUD and results over a real server. The game isn't here: judgements come from
// window.dfLab (used by the Playwright check), or the "Dance a beat" buttons.
// ponytail: delete once the modes are mounted in the real rooms UI.

import { StrictMode, useEffect, useRef, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { errorMessage } from '../../lib/errors'
import { Button, Corners, Notice, Panel } from '../../theme/components'
import { StickerDefs } from '../../theme/StickerDefs'
import { isModeRoom, roomRequest, type Grade, type ModeRoom } from './api'
import { BeatReporter } from './beatReporter'
import { ModeHud } from './ModeHud'
import { ModePicker } from './ModePicker'
import { ModeResults } from './ModeResults'
import '../../theme/tokens.css'
import '../../theme/base.css'
import '../../theme/sticker.css'
import '../../theme/controls.css'
import '../../theme/pieces.css'

interface Seat {
  code: string
  playerId: string
  token: string
}

const SEAT_KEY = 'dfm-lab-seat'
const LAB_ROUTINE = {
  routineId: '0123456789abcdef',
  analysisId: 'ab'.repeat(32),
  title: 'Lab song',
  difficulty: 'normal',
  mode: 'standing',
} as const

const isSeat = (v: unknown): v is Seat =>
  typeof v === 'object' && v !== null && 'code' in v && 'playerId' in v && 'token' in v && typeof v.token === 'string'

function loadSeat(): Seat | null {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(SEAT_KEY) ?? 'null')
    return isSeat(v) ? v : null
  } catch (err) {
    console.warn('[lab] stored seat unreadable', err)
    return null
  }
}

declare global {
  interface Window {
    dfLab?: {
      reportBeat: (beat: number, score: number, grade: Grade) => void
      flush: () => Promise<void>
      score: (score: number, accuracy: number, progress: number, finished: boolean) => Promise<void>
    }
  }
}

export function Lab() {
  const [seat, setSeat] = useState<Seat | null>(loadSeat)
  const [room, setRoom] = useState<ModeRoom | null>(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const reporter = useRef<BeatReporter | null>(null)
  const nextBeat = useRef(0)

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const sit = (s: Seat): void => {
    sessionStorage.setItem(SEAT_KEY, JSON.stringify(s))
    setSeat(s)
  }

  // poll about once a second
  useEffect(() => {
    if (!seat) return
    const ctl = new AbortController()
    const poll = (): void => {
      roomRequest(`/api/rooms/${seat.code}`, isModeRoom, { token: seat.token, signal: ctl.signal }).then(setRoom, (err: unknown) => {
        if (!ctl.signal.aborted) setError(errorMessage(err))
      })
    }
    poll()
    const t = window.setInterval(poll, 1000)
    return () => {
      ctl.abort()
      window.clearInterval(t)
    }
  }, [seat])

  // one reporter per round, posting while the song plays
  const playing = room?.state === 'playing' || room?.state === 'countdown'
  useEffect(() => {
    if (!seat || !playing) return
    const r = BeatReporter.forRoom(seat.code, seat.token, setRoom)
    r.start()
    reporter.current = r
    nextBeat.current = 0
    return () => {
      void r.stop()
      reporter.current = null
    }
  }, [seat, playing])

  useEffect(() => {
    if (!seat) return
    window.dfLab = {
      reportBeat: (beat, score, grade) => reporter.current?.reportBeat(beat, score, grade),
      flush: () => reporter.current?.flush() ?? Promise.resolve(),
      score: async (score, accuracy, progress, finished) => {
        if (finished) await reporter.current?.stop() // the last beats go before the final score
        setRoom(
          await roomRequest(`/api/rooms/${seat.code}/score`, isModeRoom, {
            token: seat.token,
            body: { score, combo: 0, maxCombo: 0, accuracy, progress, finished },
          }),
        )
      },
    }
  }, [seat])

  const post = (path: string, body?: unknown) => async (): Promise<void> => {
    if (!seat) return
    setRoom(await roomRequest(`/api/rooms/${seat.code}/${path}`, isModeRoom, { token: seat.token, body, method: 'POST' }))
  }

  const isJoined = (v: unknown): v is { playerId: string; token: string; code?: string } =>
    typeof v === 'object' && v !== null && 'playerId' in v && 'token' in v

  if (!seat || !room) {
    return (
      <Panel title="Room modes lab" kicker="dev page" sticker="party" style={{ maxWidth: 480, margin: '40px auto' }}>
        <input className="df-field" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" />
        <Button
          icon="sparkles"
          onClick={() =>
            void act(async () => {
              const r = await roomRequest('/api/rooms', isJoined, { body: { name } })
              if (r.code) sit({ code: r.code, playerId: r.playerId, token: r.token })
            })
          }
        >
          Open a ballroom
        </Button>
        <input className="df-field" placeholder="Room code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Room code" />
        <Button
          variant="secondary"
          onClick={() =>
            void act(async () => {
              const c = code.trim().toUpperCase()
              const r = await roomRequest(`/api/rooms/${encodeURIComponent(c)}/join`, isJoined, { body: { name } })
              sit({ code: c, playerId: r.playerId, token: r.token })
            })
          }
        >
          Join
        </Button>
        <Notice inline tone="error" message={error} />
      </Panel>
    )
  }

  const isHost = room.hostId === seat.playerId
  const dance = (grade: Grade, score: number) => () => reporter.current?.reportBeat(nextBeat.current++, score, grade)

  return (
    <div className="df-stack" style={{ '--df-gap': '24px' } as CSSProperties}>
      <header className="df-topbar">
        <span className="df-brand">
          Dance <b>Fantasy</b>
        </span>
        <span className="df-code-chip" aria-label={`Ballroom ${room.code}`}>
          <small aria-hidden="true">Ballroom</small>
          <span className="df-foil" aria-hidden="true" data-code={room.code}>
            {room.code}
          </span>
        </span>
        <span className="df-badge df-badge-gold" data-state={room.state}>
          {room.state}
        </span>
      </header>
      <Notice inline tone="error" message={error} />

      {room.state === 'lobby' && (
        <Panel title="The ballroom" kicker={`${room.players.length} dancers`}>
          <ModePicker room={room} meId={seat.playerId} token={seat.token} onRoom={setRoom} />
          {isHost && (
            <div className="df-cluster">
              <Button variant="secondary" onClick={() => void act(post('routine', LAB_ROUTINE))}>
                Pick the lab song
              </Button>
              <Button icon="play" disabled={!room.routine} onClick={() => void act(post('start'))}>
                Start
              </Button>
            </div>
          )}
        </Panel>
      )}

      {playing && (
        <>
          <div className="df-mirror df-st-live">
            <div className="df-mirror-glass df-mirror-night" style={{ minHeight: 'min(70vh, 640px)' }}>
              <p className="df-voice" style={{ color: 'var(--df-on-night)', fontSize: '1.6rem' }}>
                {room.state === 'countdown' ? 'Get ready…' : 'The coach dances here'}
              </p>
              <ModeHud room={room} meId={seat.playerId} />
            </div>
          </div>
          <div className="df-cluster">
            <Button size="sm" variant="secondary" onClick={dance('perfect', 96)}>
              Dance a perfect beat
            </Button>
            <Button size="sm" variant="secondary" onClick={dance('miss', 10)}>
              Miss a beat
            </Button>
          </div>
        </>
      )}

      {room.state === 'finished' && (
        <>
          <ModeResults room={room} meId={seat.playerId} token={seat.token} onRoom={setRoom} totalBeats={24} />
          <Panel title="Next song" kicker="host only">
            <ModePicker room={room} meId={seat.playerId} token={seat.token} onRoom={setRoom} />
          </Panel>
        </>
      )}
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <StickerDefs />
    <div className="df-screen">
      <Corners />
      <main className="df-container" style={{ paddingBlock: 24 }}>
        <Lab />
      </main>
    </div>
  </StrictMode>,
)
