// In-game pause menu over the stage (Play.tsx renders it while paused). Pure view: every action
// is the page's own (togglePause, restart, endRehearsal, exitToLobby); Settings and Main menu are
// plain hash links (leaving #/play unmounts the page, which releases the camera and audio).

import { useEffect, useRef } from 'react'
import { Button } from '../components'
import { Icon } from '../Icon'

interface Props {
  onResume: () => void
  onRestart: () => void
  onQuit: () => void
  /** Preview / practice run: "Skip, I'm ready" (absent: no button). */
  onSkip?: () => void
}

export function PauseMenu({ onResume, onRestart, onQuit, onSkip }: Props) {
  const resumeRef = useRef<HTMLButtonElement>(null)
  // Enter / Space on the focused Resume button dances on (the stage ignores Space on controls).
  useEffect(() => resumeRef.current?.focus(), [])

  return (
    <div className="play-overlay dim-bg df-pause-overlay">
      <div className="df-pause-menu df-pop-in" role="dialog" aria-modal="true" aria-labelledby="df-pause-title">
        <Icon name="clock-tower" size={88} className="df-pause-menu-icon df-bob" />
        <hgroup className="df-hgroup">
          <p className="df-voice">The music waits for you</p>
          <h2 id="df-pause-title" className="df-title df-title-lg">
            Paused
          </h2>
        </hgroup>
        <div className="df-pause-menu-actions">
          <button ref={resumeRef} type="button" className="df-btn df-btn-primary df-btn-lg df-btn-block" onClick={onResume}>
            <Icon name="sparkles" size="xs" cut="none" />
            Resume
          </button>
          <Button variant="secondary" icon="wand" block onClick={onRestart}>
            Restart
          </Button>
          {onSkip && (
            <Button variant="secondary" icon="slipper" block onClick={onSkip}>
              Skip, I’m ready
            </Button>
          )}
          <a className="df-btn df-btn-secondary df-btn-block" href="#/settings">
            <Icon name="gear" size="xs" cut="none" />
            Settings
          </a>
          <Button variant="secondary" icon="castle" block onClick={onQuit}>
            Quit to lobby
          </Button>
          <a className="df-btn df-btn-ghost" href="#/">
            Main menu
          </a>
        </div>
        <p className="df-note">
          <kbd>Space</kbd> resume · <kbd>R</kbd> restart · <kbd>Esc</kbd> lobby
        </p>
      </div>
    </div>
  )
}
