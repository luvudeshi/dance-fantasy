import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { formatScore } from '../game/results'
import { Icon } from '../theme/Icon'
import { avatarFor, dancersOf, rankPlayers, type RoomPlayer } from './client'

// Room standings: the live board (lobby side panel and the in-game overlay) and the synced 5-4-3-2-1.
// The final results are per mode (modes/ModeResults).

const MEDALS = ['', 'df-medal-silver', 'df-medal-rasp'] as const

/** Live ranking of the dancers (not watchers): medal / rank, name, score, a progress line under each row. */
export function LiveBoard({ players, meId, max, compact = false }: { players: readonly RoomPlayer[]; meId?: string; max?: number; compact?: boolean }) {
  const ranked = rankPlayers(dancersOf(players)).slice(0, max)
  return (
    <ol className={`df-list rm-board${compact ? ' rm-board-compact' : ''}`} aria-label="Leaderboard">
      {ranked.map((p, i) => (
        <li key={p.id} className={`df-item${p.id === meId ? ' is-on' : ''}`} data-player={p.name}>
          <span className={`df-medal df-medal-sm ${MEDALS[i] ?? 'rm-rank'}`} aria-label={`Rank ${i + 1}`}>
            {i + 1}
          </span>
          {!compact && <Icon name={avatarFor(players, p.id)} size="sm" cut="sm" className="df-item-icon" />}
          <div className="df-item-body">
            <span className="df-item-title">
              {p.name}
              {p.id === meId && <span className="df-note"> (you)</span>}
            </span>
            <span className="rm-progress" aria-hidden="true">
              <span style={{ '--rm-progress': `${Math.round(p.progress * 100)}%` } as CSSProperties} />
            </span>
          </div>
          <span className="df-item-end df-num" data-score={p.score}>
            {formatScore(p.score)}
          </span>
        </li>
      ))}
    </ol>
  )
}

/**
 * Whole seconds left until `target` (local epoch ms), re-rendered exactly on each second boundary
 * (not on a 100 ms tick), so two devices with the same target flip digits together.
 */
function useSecondsLeft(target: number): number {
  const [left, setLeft] = useState(() => Math.ceil((target - Date.now()) / 1000))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = (): void => {
      const ms = target - Date.now()
      setLeft(Math.ceil(ms / 1000))
      if (ms > 0) timer = setTimeout(tick, (ms % 1000 || 1000) + 1)
    }
    tick()
    return () => clearTimeout(timer)
  }, [target])
  return left
}

/** Full-screen 5-4-3-2-1 to `target`; calls onGo once at zero. */
export function Countdown({ target, title, onGo }: { target: number; title: string; onGo?: () => void }) {
  const left = useSecondsLeft(target)
  const fired = useRef(false)
  useEffect(() => {
    if (left <= 0 && !fired.current) {
      fired.current = true
      onGo?.()
    }
  }, [left, onGo])
  const urgent = left <= 3
  return (
    <div className="rm-countdown" role="timer" aria-live="assertive" data-countdown={Math.max(0, left)}>
      <div className="df-twinkles" aria-hidden="true" />
      <p className="df-voice rm-countdown-kicker">{title}</p>
      <div className="df-plate rm-countdown-plate">
        <Icon name="clock-tower" size="lg" className={urgent ? 'df-bob-fast' : 'df-bob'} />
        <span key={left} className="df-foil rm-countdown-digit df-pop-in">
          {left > 0 ? left : 'Go!'}
        </span>
      </div>
      <p className="df-lede rm-countdown-note">{left > 0 ? 'Every dancer starts together.' : 'To the ballroom floor!'}</p>
    </div>
  )
}
