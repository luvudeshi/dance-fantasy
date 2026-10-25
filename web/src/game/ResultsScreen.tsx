// End-of-song results over the stage: score, stars, accuracy, judgment counts, best combo, the
// hardest move (pictogram + practice tip), the best move and a move-by-move accuracy list.
// Large type and high contrast so it reads on a projector. Pure view model: results.ts.

import { useEffect, useRef } from 'react'
import type { Move } from '@shared/routine'
import { prepareCanvas } from '../lib/canvas'
import { coachThemeFor } from '../render/coach'
import { drawPictogram } from '../render/pictogram'
import { formatPercent, scoreColor, type ResultsView } from './results'

interface Props {
  view: ResultsView
  moves: readonly Move[]
  mirrored: boolean
  autoplay: boolean
  onPlayAgain: () => void
  onNewRoutine: () => void
  onLobby: () => void
}

function Stars({ value }: { value: number }) {
  const pct = `${Math.max(0, Math.min(100, (value / 5) * 100))}%`
  return (
    <div className="results-stars" role="img" aria-label={`${Math.floor(value)} of 5 stars`}>
      <span className="results-stars-bg" aria-hidden="true">
        ★★★★★
      </span>
      <span className="results-stars-fg" aria-hidden="true" style={{ width: pct }}>
        ★★★★★
      </span>
    </div>
  )
}

function MovePictogram({ move, mirrored, theme }: { move: Move; mirrored: boolean; theme: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const prepared = prepareCanvas(canvas)
    if (!prepared) return
    drawPictogram(prepared.ctx, move, { x: 0, y: 0, w: prepared.width, h: prepared.height }, { mirrored, theme: coachThemeFor(theme), active: true })
  }, [move, mirrored, theme])
  return <canvas ref={ref} className="results-pictogram" aria-label={`Pictogram of ${move.name}`} />
}

export default function ResultsScreen({ view, moves, mirrored, autoplay, onPlayAgain, onNewRoutine, onLobby }: Props) {
  const playAgainRef = useRef<HTMLButtonElement>(null)
  // Enter replays straight away (Space stays the stage's pause key, which is off here).
  useEffect(() => playAgainRef.current?.focus(), [])

  const hardMove = view.hardest ? moves[view.hardest.moveIndex] : undefined
  const bestMove = view.best ? moves[view.best.moveIndex] : undefined

  return (
    <div className="play-overlay dim-bg results-overlay">
      <div className="results-card" role="dialog" aria-modal="true" aria-labelledby="results-title">
        <header className="results-head">
          <p className="lobby-kicker">The clock struck twelve!</p>
          <h2 id="results-title" className="results-title">
            {view.title}
          </h2>
          <p className="results-blurb">
            {view.blurb}
            {autoplay && ' (The autoplay bot danced this one.)'}
          </p>
        </header>

        <div className="results-grid">
          <section className="results-main" aria-label="Score">
            <div className="results-score">{view.score}</div>
            <Stars value={view.stars} />
            <div className="results-stats">
              <div>
                <span className="results-stat-value">{view.accuracy}</span>
                <span className="results-stat-label">accuracy</span>
              </div>
              <div>
                <span className="results-stat-value">×{view.maxCombo}</span>
                <span className="results-stat-label">best combo</span>
              </div>
            </div>
            <ul className="results-counts">
              {view.counts.map((c) => (
                <li key={c.judgment}>
                  <strong style={{ color: c.color }}>{c.count}</strong>
                  <span>{c.label}</span>
                </li>
              ))}
            </ul>
            <div className="play-card-actions results-actions">
              <button ref={playAgainRef} type="button" className="primary" onClick={onPlayAgain}>
                ↻ Play again
              </button>
              <button type="button" onClick={onNewRoutine}>
                🎲 New routine
              </button>
              <button type="button" onClick={onLobby}>
                Lobby
              </button>
            </div>
          </section>

          <section className="results-side" aria-label="Moves">
            {view.hardest && hardMove && (
              <div className="results-spot hardest">
                <MovePictogram move={hardMove} mirrored={mirrored} theme="chorus" />
                <div>
                  <p className="results-spot-kicker">Hardest move</p>
                  <h3>
                    {view.hardest.row.name} <span className="results-spot-pct">{formatPercent(view.hardest.row.accuracy)}</span>
                  </h3>
                  <p className="results-tip">{view.hardest.tip}</p>
                </div>
              </div>
            )}
            {view.best && bestMove && (
              <div className="results-spot best">
                <MovePictogram move={bestMove} mirrored={mirrored} theme="intro" />
                <div>
                  <p className="results-spot-kicker">Best move</p>
                  <h3>
                    {view.best.row.name} <span className="results-spot-pct">{formatPercent(view.best.row.accuracy)}</span>
                  </h3>
                </div>
              </div>
            )}
            {view.moves.length > 0 && (
              <>
                <h3 className="results-list-title">Move by move</h3>
                <ol className="results-moves">
                  {view.moves.map((m) => (
                    <li key={m.id}>
                      <span className="results-move-name">{m.name}</span>
                      <span className="results-bar" aria-hidden="true">
                        <span style={{ width: `${Math.max(2, Math.min(100, m.accuracy))}%`, background: scoreColor(m.accuracy) }} />
                      </span>
                      <span className="results-move-pct">{formatPercent(m.accuracy)}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
