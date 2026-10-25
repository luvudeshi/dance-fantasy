import { useEffect, useState, type ReactNode } from 'react'
import { Avatar } from '../account/AccountChip'
import { iconLabel, type AccountColor } from '../account/client'
import { errorMessage } from '../lib/errors'
import { Card } from '../theme/components'
import type { IconName } from '../theme/icons'
import { getBoardSongs, getSongBoard, placementLine, type BoardSong, type SongBoard } from './client'
import './leaderboard.css'

// The compact Hall of Fame card for one song (top 5 + your rank): the lobby's selected song and the results
// screen. Bump `refreshKey` after recordRound resolves so it re-reads; `placed` adds "You placed #3 on …!".

const CARD_TOP = 5

/** Rank 1-3 on a gold / silver / raspberry medal; the rest as a plain number. */
export function RankMark({ rank, size = 'sm' }: { rank: number; size?: 'sm' | 'md' | 'lg' }) {
  if (rank > 3) return <span className="lb-rank df-num">{rank}</span>
  const tone = rank === 1 ? '' : rank === 2 ? ' df-medal-silver' : ' df-medal-rasp'
  const sz = size === 'md' ? '' : ` df-medal-${size}`
  return (
    <span className={`df-medal${sz}${tone}`}>
      <span aria-hidden="true">{rank}</span>
      <span className="df-sr-only">Rank {rank}</span>
    </span>
  )
}

/** One ranked dancer as a list row; your own row is ringed. */
export function DancerRow({
  rank,
  name,
  avatar,
  color,
  isYou,
  meta,
  value,
}: {
  rank: number
  name: string
  avatar: IconName
  color: AccountColor
  isYou: boolean
  meta: ReactNode
  value: ReactNode
}) {
  return (
    <li className={`df-item lb-row${isYou ? ' is-on' : ''}`} aria-current={isYou ? 'true' : undefined}>
      <RankMark rank={rank} />
      <Avatar icon={avatar} color={color} size="sm" label={iconLabel(avatar)} />
      <span className="df-item-body">
        <span className="df-item-title">
          {name}
          {isYou && <span className="lb-you"> · you</span>}
        </span>
        <span className="df-item-meta">{meta}</span>
      </span>
      <span className="df-item-end df-num">{value}</span>
    </li>
  )
}

export function SongLeaderboard({
  analysisId,
  title,
  refreshKey = 0,
  placed = false,
}: {
  analysisId: string
  /** shown until the board answers (the board's own title wins once someone has danced it) */
  title?: string
  refreshKey?: number
  placed?: boolean
}) {
  const [board, setBoard] = useState<SongBoard | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    getSongBoard(analysisId, 'all', CARD_TOP, ctrl.signal).then(
      (b) => {
        setBoard(b)
        setError(null)
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) setError(errorMessage(err))
      },
    )
    return () => ctrl.abort()
  }, [analysisId, refreshKey])

  const shown = board?.song.analysisId === analysisId ? board : null // a new song shows "loading" until it answers
  const songTitle = shown?.song.title ?? title ?? 'This song'
  const you = shown?.you ?? null
  const line = placed ? placementLine(you, songTitle) : null
  return (
    <Card size="sm" className="lb-card">
      <div className="lb-card-head">
        <div className="df-hgroup">
          <p className="df-voice">Hall of Fame</p>
          <h3 className="df-title lb-card-title">{songTitle}</h3>
        </div>
        <a className="df-btn df-btn-ghost df-btn-sm" href={`#/hall?song=${analysisId}`}>
          All &rsaquo;
        </a>
      </div>
      {line && (
        <p className="lb-placed df-display df-pop-in" role="status">
          {line}
        </p>
      )}
      {error ? (
        <p className="df-note lb-note">The Hall of Fame is resting. {error}</p>
      ) : !shown ? (
        <p className="df-note lb-note">Unrolling the scroll…</p>
      ) : shown.entries.length === 0 ? (
        <p className="df-note lb-note">No one has danced this one yet. The crown is yours to take.</p>
      ) : (
        <ol className="df-list lb-list" aria-label={`Top dancers on ${songTitle}`}>
          {shown.entries.map((e) => (
            <DancerRow
              key={e.accountId}
              {...e}
              meta={`${Math.round(e.accuracy)}% · combo ${e.maxCombo}`}
              value={e.score.toLocaleString()}
            />
          ))}
          {you && you.rank > CARD_TOP && (
            <li className="df-item lb-row is-on lb-row-you">
              <span className="lb-rank df-num">{you.rank}</span>
              <span className="df-item-body">
                <span className="df-item-title">Your best</span>
              </span>
              <span className="df-item-end df-num">{you.score.toLocaleString()}</span>
            </li>
          )}
        </ol>
      )}
    </Card>
  )
}

/**
 * The lobby's card for the selected library song. The song isn't analyzed yet, so its analysisId (the
 * file's sha256) comes from GET /api/leaderboard/songs, matched by title (library songs are listed first).
 */
export function LobbySongBoard({ title }: { title: string | undefined }) {
  const [songs, setSongs] = useState<BoardSong[] | null>(null)
  useEffect(() => {
    const ctrl = new AbortController()
    getBoardSongs(ctrl.signal).then(setSongs, (err: unknown) => {
      // ponytail: no list means no card; the lobby works without it
      if (!ctrl.signal.aborted) console.warn('[hall] song list failed', err)
    })
    return () => ctrl.abort()
  }, [])
  const song = songs?.find((s) => s.title === title)
  return song ? <SongLeaderboard analysisId={song.analysisId} title={song.title} /> : null
}
