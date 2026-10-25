// The party setup sheet: how many dancers, who they are (name, sticker avatar, colour), the song, and
// the magic mirror showing everyone the camera sees, outlined in the colour they will dance in.

import { useEffect, useId, useState, type CSSProperties } from 'react'
import type { Difficulty } from '@shared/routine'
import type { SongInfo } from '../api'
import { Badge, Button, Corners, Notice, Segmented, Title, Token } from '../theme/components'
import { Icon } from '../theme/Icon'
import PartyMirror from './PartyMirror'
import { cleanName, colorOf, displayName, MAX_PARTY, MIN_PARTY, PARTY_AVATARS, PARTY_COLORS, type PartyPlayer } from './players'
import type { PartyTracker } from './tracker'
import './party.css'

const COUNTS = Array.from({ length: MAX_PARTY - MIN_PARTY + 1 }, (_, i) => {
  const n = MIN_PARTY + i
  return { value: String(n), label: String(n) }
})

const DIFFICULTY = [
  { value: 'easy', label: 'Gentle' },
  { value: 'normal', label: 'Lively' },
  { value: 'hard', label: 'Wild' },
] as const satisfies readonly { value: Difficulty; label: string }[]

interface Props {
  players: readonly PartyPlayer[]
  onPlayers: (players: PartyPlayer[]) => void
  onCount: (count: number) => void
  tracker: PartyTracker
  video?: HTMLVideoElement
  /** null while loading. */
  songs: readonly SongInfo[] | null
  song: string | null
  onSong: (file: string) => void
  difficulty: Difficulty
  onDifficulty: (d: Difficulty) => void
  onStart: () => void
  /** "Listening to the song…" while the game is prepared. */
  busy?: string | null
  error?: string | null
  cameraError?: string | null
  onRetryCamera?: () => void
}

/** Live "who's in the mirror" from the tracker (a few times a second is plenty for text). */
function useMirrorCount(tracker: PartyTracker, players: number): { detected: number; seen: boolean[] } {
  const [state, setState] = useState({ detected: 0, seen: Array.from({ length: players }, () => false) })
  useEffect(() => {
    let lastAt = Number.NEGATIVE_INFINITY
    const off = tracker.onTracked(() => {
      lastAt = performance.now()
    })
    const id = window.setInterval(() => {
      const t = tracker.latest()
      const fresh = t !== null && performance.now() - lastAt < 1000
      const seen = Array.from({ length: players }, (_, i) => fresh && Boolean(t.players[i]))
      const detected = fresh ? t.detected : 0
      setState((cur) => (cur.detected === detected && cur.seen.join() === seen.join() ? cur : { detected, seen }))
    }, 250)
    return () => {
      off()
      window.clearInterval(id)
    }
  }, [tracker, players])
  return state
}

function DancerCard({ player, others, seen, onChange }: { player: PartyPlayer; others: readonly PartyPlayer[]; seen: boolean; onChange: (p: PartyPlayer) => void }) {
  const nameId = useId()
  const color = colorOf(player)
  const nextAvatar = (): void => {
    const taken = new Set(others.map((o) => o.icon))
    const start = PARTY_AVATARS.indexOf(player.icon)
    for (let k = 1; k <= PARTY_AVATARS.length; k++) {
      const icon = PARTY_AVATARS[(start + k) % PARTY_AVATARS.length]
      if (!taken.has(icon)) return onChange({ ...player, icon })
    }
  }
  return (
    <li className="df-card-sm party-dancer" style={{ '--pc': color.hex, '--pc-on': color.on } as CSSProperties}>
      <button type="button" className="party-avatar" onClick={nextAvatar} aria-label={`Change ${displayName(player)}'s sticker`} title="Pick another sticker">
        <Token icon={player.icon} picked={seen} tick={seen} />
      </button>
      <div className="party-dancer-body">
        <label className="df-label" htmlFor={nameId}>
          Dancer {player.slot + 1}
          <span className="party-where">{seen ? ' · in the mirror' : ' · step into the mirror'}</span>
        </label>
        <input
          id={nameId}
          className="df-field"
          value={player.name}
          maxLength={16}
          placeholder={`Dancer ${player.slot + 1}`}
          autoComplete="off"
          onChange={(e) => onChange({ ...player, name: cleanName(e.target.value) })}
        />
        <div className="party-swatches" role="radiogroup" aria-label={`${displayName(player)}'s colour`}>
          {PARTY_COLORS.map((c) => {
            const usedBy = others.find((o) => o.colorId === c.id)
            return (
              <label key={c.id} className="party-swatch" style={{ '--sw': c.hex } as CSSProperties} title={usedBy ? `${c.label} (${displayName(usedBy)})` : c.label}>
                <input
                  type="radio"
                  className="df-sr-only"
                  name={`${nameId}-color`}
                  checked={player.colorId === c.id}
                  disabled={usedBy !== undefined}
                  onChange={() => onChange({ ...player, colorId: c.id })}
                />
                <span aria-hidden="true" />
                <span className="df-sr-only">{c.label}</span>
              </label>
            )
          })}
        </div>
      </div>
    </li>
  )
}

export default function PartySetup(p: Props) {
  const { players, tracker } = p
  const { detected, seen } = useMirrorCount(tracker, players.length)
  const everyone = detected >= players.length
  const songId = useId()
  const update = (next: PartyPlayer): void => p.onPlayers(players.map((x) => (x.slot === next.slot ? next : x)))
  const countText = `${Math.min(detected, players.length)} of ${players.length} dancers in the mirror`
  return (
    <div className="df-screen party-screen">
      <Corners />
      <div className="df-container party-setup">
        <header className="df-topbar">
          <span className="df-brand">
            Dance <b>Fantasy</b>
          </span>
          <Badge tone="gold" icon="party">
            Party mode
          </Badge>
        </header>

        <div className="party-setup-grid">
          <section className="party-mirror-col" aria-labelledby="party-mirror-title">
            <div className="df-mirror df-st-live party-mirror">
              <img className="df-mirror-crest" src="/art/storybook/crest.svg" alt="" />
              <div className="df-mirror-glass df-mirror-night df-mirror-glare party-glass">
                <PartyMirror tracker={tracker} players={players} video={p.video} emptyText="Everyone, into the mirror!" label={`Camera view: ${countText}`} />
              </div>
            </div>
            <div className="party-mirror-caption">
              <h2 id="party-mirror-title" className="df-voice party-mirror-title">
                Everyone in the mirror
              </h2>
              <p aria-live="polite" className={`party-count ${everyone ? 'is-full' : ''}`}>
                <span className="df-num">{Math.min(detected, players.length)}</span> of <span className="df-num">{players.length}</span> dancers in the mirror
              </p>
              <p className="df-note">
                {detected > players.length
                  ? `The mirror sees ${detected} people: only ${players.length} will be scored.`
                  : everyone
                    ? 'Lovely. Keep an arm’s length apart so nobody overlaps.'
                    : 'Stand side by side, a step apart, with your whole bodies in view.'}
              </p>
              {p.cameraError && (
                <div className="df-stack" style={{ '--df-gap': '8px' } as CSSProperties}>
                  <Notice inline tone="error" message={p.cameraError} />
                  {p.onRetryCamera && (
                    <Button variant="secondary" size="sm" onClick={p.onRetryCamera}>
                      Try the camera again
                    </Button>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="df-stack party-form" style={{ '--df-gap': '18px' } as CSSProperties} aria-label="Party setup">
            <Title variant="cut" kicker="The">
              Party
            </Title>
            <p className="df-lede">Up to four dancers, one mirror. Each of you is followed in your own colour and scored on your own.</p>

            <div className="party-count-pick">
              <span className="df-label" aria-hidden="true">
                Dancers
              </span>
              <Segmented label="Number of dancers" value={String(players.length)} options={COUNTS} onChange={(v) => p.onCount(Number(v))} />
            </div>

            <ol className="party-dancers">
              {players.map((pl) => (
                <DancerCard key={pl.slot} player={pl} others={players.filter((o) => o.slot !== pl.slot)} seen={seen[pl.slot] ?? false} onChange={update} />
              ))}
            </ol>

            <div className="party-song">
              <label className="df-label" htmlFor={songId}>
                Song
              </label>
              <select id={songId} className="df-field" value={p.song ?? ''} disabled={!p.songs || p.songs.length === 0} onChange={(e) => p.onSong(e.target.value)}>
                {!p.songs && <option value="">Finding the music…</option>}
                {p.songs?.map((s) => (
                  <option key={s.file} value={s.file}>
                    {s.title}
                  </option>
                ))}
              </select>
              <Segmented label="Difficulty" value={p.difficulty} options={DIFFICULTY} onChange={p.onDifficulty} />
            </div>

            {p.error && <Notice inline tone="error" message={p.error} />}
            <div className="party-start">
              <p className="df-voice">{p.busy ?? (everyone ? 'When the court is ready,' : 'Start any time; latecomers can join in.')}</p>
              <Button size="lg" icon="sparkles" onClick={p.onStart} disabled={Boolean(p.busy) || !p.song}>
                {p.busy ? 'Getting ready…' : 'Start the ball'}
              </Button>
            </div>
          </section>
        </div>
      </div>
      <Icon name="dance-shoe" size="lg" className="party-deco" />
    </div>
  )
}
