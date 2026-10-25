// In-game party overlay, rendered as a child of the play stage: one score column per dancer (their
// sticker, name, score, combo and a judgment ribbon in their colour) and the party mirror with every
// dancer outlined in their colour. It also drives the run: tick(songTime) every animation frame.

import { useEffect, useState, type CSSProperties } from 'react'
import { formatScore } from '../game/results'
import { Token } from '../theme/components'
import PartyMirror from './PartyMirror'
import type { PartyPlayerView, PartyRun } from './partyRun'
import type { PartyTracker } from './tracker'
import './party.css'

interface Props {
  run: PartyRun
  tracker: PartyTracker
  video?: HTMLVideoElement
  /** The game clock (GameClock), or the harness' fake one. */
  clock: { songTime(): number }
  /** Practice: no scores, just outlines. */
  showMirror?: boolean
}

/** What the columns show; React only re-renders when this changes (scores move a few times a second). */
const columnsKey = (vs: readonly PartyPlayerView[]): string =>
  vs.map((v) => `${v.score}:${v.combo}:${v.seen ? 1 : 0}:${v.callout?.id ?? ''}:${v.name}`).join('|')

export default function PartyHud({ run, tracker, video, clock, showMirror = true }: Props) {
  const [views, setViews] = useState<PartyPlayerView[]>(() => run.view())
  useEffect(() => {
    let raf = 0
    let key = ''
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      run.tick(clock.songTime())
      const vs = run.view()
      const k = columnsKey(vs)
      if (k !== key) {
        key = k
        setViews(vs)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [run, clock])

  return (
    <div className="party-hud">
      <ol className="party-columns" aria-label="Party scores">
        {views.map((v) => (
          <li
            key={v.player.slot}
            className={`df-card-sm party-column ${v.seen ? '' : 'is-away'}`}
            style={{ '--pc': v.color.hex, '--pc-on': v.color.on } as CSSProperties}
          >
            <Token icon={v.player.icon} size="sm" off={!v.seen} />
            <span className="party-column-body">
              <span className="party-column-name">{v.name}</span>
              <span className="df-num party-column-score" aria-label={`${v.name}: ${formatScore(v.score)} points`}>
                {formatScore(v.score)}
              </span>
              <span className="party-column-meta">{v.seen ? (v.combo >= 2 ? `×${v.combo} combo` : ' ') : 'Can’t see you'}</span>
            </span>
            {v.callout && (
              <span key={v.callout.id} className={`df-ribbon-wrap party-ribbon is-${v.callout.judgment}`} aria-hidden="true">
                <span className="df-ribbon df-ribbon-ui">{v.callout.label}</span>
              </span>
            )}
          </li>
        ))}
      </ol>
      {showMirror && (
        <div className="df-mirror df-st-live party-hud-mirror">
          <div className="df-mirror-glass df-mirror-night party-glass">
            <PartyMirror tracker={tracker} players={run.players} video={video} run={run} label="Camera view with every dancer outlined" />
          </div>
        </div>
      )}
    </div>
  )
}
