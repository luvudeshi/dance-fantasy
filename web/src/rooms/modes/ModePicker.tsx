import { useId, useState } from 'react'
import { errorMessage } from '../../lib/errors'
import { Notice } from '../../theme/components'
import { Icon } from '../../theme/Icon'
import { setRoomMode, type ModeRoom, type RoomMode } from './api'
import './modes.css'

const MODES = [
  {
    value: 'versus',
    icon: 'trophy',
    title: 'Versus',
    tagline: 'Who dances best?',
    blurb: 'Every beat goes to whoever nails it best. Win the most beats to wear the crown.',
  },
  {
    value: 'crew',
    icon: 'party',
    title: 'Crew',
    tagline: 'Dance as one',
    blurb: 'One team score. When everyone hits a beat together, the sync bonus grows with every beat in a row.',
  },
] as const

/** The room's mode: the host picks (lobby or results), everyone else sees the choice. */
export function ModePicker({
  room,
  meId,
  token,
  onRoom,
}: {
  room: ModeRoom
  meId: string | null
  token: string | null
  onRoom: (room: ModeRoom) => void
}) {
  const name = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isHost = token !== null && meId === room.hostId
  const editable = isHost && (room.state === 'lobby' || room.state === 'finished')

  const pick = async (mode: RoomMode): Promise<void> => {
    if (!editable || token === null || mode === room.mode) return
    setBusy(true)
    setError(null)
    try {
      onRoom(await setRoomMode(room.code, token, mode))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset className="dfm-picker" disabled={!editable || busy}>
      <legend className="df-label">{isHost ? 'Pick tonight’s dance' : 'The host picks tonight’s dance'}</legend>
      <div className="dfm-picker-options">
        {MODES.map((m) => {
          const on = room.mode === m.value
          return (
            <label key={m.value} className={`dfm-mode${on ? ' is-on' : ''}`}>
              <input
                type="radio"
                className="df-sr-only"
                name={name}
                value={m.value}
                checked={on}
                onChange={() => void pick(m.value)}
              />
              <Icon name={m.icon} size={64} className="dfm-mode-icon" />
              <span className="dfm-mode-text">
                <span className="dfm-mode-title">
                  {m.title}
                  {on && <span className="df-badge df-badge-rasp">Chosen</span>}
                </span>
                <span className="df-voice">{m.tagline}</span>
                <span className="df-note">{m.blurb}</span>
              </span>
            </label>
          )
        })}
      </div>
      <Notice inline tone="error" message={error} />
    </fieldset>
  )
}
