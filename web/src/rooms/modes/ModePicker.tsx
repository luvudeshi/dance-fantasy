import { useId, useState } from 'react'
import { Icon } from '../../theme/Icon'
import type { RoomMode } from '../client'
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

/** The room's mode. The host picks (between songs); everyone else sees the choice. */
export function ModePicker({ mode, canPick, onPick }: { mode: RoomMode; canPick: boolean; onPick: (mode: RoomMode) => Promise<unknown> }) {
  const name = useId()
  const [busy, setBusy] = useState(false)
  const pick = (next: RoomMode): void => {
    if (!canPick || next === mode) return
    setBusy(true)
    void onPick(next).finally(() => setBusy(false))
  }
  return (
    <fieldset className="dfm-picker" disabled={!canPick || busy}>
      <legend className="df-label">{canPick ? 'Pick how you’ll dance' : 'The host picks how you’ll dance'}</legend>
      <div className="dfm-picker-options">
        {MODES.map((m) => {
          const on = mode === m.value
          return (
            <label key={m.value} className={`dfm-mode${on ? ' is-on' : ''}`} data-mode={m.value}>
              <input type="radio" className="df-sr-only" name={name} value={m.value} checked={on} onChange={() => pick(m.value)} />
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
    </fieldset>
  )
}
