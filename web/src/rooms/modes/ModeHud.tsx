import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { formatScore } from '../../game/results'
import { Token } from '../../theme/components'
import { Icon } from '../../theme/Icon'
import { avatarFor, dancersOf, type CrewStats, type RoomPlayer, type RoomView } from '../client'
import { nextSyncPoints, SYNC_STREAK_CAP, syncBurst, syncMeter, versusRows } from './modeStats'
import './modes.css'

// In-game mode HUDs (RoomLeaderboard's overlay renders them over the play stage).

const BURST_MS = 1400

/** A flame for the streak row: lit (gold and raspberry) or an empty paper outline. */
function Flame({ lit }: { lit: boolean }) {
  return (
    <svg viewBox="0 0 20 26" className={`dfm-flame${lit ? ' is-lit' : ''}`} aria-hidden="true">
      <path d="M10 1C12 7 18 10 18 17A8 8 0 0 1 2 17C2 12 5 10 6 6C8 9 9 10 9.5 10C9 7 9 4 10 1Z" className="dfm-flame-outer" />
      <path d="M10 12C11 15 14 16 14 19A4 4 0 0 1 6 19C6 16 8 15 10 12Z" className="dfm-flame-inner" />
    </svg>
  )
}

/** Crew: team score, the shared in-sync meter and streak flames, the dancers still in the round. */
export function CrewHud({ crew, players }: { crew: CrewStats; players: readonly RoomPlayer[] }) {
  const lit = Math.min(crew.syncStreak, SYNC_STREAK_CAP)
  return (
    <section className="dfm-panel dfm-crew" aria-label="Crew">
      <div className="dfm-crew-score">
        <span className="df-voice">Team score</span>
        <span className="dfm-big df-num">{formatScore(crew.teamScore)}</span>
      </div>
      <div className="dfm-sync">
        <div className="dfm-sync-head">
          <span className="df-label">In sync</span>
          <span className="df-num dfm-sync-streak">×{crew.syncStreak}</span>
        </div>
        <div className="dfm-meter" role="meter" aria-label="Sync streak" aria-valuemin={0} aria-valuemax={SYNC_STREAK_CAP} aria-valuenow={lit}>
          <span style={{ '--dfm-fill': `${syncMeter(crew) * 100}%` } as CSSProperties} />
        </div>
        <div className="dfm-flames">
          {Array.from({ length: SYNC_STREAK_CAP }, (_, i) => (
            <Flame key={i} lit={i < lit} />
          ))}
        </div>
        <span className="df-note">
          Next beat together: <b className="df-num">+{nextSyncPoints(crew)}</b>
        </span>
      </div>
      <div className="dfm-crew-dancers" aria-label="Dancers">
        {dancersOf(players).map((p) => (
          <Token key={p.id} icon={avatarFor(players, p.id)} size="sm" label={p.name} off={!p.connected || p.finished} />
        ))}
      </div>
    </section>
  )
}

/**
 * The "IN SYNC ×5!" ribbon, shown for a moment whenever everyone has hit another beat together.
 * Mount it outside any filtered box (it is position: fixed).
 */
export function SyncBurst({ crew }: { crew: CrewStats }) {
  const prev = useRef<CrewStats | null>(null)
  const timer = useRef<number | null>(null)
  const [burst, setBurst] = useState<{ streak: number; key: number } | null>(null)

  // a new RoomView arrives about once a second; only a newly synced beat (re)starts the burst
  useEffect(() => {
    const streak = prev.current === null ? null : syncBurst(prev.current, crew)
    prev.current = crew
    if (streak === null) return
    setBurst({ streak, key: crew.lastSyncBeat ?? 0 })
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setBurst(null), BURST_MS)
  }, [crew])
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  if (!burst) return null
  return (
    <div key={burst.key} className="dfm-burst" role="status">
      <span className="df-ribbon-wrap">
        <span className="df-ribbon df-ribbon-gold dfm-burst-ribbon">
          <Icon name="sparkles" size="xs" cut="none" />
          In sync ×{burst.streak}!
        </span>
      </span>
    </div>
  )
}

/** Versus: beats won per dancer as head-to-head bars, the leader crowned. */
export function VersusHud({ room, meId }: { room: Pick<RoomView, 'players' | 'leaderId'>; meId: string | null }) {
  const rows = versusRows(room)
  return (
    <section className="dfm-panel dfm-versus" aria-label="Versus: beats won">
      <span className="df-voice">Beats won</span>
      <ol className="dfm-vs-list">
        {rows.map((r) => (
          <li key={r.player.id} className={`dfm-vs-row${r.player.id === meId ? ' is-me' : ''}${r.leader ? ' is-leader' : ''}`}>
            <span className="dfm-vs-token">
              <Token icon={avatarFor(room.players, r.player.id)} size="sm" off={!r.player.connected} />
              {r.leader && <Icon name="crown" size={26} cut="sm" className="dfm-vs-crown" label="Leader" />}
            </span>
            <span className="dfm-vs-name">
              {r.player.name}
              {r.player.id === meId && <small> (you)</small>}
            </span>
            <span className="dfm-vs-bar" aria-hidden="true">
              <span style={{ '--dfm-fill': `${r.share * 100}%` } as CSSProperties} />
            </span>
            <span className="df-num dfm-vs-won">{r.player.beatsWon}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
