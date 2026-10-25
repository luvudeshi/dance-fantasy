import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react'
import { ensureSession, getProfileName, leftRoom, recordRoomPlayed } from '../account/store'
import { ApiError } from '../api'
import { errorMessage } from '../lib/errors'
import { parseHash } from '../lib/hashRoute'
import { readJson, writeJson } from '../lib/storage'
import { Button, Corners, Title } from '../theme/components'
import { Icon } from '../theme/Icon'
import { createRoom, joinRoom, loadSeat, normalizeCode, saveSeat, type Seat } from './client'
import Lobby from './Lobby'
import './rooms.css'

// "#/room": open a ballroom (host). "#/room?code=XXXX" / "#/join?code=XXXX": the lobby, after a
// name when this tab has no seat in that room yet (the QR code points at #/join).

const NAME_KEY = 'dance-fantasy.name'

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

export default function RoomPage() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash)
  const { path, params } = parseHash(hash)
  const code = normalizeCode(params.get('code'))
  return <RoomScreen key={code ?? path} code={code} joining={path === '#/join'} />
}

function RoomScreen({ code, joining }: { code: string | null; joining: boolean }) {
  const [seat, setSeat] = useState<Seat | null>(() => (code ? loadSeat(code) : null))
  const [farewell, setFarewell] = useState<string | null>(null)
  const inLobby = code !== null && seat !== null
  // A hash change keeps the page's scroll (e.g. 60 px down to reach the entry form's button), which would
  // open the lobby with its title under the sticky bar: every room screen starts at the top.
  useLayoutEffect(() => {
    window.scrollTo(0, 0)
  }, [inLobby])
  if (code && seat) {
    return (
      <Lobby
        code={code}
        seat={seat}
        onGone={(why) => {
          saveSeat(code, null)
          leftRoom()
          setSeat(null)
          setFarewell(why === 'left' ? 'You left this ballroom. Join again?' : 'That ballroom has closed. Open a new one?')
        }}
      />
    )
  }
  return (
    <Entry
      code={code}
      joining={joining || code !== null}
      notice={farewell}
      onSeated={(c, s) => {
        saveSeat(c, s)
        void recordRoomPlayed(c, s.token) // friends see you in this room; partners after the round
        if (c === code) setSeat(s)
        else window.location.hash = `#/room?code=${c}`
      }}
    />
  )
}

function entryError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) return 'No ballroom has that code (or it has closed).'
  if (err instanceof ApiError && err.status === 409) return 'This ballroom is full: 8 dancers at most.'
  return errorMessage(err)
}

/** Name (+ code when joining without one) -> a seat. Phone-first: one column, big targets. */
function Entry({ code, joining, notice, onSeated }: { code: string | null; joining: boolean; notice: string | null; onSeated: (code: string, seat: Seat) => void }) {
  const [name, setName] = useState(() => {
    const saved = readJson(NAME_KEY)
    return typeof saved === 'string' ? saved : (getProfileName() ?? '')
  })
  // First visit: the profile name once the guest session has loaded (unless already typed).
  useEffect(() => {
    let live = true
    void ensureSession().then((me) => {
      if (live && me) setName((n) => n || me.name)
    })
    return () => {
      live = false
    }
  }, [])
  // A prefilled name is selected while the field has focus, so typing replaces it instead of appending.
  const nameField = useRef<HTMLInputElement>(null)
  const typed = useRef(false)
  useLayoutEffect(() => {
    const field = nameField.current
    if (!typed.current && field && document.activeElement === field) field.select()
  }, [name])
  const [typedCode, setTypedCode] = useState(code ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const target = joining ? normalizeCode(typedCode) : null
  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && (!joining || target !== null) && !busy

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    writeJson(NAME_KEY, trimmed)
    try {
      if (target) onSeated(target, await joinRoom(target, trimmed))
      else {
        const { code: created, ...seat } = await createRoom(trimmed)
        onSeated(created, seat)
      }
    } catch (err) {
      setError(entryError(err))
      setBusy(false)
    }
  }

  return (
    <div className="df-screen rm-screen">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="df-container rm-entry">
        <form className="df-card df-stack rm-entry-card" style={{ '--df-gap': '20px' } as CSSProperties} onSubmit={(e) => void submit(e)}>
          <Icon name={joining ? 'slipper' : 'castle'} size="lg" className="rm-entry-icon df-bob" />
          <Title variant="cut" kicker={joining ? 'Join the' : 'Open a'} className="rm-entry-title">
            {joining ? 'Ball' : 'Ballroom'}
          </Title>
          <p className="df-lede">
            {joining
              ? 'Your phone is your magic mirror: dance along with everyone in the room.'
              : 'Friends scan the code with their phones, the host picks a song, and everyone dances at the same moment.'}
          </p>
          {notice && <p className="df-notice">{notice}</p>}
          {joining && code ? (
            <p className="df-code-chip rm-entry-code">
              <small>Ballroom</small>
              <span className="df-foil">{code}</span>
            </p>
          ) : joining && (
            <label className="df-stack rm-field" style={{ '--df-gap': '6px' } as CSSProperties}>
              <span className="df-label">Room code</span>
              <input
                className="df-field rm-code-input"
                value={typedCode}
                onChange={(e) => setTypedCode(e.target.value.toUpperCase())}
                maxLength={4}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="KQWX"
                aria-invalid={typedCode.length === 4 && target === null ? true : undefined}
              />
            </label>
          )}
          <label className="df-stack rm-field" style={{ '--df-gap': '6px' } as CSSProperties}>
            <span className="df-label">Your dancer name</span>
            <input
              ref={nameField}
              className="df-field"
              value={name}
              onChange={(e) => {
                typed.current = true
                setName(e.target.value)
              }}
              onFocus={(e) => e.currentTarget.select()}
              maxLength={24}
              autoComplete="nickname"
              placeholder="e.g. Cinderella"
              autoFocus={!joining || code !== null}
            />
          </label>
          {error && <p className="df-error">{error}</p>}
          <Button type="submit" size="lg" block icon={joining ? 'sparkles' : 'key'} disabled={!canSubmit}>
            {busy ? 'Opening the doors…' : joining ? 'Join the dance' : 'Open the ballroom'}
          </Button>
          <a className="df-btn df-btn-ghost rm-entry-switch" href={joining ? '#/room' : '#/join'}>
            {joining ? 'Host a new room instead' : 'Have a code? Join a room'}
          </a>
        </form>
      </div>
    </div>
  )
}
