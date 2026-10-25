// The herald's speech bubble (one line at a time, popping in like a slapped-on sticker) and its two
// switches. The game owns one Announcer (useAnnouncer) and mounts <HeraldBubble> over the stage.

import { useSyncExternalStore } from 'react'
import { Toggle } from '../theme/components'
import { Icon } from '../theme/Icon'
import type { IconName } from '../theme/icons'
import { stopSpeaking, type Announcer, type AnnouncerEvent } from './announcer'
import { setAnnouncerPrefs, useAnnouncerPrefs } from './prefs'
import './herald.css'

/** Icons that read on the crest's gold (blue for a broken streak); no gold-on-gold sparkles. */
const CREST: Record<AnnouncerEvent, IconName> = {
  intro: 'crown',
  combo: 'dance-shoe',
  streak_broken: 'slipper',
  cheer: 'music-note',
  perfect_run: 'crown',
  results: 'crown',
}

/**
 * The current line as a speech bubble. `placement="stage"` (default) pins it bottom-left over the game
 * (clear of the score panel and webcam PIP on the right); "inline" leaves it in the flow.
 */
export function HeraldBubble({ announcer, placement = 'stage' }: { announcer: Announcer; placement?: 'stage' | 'inline' }) {
  const herald = useSyncExternalStore(announcer.subscribe, announcer.getSnapshot)
  return (
    <div className={`df-herald df-herald-${placement}`} role="status" aria-live="polite">
      {herald && (
        <p key={herald.key} className={`df-herald-bubble df-herald-${herald.event}`}>
          <span className="df-herald-crest" aria-hidden="true">
            <Icon name={CREST[herald.event]} size={44} cut="none" />
          </span>
          <span className="df-herald-text">
            <span className="df-herald-who">The Herald</span>
            <span className="df-herald-line">{herald.line}</span>
          </span>
        </p>
      )}
    </div>
  )
}

/** "Announcer" and "Herald's voice" switches (move into the Settings screen with prefs.ts). */
export function AnnouncerToggles() {
  const prefs = useAnnouncerPrefs()
  return (
    <div className="df-stack" style={{ gap: 12 }}>
      <Toggle
        checked={prefs.enabled}
        onChange={(enabled) => {
          if (!enabled) stopSpeaking()
          setAnnouncerPrefs({ enabled })
        }}
        label="Royal herald"
        hint="Calls out the intro, your combos and the final score"
      />
      <Toggle
        checked={prefs.voice}
        disabled={!prefs.enabled}
        onChange={(voice) => {
          if (!voice) stopSpeaking()
          setAnnouncerPrefs({ voice })
        }}
        label="Herald's voice"
        hint="Reads the lines aloud"
      />
    </div>
  )
}
