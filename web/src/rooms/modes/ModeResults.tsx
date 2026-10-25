import { useEffect, useState, type CSSProperties } from 'react'
import { formatScore, rankTitle, scoreBand } from '../../game/results'
import { errorMessage, isAbortError } from '../../lib/errors'
import { Button, Notice, Sparkle, Token } from '../../theme/components'
import { Icon } from '../../theme/Icon'
import { getHeatmap, rematch, type HeatBeat, type ModeRoom } from './api'
import { hardestMoments, teamStars, tokenFor, versusRows } from './modeStats'
import './modes.css'

const defaultBeatLabel = (beat: number): string => `Beat ${beat + 1}`

/**
 * End-of-song results for the room's mode: the crew's team result or the versus podium, the host's
 * rematch button, and the song's hardest moments across every room.
 */
export function ModeResults({
  room,
  meId,
  token,
  onRoom,
  totalBeats,
  beatLabel = defaultBeatLabel,
}: {
  room: ModeRoom
  meId: string | null
  token: string | null
  onRoom: (room: ModeRoom) => void
  /** the routine's checkpoint count, for the crew's sync share (optional) */
  totalBeats?: number
  /** label a checkpoint index, e.g. by its song time ("1:23") */
  beatLabel?: (beat: number) => string
}) {
  return (
    <section className="dfm-results df-stack" aria-label="Results">
      {room.mode === 'crew' ? <CrewResult room={room} totalBeats={totalBeats} /> : <VersusPodium room={room} meId={meId} />}
      <Rematch room={room} meId={meId} token={token} onRoom={onRoom} />
      {room.routine && <HeatmapStrip analysisId={room.routine.analysisId} beatLabel={beatLabel} />}
    </section>
  )
}

function Stars({ stars }: { stars: number }) {
  return (
    <span className="dfm-stars" role="img" aria-label={`${stars} of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Sparkle key={i} className={`dfm-star${i < stars ? ' is-lit' : ''}`} />
      ))}
    </span>
  )
}

function CrewResult({ room, totalBeats }: { room: ModeRoom; totalBeats?: number }) {
  const { crew, players } = room
  const stars = teamStars(players, crew, totalBeats)
  return (
    <div className="dfm-crew-result df-stack">
      <hgroup className="df-hgroup dfm-center">
        <p className="df-voice">The whole crew danced as</p>
        <h2 className="df-title df-title-lg">{rankTitle(stars)}</h2>
      </hgroup>
      <Stars stars={stars} />
      <div className="df-plate">
        <p className="df-voice">Team score</p>
        <span className="df-foil">{formatScore(crew.teamScore)}</span>
      </div>
      <div className="df-scroll">
        <dl className="df-dl">
          <dt>Beats in sync</dt>
          <dd className="df-num">{totalBeats ? `${crew.syncedBeats} of ${totalBeats}` : crew.syncedBeats}</dd>
          <dt>Best sync streak</dt>
          <dd className="df-num">×{crew.bestSyncStreak}</dd>
          <dt>Sync bonus</dt>
          <dd className="df-num">+{formatScore(crew.syncBonus)}</dd>
          <div className="df-rule" aria-hidden="true" />
          {players.map((p) => (
            <div key={p.id} className="dfm-dl-row">
              <dt>{p.name}</dt>
              <dd className="df-num">{formatScore(p.score)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}

const PODIUM_ORDER = [1, 0, 2] as const // second, first, third
const MEDALS = ['', 'df-medal-silver', 'df-medal-rasp'] as const

function VersusPodium({ room, meId }: { room: ModeRoom; meId: string | null }) {
  const rows = versusRows(room)
  const top = rows.slice(0, 3)
  const rest = rows.slice(3)
  const winner = top[0]
  return (
    <div className="dfm-podium-wrap df-stack">
      <hgroup className="df-hgroup dfm-center">
        <p className="df-voice">Mirror, mirror, who danced best?</p>
        <h2 className="df-title df-title-lg">{winner && winner.player.beatsWon > 0 ? `${winner.player.name} takes the crown` : 'A tie at the ball'}</h2>
      </hgroup>
      <ol className="dfm-podium">
        {PODIUM_ORDER.map((i) => {
          const r = top[i]
          if (!r) return null
          return (
            <li key={r.player.id} className={`dfm-step dfm-step-${i + 1}${r.player.id === meId ? ' is-me' : ''}`}>
              <div className={`dfm-step-token${i === 0 ? ' df-glory' : ''}`}>
                {r.leader && <Icon name="crown" size={56} className="dfm-step-crown" label="Winner" />}
                <Token icon={tokenFor(room.players, r.player.id)} size={i === 0 ? 'lg' : 'md'} picked={i === 0} />
              </div>
              <span className="df-tag">
                <span className="df-tag-name">{r.player.name}</span>
                <span className="df-tag-role">
                  <b className="df-num">{r.player.beatsWon}</b> beats won
                </span>
              </span>
              <span className="dfm-step-block">
                <span className={`df-medal ${MEDALS[i] ?? ''}`}>{r.rank}</span>
                <span className="df-note df-num">{formatScore(r.player.score)}</span>
              </span>
            </li>
          )
        })}
      </ol>
      {rest.length > 0 && (
        <ol className="df-list" start={4}>
          {rest.map((r) => (
            <li key={r.player.id} className="df-item" aria-current={r.player.id === meId ? true : undefined}>
              <span className="df-medal df-medal-sm df-medal-silver">{r.rank}</span>
              <Icon name={tokenFor(room.players, r.player.id)} className="df-item-icon" cut="sm" />
              <span className="df-item-body">
                <span className="df-item-title">{r.player.name}</span>
                <span className="df-item-meta">{r.player.beatsWon} beats won</span>
              </span>
              <span className="df-item-end">{formatScore(r.player.score)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function Rematch({ room, meId, token, onRoom }: { room: ModeRoom; meId: string | null; token: string | null; onRoom: (room: ModeRoom) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (room.state !== 'finished') return null
  if (token === null || meId !== room.hostId) {
    return <p className="df-voice dfm-center">The host can call for one more dance.</p>
  }
  const go = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onRoom(await rematch(room.code, token))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="df-stack dfm-center">
      <Button size="lg" icon="sparkles" disabled={busy} onClick={() => void go()}>
        Rematch
      </Button>
      <Notice inline tone="error" message={error} />
    </div>
  )
}

export function HeatmapStrip({ analysisId, beatLabel = defaultBeatLabel }: { analysisId: string; beatLabel?: (beat: number) => string }) {
  const [beats, setBeats] = useState<HeatBeat[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    getHeatmap(analysisId, ctl.signal).then(setBeats, (err: unknown) => {
      if (!isAbortError(err)) setError(errorMessage(err))
    })
    return () => ctl.abort()
  }, [analysisId])

  const hardest = beats ? hardestMoments(beats) : []
  return (
    <section className="df-panel dfm-heat" aria-label="Hardest moments">
      <Icon name="crystal-ball" size={76} className="df-panel-sticker" />
      <hgroup className="df-hgroup">
        <p className="df-voice">Across every ball danced to this song</p>
        <h2 className="df-panel-title">Hardest moments</h2>
      </hgroup>
      {error ? (
        <Notice inline tone="error" message={error} />
      ) : beats === null ? (
        <p className="df-note">Reading the crystal ball…</p>
      ) : beats.length === 0 ? (
        <p className="df-note">Nobody has danced this song yet.</p>
      ) : (
        <>
          <div className="dfm-heat-strip" role="img" aria-label={`Average score on each of ${beats.length} beats`}>
            {beats.map((b) => (
              <span
                key={b.beat}
                className={`dfm-heat-cell is-${scoreBand(b.avgScore)}`}
                style={{ '--dfm-h': `${Math.max(12, b.avgScore)}%` } as CSSProperties}
                title={`${beatLabel(b.beat)}: ${Math.round(b.avgScore)} average (${b.samples})`}
              />
            ))}
          </div>
          <ol className="dfm-heat-list">
            {hardest.map((b) => (
              <li key={b.beat} className="df-badge df-badge-rasp">
                {beatLabel(b.beat)} · <span className="df-num">{Math.round(b.avgScore)}</span> avg
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}
