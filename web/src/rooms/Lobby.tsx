import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { ApiError } from '../api'
import { errorMessage } from '../lib/errors'
import { Badge, Button, Corners, Notice, Panel, Toggle } from '../theme/components'
import { Icon } from '../theme/Icon'
import { avatarFor, joinUrl, leaveRoom, roomWrites, saveSeat, type RoomRoutine, type RoomState, type RoomView, type Seat } from './client'
import { beginRoomRound, storedRound } from './gameLink'
import Qr from './Qr'
import RoutinePicker from './RoutinePicker'
import { ModePicker } from './modes/ModePicker'
import { ModeResults } from './modes/ModeResults'
import { Countdown, LiveBoard } from './Standings'
import { useRoom } from './useRoom'

const STATE_LABEL: Readonly<Record<RoomState, string>> = {
  lobby: 'Gathering',
  countdown: 'Starting',
  playing: 'Dancing',
  finished: 'Curtain call',
}

const TOAST_MS = 3200

export default function Lobby({ code, seat, onGone }: { code: string; seat: Seat; onGone: (why: 'left' | 'missing') => void }) {
  const { room, chat, offsetMs, error, gone, act } = useRoom(code, seat.token)
  const [toast, setToast] = useState<string | null>(null)
  const [dancing, setDancing] = useState(true)
  const [draft, setDraft] = useState('')
  const chatList = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (gone) onGone(gone)
  }, [gone, onGone])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(id)
  }, [toast])
  // newest message in view (scrolls the list only, never the page)
  useEffect(() => {
    const list = chatList.current
    if (list) list.scrollTop = list.scrollHeight
  }, [chat.length])

  /** A write whose failure becomes a toast; resolves whether it went through. */
  const attempt = (write: (chatAfter: number | undefined) => Promise<RoomView>): Promise<boolean> =>
    act(write).then(
      () => true,
      (err: unknown) => {
        setToast(err instanceof ApiError && err.status === 429 ? 'Slow down: 5 messages per 10 seconds.' : errorMessage(err))
        return false
      },
    )

  if (!room) {
    return (
      <div className="df-screen rm-screen">
        <div className="df-pause">
          <Icon name="castle" size="lg" className="df-bob" />
          <p className="df-lede">{error ?? 'Opening the ballroom doors…'}</p>
        </div>
      </div>
    )
  }

  const me = room.players.find((p) => p.id === seat.playerId)
  const isHost = room.hostId === seat.playerId
  const between = room.state === 'lobby' || room.state === 'finished'
  const readyCount = room.players.filter((p) => p.ready).length
  const startLocal = room.startAt !== null ? room.startAt - offsetMs : null
  const begun = storedRound()?.serverStartAt === room.startAt
  const goesIn = dancing && me !== undefined && !me.finished && !begun
  const showCountdown =
    room.routine !== null && startLocal !== null && (room.state === 'countdown' || (room.state === 'playing' && goesIn))
  const url = joinUrl(code)

  const go = (): void => {
    if (!goesIn || !room.routine || room.startAt === null || startLocal === null) return
    beginRoomRound({ code, routineId: room.routine.routineId, serverStartAt: room.startAt, startAt: startLocal })
  }
  const pick = async (r: RoomRoutine): Promise<void> => {
    await act((after) => roomWrites.routine(code, seat.token, r, after))
  }
  const sendChat = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    if (await attempt((after) => roomWrites.chat(code, seat.token, text, after))) setDraft('')
  }
  const leave = async (): Promise<void> => {
    try {
      await leaveRoom(code, seat.token)
    } catch (err) {
      console.warn('leave failed; forgetting the seat anyway', err)
    }
    saveSeat(code, null)
    window.location.hash = '#/room'
  }

  return (
    <div className="df-screen rm-screen">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="df-container df-stack rm-page" style={{ '--df-gap': '24px' } as CSSProperties}>
        <header className="df-topbar">
          <span className="df-brand">
            Dance <b>Fantasy</b>
          </span>
          <div className="df-cluster" style={{ '--df-gap': '10px' } as CSSProperties}>
            <Badge tone={room.state === 'playing' ? 'rasp' : room.state === 'finished' ? 'gold' : 'sage'}>{STATE_LABEL[room.state]}</Badge>
            <span className="df-code-chip" data-room-code={code}>
              <small>Ballroom</small>
              <span className="df-foil">{code}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => void leave()}>
              Leave
            </Button>
          </div>
        </header>

        {room.state === 'finished' && (
          <ModeResults
            room={room}
            meId={seat.playerId}
            onRematch={isHost ? () => attempt((after) => roomWrites.rematch(code, seat.token, after)) : undefined}
          />
        )}

        <div className="rm-grid">
          <div className="rm-col">
            <Panel title="Invite dancers" kicker="Scan with a phone" sticker="mirror" className="rm-invite">
              <div className="rm-invite-body">
                <div className="df-mirror rm-qr-frame">
                  <Qr text={url} label={`QR code to join room ${code}`} />
                </div>
                <div className="df-stack" style={{ '--df-gap': '8px' } as CSSProperties}>
                  <p className="df-label">or open</p>
                  <p className="rm-url df-num">{url.replace(/^https?:\/\//, '')}</p>
                  <p className="df-label">and enter</p>
                  <p className="rm-big-code df-num">{code}</p>
                </div>
              </div>
            </Panel>

            <Panel title={`Dancers ${room.players.length}/8`} kicker={`${readyCount} ready`} sticker="party" className="rm-dancers">
              <ul className="df-list" aria-label="Dancers">
                {room.players.map((p) => (
                  <li key={p.id} className={`df-item${p.id === seat.playerId ? ' is-on' : ''}`} data-player={p.name}>
                    <Icon name={avatarFor(room.players, p.id)} size="sm" cut="sm" className={`df-item-icon${p.connected ? '' : ' rm-away'}`} />
                    <span className="df-item-body">
                      <span className="df-item-title">
                        {p.name}
                        {p.id === seat.playerId && <span className="df-note"> (you)</span>}
                      </span>
                      <span className="df-item-meta">{p.isHost ? 'Host' : p.connected ? 'Here' : 'Away'}</span>
                    </span>
                    <span className="df-item-end">
                      {p.ready ? <Badge tone="sage">Ready</Badge> : <Badge>Not yet</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <div className="rm-col">
            <Panel title={room.mode === 'crew' ? 'Crew: dance as one' : 'Versus: who dances best?'} kicker="Tonight’s dance" sticker={room.mode === 'crew' ? 'party' : 'trophy'} className="rm-mode">
              <ModePicker
                mode={room.mode}
                canPick={isHost && between}
                onPick={(mode) => attempt((after) => roomWrites.mode(code, seat.token, mode, after))}
              />
            </Panel>

            <Panel title={room.routine ? room.routine.title : 'Tonight’s song'} kicker="Tonight’s song" sticker="music-note" className="rm-song">
              {room.routine ? (
                <div className="df-cluster" style={{ '--df-gap': '8px' } as CSSProperties}>
                  <Badge tone="gold">{room.routine.difficulty}</Badge>
                  <Badge tone="blue">{room.routine.mode}</Badge>
                </div>
              ) : (
                !isHost && <p className="df-lede">The host is choosing a song…</p>
              )}
              {isHost && between && <RoutinePicker current={room.routine} onPick={pick} disabled={false} />}
            </Panel>

            {room.state === 'playing' && (
              <Panel title="The ball is on" kicker="Live" sticker="crown" className="rm-live">
                <LiveBoard players={room.players} meId={seat.playerId} />
              </Panel>
            )}

            <Panel title="Chat" sticker="chat" className="rm-chat">
              <ul ref={chatList} className="rm-chat-list" aria-label="Messages" aria-live="polite">
                {chat.length === 0 && <li className="df-note">No messages yet. Say hello!</li>}
                {chat.map((m) => (
                  <li key={m.id} className={m.playerId === seat.playerId ? 'is-me' : undefined}>
                    <span className="rm-chat-name">{m.name}</span> <span>{m.text}</span>
                  </li>
                ))}
              </ul>
              <form className="rm-chat-form" onSubmit={(e) => void sendChat(e)}>
                <input
                  className="df-field"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={200}
                  placeholder="Say something nice…"
                  aria-label="Message"
                />
                <Button type="submit" variant="secondary" disabled={!draft.trim()}>
                  Send
                </Button>
              </form>
            </Panel>
          </div>
        </div>

        <div className={`df-dock rm-dock${room.state === 'finished' ? ' rm-dock-static' : ''}`}>
          <div className="df-cluster rm-dock-row" style={{ '--df-gap': '12px' } as CSSProperties}>
            {me && between && (
              <Button
                variant={me.ready ? 'secondary' : 'primary'}
                size="lg"
                icon="slipper"
                aria-pressed={me.ready}
                onClick={() => void attempt((after) => roomWrites.ready(code, seat.token, !me.ready, after))}
              >
                {me.ready ? 'Ready!' : 'I’m ready'}
              </Button>
            )}
            {isHost && room.state === 'lobby' && (
              <Button
                size="lg"
                icon="sparkles"
                disabled={!room.routine}
                title={room.routine ? undefined : 'Pick a song first'}
                onClick={() => void attempt((after) => roomWrites.start(code, seat.token, after))}
              >
                Start the dance
              </Button>
            )}
            {isHost && <Toggle checked={dancing} onChange={setDancing} label="I’m dancing too" hint={dancing ? undefined : 'This screen shows the live board'} />}
            {room.state === 'playing' && !goesIn && <p className="df-lede">The dance is on. Scores update live.</p>}
          </div>
        </div>
      </div>
      {showCountdown && startLocal !== null && room.routine && <Countdown target={startLocal} title={room.routine.title} onGo={go} />}
      <Notice message={toast} tone="error" />
    </div>
  )
}
