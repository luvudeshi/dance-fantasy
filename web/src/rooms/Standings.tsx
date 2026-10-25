import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { formatScore } from '../game/results'
import { Icon } from '../theme/Icon'
import { avatarFor, rankPlayers, type RoomPlayer } from './client'

// Room standings: the live board (lobby side panel and the in-game overlay), the final podium and
// the synced 5-4-3-2-1.

const MEDALS = ['', 'df-medal-silver', 'df-medal-rasp'] as const

/** Live ranking: medal / rank, name, score, a progress line under each row. */
export function LiveBoard({ players, meId, max, compact = false }: { players: readonly RoomPlayer[]; meId?: string; max?: number; compact?: boolean }) {
  const ranked = rankPlayers(players).slice(0, max)
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

/** Final standings: 2nd, 1st, 3rd on steps; everyone else below. */
export function Podium({ players, meId }: { players: readonly RoomPlayer[]; meId?: string }) {
  const ranked = rankPlayers(players)
  const top = [ranked[1], ranked[0], ranked[2]]
  const rest = ranked.slice(3)
  return (
    <div className="df-stack rm-podium-wrap">
      <ol className="rm-podium" aria-label="Podium">
        {top.map((p, slot) => {
          if (!p) return <li key={slot} className="rm-step rm-step-empty" aria-hidden="true" />
          const place = slot === 1 ? 1 : slot === 0 ? 2 : 3
          return (
            <li key={p.id} className={`rm-step rm-step-${place}${p.id === meId ? ' is-me' : ''}`} data-place={place}>
              {place === 1 && <div className="df-glory rm-glory" aria-hidden="true" />}
              <Icon name={avatarFor(players, p.id)} size={place === 1 ? 'lg' : 'md'} className={place === 1 ? 'df-bob' : undefined} />
              <span className="rm-step-name">{p.name}</span>
              <span className={`df-medal ${MEDALS[place - 1]} ${place === 1 ? '' : 'df-medal-sm'}`}>{place}</span>
              <div className="rm-step-block">
                <span className="df-num rm-step-score">{formatScore(p.score)}</span>
                <span className="df-note">{Math.round(p.accuracy)}% accuracy</span>
                <span className="df-note">best combo {p.maxCombo}</span>
              </div>
            </li>
          )
        })}
      </ol>
      {rest.length > 0 && (
        <ol className="df-list" start={4} aria-label="Everyone else">
          {rest.map((p, i) => (
            <li key={p.id} className={`df-item${p.id === meId ? ' is-on' : ''}`}>
              <span className="df-medal df-medal-sm rm-rank">{i + 4}</span>
              <div className="df-item-body">
                <span className="df-item-title">{p.name}</span>
                <span className="df-item-meta">{Math.round(p.accuracy)}% · combo {p.maxCombo}</span>
              </div>
              <span className="df-item-end df-num">{formatScore(p.score)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
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
