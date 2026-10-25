import { useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { AccountChip } from '../account/AccountChip'
import { Corners } from '../theme/components'
import { Icon } from '../theme/Icon'
import type { IconName } from '../theme/icons'
import { menuStep } from './menuNav'
import { ServerStatus, type ServerState } from './ShellBar'
import { uiSound, unlockUiSound } from './uiSound'
import './shell.css'

// The title screen (#/): the storybook title and the main menu. Arrow keys / Home / End move
// between entries, Enter opens one, Esc folds the Party choices away. Hover and focus tick,
// a click chimes (game sounds, when sound effects are on).

interface Entry {
  icon: IconName
  title: string
  meta: string
  href: string | null
}

const MENU_ITEM = '[data-menu]'

/** Ticks when the pointer or the keyboard lands on an entry; chimes when one is chosen. */
const sounds = {
  onPointerEnter: () => uiSound('tick'),
  onFocus: (e: SyntheticEvent<HTMLElement>) => {
    if (e.currentTarget.matches(':focus-visible')) uiSound('tick')
  },
  onClick: () => uiSound('good'),
}

export default function Menu({ learn, server }: { learn: string | null; server: ServerState }) {
  const navRef = useRef<HTMLElement>(null)
  const [party, setParty] = useState(false)
  const partyRef = useRef<HTMLButtonElement>(null)
  const roomRef = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      unlockUiSound()
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key === 'Escape') {
        if (party) {
          setParty(false)
          partyRef.current?.focus()
        }
        return
      }
      const items = Array.from(navRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? []).filter(
        (el) => !(el as HTMLButtonElement).disabled,
      )
      const at = items.indexOf(document.activeElement as HTMLElement)
      const next = menuStep(at, items.length, e.key)
      if (next === null) return
      e.preventDefault()
      items[next]?.focus()
    }
    const onPointer = (): void => unlockUiSound()
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [party])

  useEffect(() => {
    if (party) roomRef.current?.focus()
  }, [party])

  const entries: readonly Entry[] = [
    {
      icon: 'dance-shoe',
      title: 'Learn',
      meta: learn ? 'Your latest routine, step by step' : 'Dance a song first',
      href: learn,
    },
    { icon: 'upload', title: 'Studio', meta: 'Bring a song, see its beats', href: '#/analysis' },
    { icon: 'storybook', title: 'Move Book', meta: 'Every step of the ball', href: '#/moves' },
    { icon: 'map', title: 'How to Play', meta: 'The rules of the ball', href: '#/how' },
    { icon: 'party', title: 'Friends', meta: 'Friend codes, invites, who is dancing', href: '#/friends' },
    { icon: 'gear', title: 'Settings', meta: 'Sound, camera, difficulty', href: '#/settings' },
    { icon: 'quill', title: 'Credits', meta: 'Who made the magic', href: '#/credits' },
  ]

  return (
    <div className="df-screen title-screen">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="title-layout">
        <div className="title-main">
          <header className="title-head">
            <p className="df-voice title-kicker">The Twelve Dancing Princesses present</p>
            <h1 className="df-cut-letters title-logo">
              <span>Dance</span> <span>Fantasy</span>
            </h1>
            <p className="df-lede df-display title-lede">
              Bring any song to the enchanted ball. A glowing partner dances it, you follow in the magic mirror, and the
              clock keeps score until midnight.
            </p>
          </header>

          <nav ref={navRef} aria-label="Main menu" className="title-menu">
            <div className="df-cluster title-ctas">
              <a className="df-btn df-btn-primary df-btn-lg title-play" href="#/play" data-menu {...sounds}>
                <Icon name="sparkles" size="sm" cut="none" />
                Play
              </a>
              <button
                ref={partyRef}
                type="button"
                className="df-btn df-btn-secondary df-btn-lg title-party"
                aria-expanded={party}
                aria-controls="party-choices"
                data-menu
                {...sounds}
                onClick={() => {
                  sounds.onClick()
                  setParty((p) => !p)
                }}
              >
                <Icon name="party" size="sm" cut="none" />
                Party
              </button>
            </div>

            {party && (
              <div id="party-choices" className="df-card-sm title-party-card df-pop-in">
                <p className="df-voice">2 to 4 dancers, one camera, right here</p>
                <div className="df-cluster" style={{ '--df-gap': '12px' } as CSSProperties}>
                  <a ref={roomRef} className="df-btn df-btn-primary df-btn-sm" href="#/play?party=3" data-menu {...sounds}>
                    <Icon name="party" size="xs" cut="none" />
                    Party in this room
                  </a>
                </div>
                <p className="df-voice">Dance-off with friends in other homes</p>
                <div className="df-cluster" style={{ '--df-gap': '12px' } as CSSProperties}>
                  <a className="df-btn df-btn-secondary df-btn-sm" href="#/room" data-menu {...sounds}>
                    <Icon name="crown" size="xs" cut="none" />
                    Open a ballroom
                  </a>
                  <a className="df-btn df-btn-secondary df-btn-sm" href="#/join" data-menu {...sounds}>
                    <Icon name="key" size="xs" cut="none" />
                    Join with a code
                  </a>
                </div>
              </div>
            )}

            <ul className="df-list title-grid">
              {entries.map((e, i) => (
                <li key={e.title} className="df-pop-in" style={{ animationDelay: `${120 + i * 50}ms` }}>
                  {e.href ? (
                    <a className="df-item title-item" href={e.href} data-menu {...sounds}>
                      <Icon name={e.icon} className="df-item-icon" cut="none" />
                      <span className="df-item-body">
                        <span className="df-item-title">{e.title}</span>
                        <span className="df-item-meta">{e.meta}</span>
                      </span>
                    </a>
                  ) : (
                    <button type="button" className="df-item title-item" disabled data-menu>
                      <Icon name={e.icon} className="df-item-icon" cut="none" />
                      <span className="df-item-body">
                        <span className="df-item-title">{e.title}</span>
                        <span className="df-item-meta">{e.meta}</span>
                      </span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </nav>

          <footer className="title-foot">
            <AccountChip />
            <ServerStatus server={server} />
            <span className="df-note">HackTX 2026</span>
            <span className="df-note title-keys" aria-hidden="true">
              <kbd>↑</kbd> <kbd>↓</kbd> choose · <kbd>Enter</kbd> go
            </span>
          </footer>
        </div>

        {/* a little scene of stickers: the magic mirror, the clock at midnight, the castle and a glass slipper */}
        <div className="title-scene" aria-hidden="true">
          <Icon name="castle" cut="lg" size={240} className="title-st title-st-castle" />
          <Icon name="clock-tower" cut="lg" size={240} className="title-st title-st-clock" />
          <Icon name="mirror" cut="lg" size={300} className="title-st title-st-mirror" />
          <Icon name="crown" size={140} className="title-st title-st-crown df-bob" />
          <Icon name="slipper" size={170} className="title-st title-st-slipper" />
          <Icon name="music-note" size={110} className="title-st title-st-note df-bob" />
          <Icon name="sparkles" cut="sm" size={100} className="title-st title-st-sparkles df-twinkle" />
        </div>
      </div>
    </div>
  )
}
