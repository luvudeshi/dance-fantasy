import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react'
import { leftRoom } from '../account/store'
import { ApiError } from '../api'
import { errorMessage } from '../lib/errors'
import { Badge, Button, Corners, Modal, Notice, Panel, Sparkle, Toggle, Token } from '../theme/components'
import { Icon } from '../theme/Icon'
import { avatarFor, joinUrl, leaveRoom, roomWrites, saveSeat, type RoomPlayer, type RoomRoutine, type RoomState, type RoomView, type Seat } from './client'
import { beginRoomRound, storedRound } from './gameLink'
import Qr from './Qr'
import RoutinePicker from './RoutinePicker'
import { ModePicker } from './modes/ModePicker'
import { ModeResults } from './modes/ModeResults'
import { Countdown, LiveBoard } from './Standings'
import { useRoom } from './useRoom'
import './lobby-wide.css'

const STATE_LABEL: Readonly<Record<RoomState, string>> = {
  lobby: 'Gathering',
  countdown: 'Starting',
  playing: 'Dancing',
  finished: 'Curtain call',
}

const TOAST_MS = 3200

/** Laptop / projector: Body Double's host lobby (code mirror left, title + QR card + name tags right). */
const WIDE = '(min-width: 1024px)'
const subscribeWide = (onChange: () => void): (() => void) => {
  const mq = window.matchMedia(WIDE)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
const isWide = (): boolean => window.matchMedia(WIDE).matches

/** The room code in gold foil, inside the night glass of a tall magic mirror (Body Double's CodeMirror). */
function CodeMirror({ code }: { code: string }) {
  return (
    <div className="rm-mirror">
      <div className="rm-mirror-glass">
        <span className="rm-glare rm-glare-1" />
        <span className="rm-glare rm-glare-2" />
        <Sparkle className="rm-glint rm-glint-1 df-twinkle" />
        <Sparkle className="rm-glint rm-glint-2 df-twinkle" />
        <p className="df-voice rm-mirror-voice">Mirror, mirror, the code is</p>
        <p className="rm-mirror-code" aria-label={`Room code ${code.split('').join(' ')}`}>
          <span className="df-foil">{code}</span>
        </p>
        <img src="/art/storybook/flourish.svg" alt="" className="rm-mirror-flourish" />
        <p className="rm-mirror-note">Type it on your phone</p>
      </div>
      <img src="/art/storybook/mirror-tall.svg" alt="" className="rm-mirror-frame" />
    </div>
  )
}

/** The join QR on a tilted paper calling card, pinned with a sparkle. */
function CallingCard({ url, code }: { url: string; code: string }) {
  return (
    <div className="rm-calling">
      <div className="df-card rm-calling-card">
        <Qr text={url} label={`QR code to join room ${code}`} />
        <p className="rm-calling-note">Scan to enter</p>
      </div>
      <Icon name="sparkles" size="sm" cut="none" className="rm-calling-pin" />
    </div>
  )
}

/** Dancers as name-tag stickers under their token. */
function NameTags({ players, meId }: { players: readonly RoomPlayer[]; meId: string }) {
  return (
    <ul className="rm-tags" aria-label="Dancers">
      {players.map((p) => (
        <li key={p.id} data-player={p.name} className={p.connected ? undefined : 'is-away'}>
          <figure>
            <Token icon={avatarFor(players, p.id)} tick={p.ready} picked={p.id === meId} />
            <figcaption className="df-tag">
              <span className="df-tag-name">
                {p.name}
                {p.id === meId && <span className="rm-tag-you"> (you)</span>}
              </span>
              <span className="df-tag-role">{p.ready ? 'ready!' : !p.connected ? 'away' : p.isHost ? 'the host' : 'getting ready'}</span>
            </figcaption>
          </figure>
        </li>
      ))}
    </ul>
  )
}

export default function Lobby({ code, seat, onGone }: { code: string; seat: Seat; onGone: (why: 'left' | 'missing') => void }) {
  const { room, chat, offsetMs, error, gone, act } = useRoom(code, seat.token)
  const [toast, setToast] = useState<string | null>(null)
  const [dancing, setDancing] = useState(true)
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)
  const wide = useSyncExternalStore(subscribeWide, isWide)
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
    leftRoom()
    window.location.hash = '#/room'
  }

  const songTitle = room.routine ? room.routine.title : isHost ? 'Pick a song' : 'No song yet'
  const shownUrl = url.replace(/^https?:\/\//, '')
  const songBadges = room.routine && (
    <div className="df-cluster" style={{ '--df-gap': '8px' } as CSSProperties}>
      <Badge tone="gold">{room.routine.difficulty}</Badge>
      <Badge tone="blue">{room.routine.mode}</Badge>
    </div>
  )
  const dancingToggle = isHost && (
    <Toggle checked={dancing} onChange={setDancing} label="I’m dancing too" hint={dancing ? undefined : 'This screen shows the live board'} />
  )
  const buttons = (
    <>
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
    </>
  )
  const onAir = room.state === 'playing' && !goesIn && <p className="df-lede">The dance is on. Scores update live.</p>
  const statusCluster = (
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
  )
  const finalPanel = room.state === 'finished' && (
    <ModeResults
      room={room}
      meId={seat.playerId}
      onRematch={isHost ? () => attempt((after) => roomWrites.rematch(code, seat.token, after)) : undefined}
    />
  )
  const modePanel = (
    <Panel title={room.mode === 'crew' ? 'Crew: dance as one' : 'Versus: who dances best?'} kicker="Tonight’s dance" sticker="dance-shoe" className="rm-mode">
      <ModePicker mode={room.mode} canPick={isHost && between} onPick={(mode) => attempt((after) => roomWrites.mode(code, seat.token, mode, after))} />
    </Panel>
  )
  const livePanel = room.state === 'playing' && (
    <Panel title="The ball is on" kicker="Live" sticker="crown" className="rm-live">
      <LiveBoard players={room.players} meId={seat.playerId} />
    </Panel>
  )
  const chatPanel = (
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
  )
  const overlays = (
    <>
      {showCountdown && startLocal !== null && room.routine && <Countdown target={startLocal} title={room.routine.title} onGo={go} />}
      <Notice message={toast} tone="error" />
    </>
  )

  if (wide) {
    return (
      <div className="df-screen rm-screen rm-wide">
        <Corners />
        <div className="df-twinkles" aria-hidden="true" />
        <div className="df-container df-stack rm-page" style={{ '--df-gap': '16px' } as CSSProperties}>
          {finalPanel}
          <div className="rm-wide-grid">
            <div className="df-stack rm-wide-side" style={{ '--df-gap': '20px' } as CSSProperties}>
              <header className="rm-wide-bar">{statusCluster}</header>
              <CodeMirror code={code} />
              {chatPanel}
            </div>
            <div className="rm-wide-main">
              <div className="rm-wide-head">
                <hgroup className="rm-wide-titles">
                  <p className="df-voice df-kicker">The</p>
                  <h1 className="df-cut-letters rm-wide-title">Ballroom</h1>
                  <p className="rm-wide-enter">
                    Enter at <b>{shownUrl}</b> or scan the card with your phone.
                  </p>
                </hgroup>
                <CallingCard url={url} code={code} />
              </div>
              {livePanel || (
                <section aria-labelledby="rm-hall">
                  <h2 id="rm-hall" className="df-voice rm-hall">
                    Dancers in the ballroom
                    <span className="rm-hall-count" aria-live="polite">
                      {room.players.length === 1 ? '1 has arrived' : `${room.players.length} have arrived`} · {readyCount} ready
                    </span>
                  </h2>
                  <NameTags players={room.players} meId={seat.playerId} />
                </section>
              )}
              {between && modePanel}
              <div className="rm-wide-foot">
                <div className="df-scroll rm-song-scroll">
                  <p className="df-voice">Tonight’s song</p>
                  <p className="rm-song-title">{songTitle}</p>
                  <div className="df-cluster" style={{ '--df-gap': '10px' } as CSSProperties}>
                    {songBadges}
                    {!room.routine && !isHost && <p className="df-note">The host is choosing a song…</p>}
                    {isHost && between && (
                      <Button variant="secondary" size="sm" icon="music-note" onClick={() => setPicking(true)}>
                        {room.routine ? 'Change song' : 'Choose the song'}
                      </Button>
                    )}
                  </div>
                  {dancingToggle}
                  <Icon name="clock-tower" size="sm" className="rm-song-tower" />
                </div>
                <div className="rm-wide-go">
                  {between && <p className="df-voice rm-go-line">When the ballroom is ready,</p>}
                  <div className="df-cluster rm-go-row" style={{ '--df-gap': '12px' } as CSSProperties}>
                    {buttons}
                  </div>
                  {onAir}
                </div>
              </div>
            </div>
          </div>
        </div>
        {isHost && (
          <Modal open={picking && between} onClose={() => setPicking(false)} title="Tonight’s song">
            <RoutinePicker
              current={room.routine}
              onPick={async (r) => {
                await pick(r)
                setPicking(false)
              }}
              disabled={false}
            />
          </Modal>
        )}
        {overlays}
      </div>
    )
  }

  return (
    <div className="df-screen rm-screen">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="df-container df-stack rm-page" style={{ '--df-gap': '24px' } as CSSProperties}>
        <header className="df-topbar">
          <h1 className="df-title">The Ballroom</h1>
          {statusCluster}
        </header>

        {finalPanel}

        <div className="rm-grid">
          <div className="rm-col">
            <Panel title="Invite dancers" kicker="Scan with a phone" sticker="mirror" className="rm-invite">
              <div className="rm-invite-body">
                <div className="df-mirror rm-qr-frame">
                  <Qr text={url} label={`QR code to join room ${code}`} />
                </div>
                <div className="df-stack" style={{ '--df-gap': '8px' } as CSSProperties}>
                  <p className="df-label">or open</p>
                  <p className="rm-url df-num">{shownUrl}</p>
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
              {dancingToggle}
            </Panel>
          </div>

          <div className="rm-col">
            {modePanel}

            <Panel title={songTitle} kicker="Tonight’s song" sticker="music-note" className="rm-song">
              {songBadges}
              {!room.routine && !isHost && <p className="df-lede">The host is choosing a song…</p>}
              {isHost && between && <RoutinePicker current={room.routine} onPick={pick} disabled={false} />}
            </Panel>

            {livePanel}

            {chatPanel}
          </div>
        </div>

        <div className={`df-dock rm-dock${room.state === 'finished' ? ' rm-dock-static' : ''}`}>
          <div className="df-cluster rm-dock-row" style={{ '--df-gap': '12px' } as CSSProperties}>
            {buttons}
            {onAir}
          </div>
        </div>
      </div>
      {overlays}
    </div>
  )
}
