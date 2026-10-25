// Party results: the podium (2nd, 1st, 3rd; a 4th dancer below), every dancer's storybook title(s),
// score and accuracy, then play again or change the line-up.

import type { CSSProperties } from 'react'
import { formatPercent, formatScore } from '../game/results'
import { Button, Corners, Title, Token } from '../theme/components'
import { rankParty, type Placing } from './awards'
import type { PartyStanding } from './partyRun'
import { colorOf, displayName } from './players'
import './party.css'

interface Props {
  standings: readonly PartyStanding[]
  songTitle: string
  onAgain: () => void
  onSetup: () => void
}

const MEDAL = ['', 'df-medal-silver', 'df-medal-rasp'] as const

/** Podium order for the steps: 2nd, 1st, 3rd (fewer dancers: just what exists). */
function podiumOrder(top: readonly Placing[]): Placing[] {
  const [a, b, c] = top
  return [b, a, c].filter((p): p is Placing => p !== undefined)
}

function Step({ placing, standing }: { placing: Placing; standing: PartyStanding }) {
  const color = colorOf(standing.player)
  const s = standing.summary
  const name = displayName(standing.player)
  const first = placing.rank === 1
  return (
    <li className={`party-step is-rank-${Math.min(placing.rank, 3)}`} style={{ '--pc': color.hex, '--pc-on': color.on } as CSSProperties}>
      <div className={first ? 'party-step-glory' : undefined}>
        <Token icon={standing.player.icon} size={first ? 'xl' : 'lg'} picked label={name} />
      </div>
      <span className="df-tag party-step-tag">
        <span className="df-tag-name">{name}</span>
        <span className="df-tag-role">{placing.awards[0]?.title}</span>
      </span>
      <div className="party-step-block">
        <span className={`df-medal ${MEDAL[Math.min(placing.rank, 3) - 1]}`}>{placing.rank}</span>
        <span className="df-num party-step-score">{formatScore(s.state.score)}</span>
        <span className="party-step-acc">{formatPercent(s.accuracy)} accuracy</span>
      </div>
    </li>
  )
}

export default function PartyResults({ standings, songTitle, onAgain, onSetup }: Props) {
  const placings = rankParty(standings)
  const winner = placings[0]
  const winnerName = winner && winner.awards.some((a) => a.id === 'belle') ? displayName(standings[winner.index].player) : null
  return (
    <div className="df-screen party-screen party-results">
      <Corners />
      <div className="df-container df-stack" style={{ '--df-gap': '24px' } as CSSProperties}>
        <header className="party-results-head">
          <Title variant="cut" kicker={songTitle}>
            The Podium
          </Title>
          {winnerName && (
            <span className="df-ribbon-wrap">
              <span className="df-ribbon df-ribbon-gold">{winnerName} is the Belle of the Ball</span>
            </span>
          )}
        </header>

        <ol className="party-podium" aria-label="Podium">
          {podiumOrder(placings.slice(0, 3)).map((p) => (
            <Step key={p.index} placing={p} standing={standings[p.index]} />
          ))}
        </ol>

        <section className="df-panel" aria-labelledby="party-titles">
          <div className="df-panel-head">
            <h2 id="party-titles" className="df-panel-title">
              Titles of the night
            </h2>
          </div>
          <ol className="df-list">
            {placings.map((p) => {
              const st = standings[p.index]
              const color = colorOf(st.player)
              const s = st.summary
              return (
                <li key={p.index} className="df-item party-title-row" style={{ '--pc': color.hex, '--pc-on': color.on } as CSSProperties}>
                  <span className={`df-medal df-medal-sm ${MEDAL[Math.min(p.rank, 3) - 1]}`}>{p.rank}</span>
                  <Token icon={st.player.icon} size="sm" />
                  <span className="df-item-body">
                    <span className="df-item-title">{displayName(st.player)}</span>
                    <span className="party-awards">
                      {p.awards.map((a) => (
                        <span key={a.id} className="party-award">
                          <b>{a.title}</b> <span>{a.detail}</span>
                        </span>
                      ))}
                    </span>
                    <span className="df-item-meta">
                      {formatPercent(s.accuracy)} accuracy · {s.state.counts.perfect} perfect · best combo {s.state.maxCombo}
                    </span>
                  </span>
                  <span className="df-item-end">{formatScore(s.state.score)}</span>
                </li>
              )
            })}
          </ol>
        </section>

        <div className="df-cluster party-results-actions">
          <Button size="lg" icon="sparkles" onClick={onAgain}>
            Dance it again
          </Button>
          <Button variant="secondary" icon="party" onClick={onSetup}>
            Change the line-up
          </Button>
        </div>
      </div>
    </div>
  )
}
