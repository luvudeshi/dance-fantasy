import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Avatar } from '../account/AccountChip'
import { getHistory, iconLabel } from '../account/client'
import { ensureSession, useAccount } from '../account/store'
import { errorMessage } from '../lib/errors'
import { Corners, Notice, Panel, Title } from '../theme/components'
import { Icon } from '../theme/Icon'
import {
  getBoardSongs,
  getSongBoard,
  getTopBoard,
  songFromHash,
  songOptions,
  type BoardSong,
  type SongBoard,
  type SongScope,
  type TopBoard,
} from './client'
import { DancerRow, RankMark } from './SongLeaderboard'
import './leaderboard.css'

// Hall of Fame (#/hall, or #/hall?song=<analysisId>): a song's best rounds (podium + ranked list) by
// All-time / This week / Today / Friends, and the top dancers of the last seven days.

const SCOPES: readonly { value: SongScope; label: string }[] = [
  { value: 'all', label: 'All-time' },
  { value: 'week', label: 'This week' },
  { value: 'today', label: 'Today' },
  { value: 'friends', label: 'Friends' },
]
const EMPTY: Record<SongScope, string> = {
  all: 'No one has danced this song yet. Be the first name in the Hall.',
  week: 'Nobody has danced this song in the last seven days.',
  today: 'No rounds of this song today. The floor is open.',
  friends: 'You and your friends have not danced this one yet.',
}
const BOARD_LIMIT = 10
const TOP_LIMIT = 8

const gap = (v: string): CSSProperties => ({ '--df-gap': v }) as CSSProperties

export default function HallOfFame() {
  const { me } = useAccount()
  const meId = me?.id
  const [songs, setSongs] = useState<BoardSong[] | null>(null)
  const [song, setSong] = useState<string | null>(() => songFromHash(window.location.hash))
  const [scope, setScope] = useState<SongScope>('all')
  const [loaded, setLoaded] = useState<SongBoard | null>(null)
  const [top, setTop] = useState<TopBoard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)

  // the picker: library + most-danced songs, then your recent ones
  useEffect(() => {
    const ctrl = new AbortController()
    const recent = ensureSession().then((m) => (m ? getHistory(ctrl.signal).then((h) => h.rounds, () => []) : []))
    Promise.all([getBoardSongs(ctrl.signal), recent]).then(
      ([list, mine]) => {
        const opts = songOptions(list, mine)
        setSongs(opts)
        setSong((s) => s ?? (opts.find((o) => o.dancers > 0) ?? opts[0])?.analysisId ?? null)
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) setError(errorMessage(err))
      },
    )
    return () => ctrl.abort()
  }, [])

  useEffect(() => {
    if (!song) return
    const ctrl = new AbortController()
    getSongBoard(song, scope, BOARD_LIMIT, ctrl.signal).then(
      (b) => {
        setLoaded(b)
        setError(null)
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) setError(errorMessage(err))
      },
    )
    return () => ctrl.abort()
  }, [song, scope, meId])

  useEffect(() => {
    const ctrl = new AbortController()
    getTopBoard('week', TOP_LIMIT, ctrl.signal).then(setTop, (err: unknown) => {
      if (!ctrl.signal.aborted) setError(errorMessage(err))
    })
    return () => ctrl.abort()
  }, [meId])

  const pick = (id: string): void => {
    setSong(id)
    window.history.replaceState(null, '', `#/hall?song=${id}`)
  }

  // arrow keys move between the tabs (and choose), like a native tab strip
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = SCOPES.findIndex((s) => s.value === scope)
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = SCOPES[(at + step + SCOPES.length) % SCOPES.length]
    if (!next) return
    setScope(next.value)
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-scope="${next.value}"]`)?.focus()
  }

  // the board for another song or tab counts as loading
  const board = loaded && loaded.song.analysisId === song && loaded.scope === scope ? loaded : null
  const current = songs?.find((s) => s.analysisId === song)
  const title = board?.song.title ?? current?.title ?? (song ? 'This song' : 'Pick a song')
  const podium = board?.entries.filter((e) => e.rank <= 3) ?? []
  const rest = board?.entries.filter((e) => e.rank > 3) ?? []
  const you = board?.you
  return (
    <div className="df-screen lb-page">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="df-container df-stack lb-body" style={gap('28px')}>
        <header className="lb-hero">
          <Title variant="cut" kicker="The court remembers every dance">
            Hall of Fame
          </Title>
          <div className="lb-picker">
            <label className="df-label" htmlFor="lb-song">
              Song
            </label>
            <select
              id="lb-song"
              className="df-field"
              value={song ?? ''}
              disabled={!songs?.length && !song}
              onChange={(e) => pick(e.target.value)}
            >
              {!songs?.length && <option value="">{songs ? 'No songs yet' : 'Leafing through the songbook…'}</option>}
              {songs && song && !current && <option value={song}>{title}</option>}
              {songs?.map((s) => (
                <option key={s.analysisId} value={s.analysisId}>
                  {s.title}
                  {s.dancers ? ` · ${s.dancers} ${s.dancers === 1 ? 'dancer' : 'dancers'}` : ''}
                </option>
              ))}
            </select>
          </div>
        </header>

        {error && <Notice inline tone="error" icon="crystal-ball" message={`The Hall of Fame is resting. ${error}`} />}

        <div className="lb-layout">
          <Panel title={title} kicker="Best round per dancer" sticker="trophy" className="lb-main">
            <div className="df-tabs lb-tabs" role="tablist" aria-label="When" ref={tabsRef} onKeyDown={onTabKey}>
              {SCOPES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  role="tab"
                  className="df-tab"
                  data-scope={s.value}
                  aria-selected={scope === s.value}
                  aria-controls="lb-board"
                  tabIndex={scope === s.value ? 0 : -1}
                  onClick={() => setScope(s.value)}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div id="lb-board" role="tabpanel" aria-live="polite" className="df-stack" style={gap('20px')}>
              {!song ? (
                <p className="df-note lb-note">Dance a song and its Hall of Fame opens here.</p>
              ) : !board ? (
                <p className="df-note lb-note">Unrolling the scroll…</p>
              ) : board.entries.length === 0 ? (
                <div className="lb-empty">
                  <Icon name="crown" size={88} className="df-bob" />
                  <p className="df-display lb-empty-line">{EMPTY[scope]}</p>
                  <a className="df-btn df-btn-primary" href="#/play">
                    <Icon name="sparkles" size="xs" cut="none" />
                    Dance it
                  </a>
                </div>
              ) : (
                <>
                  <ol className="lb-podium" aria-label="The podium">
                    {podium.map((e) => (
                      <li key={e.accountId} className={`lb-step lb-step-${e.rank}${e.isYou ? ' is-you' : ''}`}>
                        {e.rank === 1 && <Icon name="crown" size={64} className="lb-crown df-bob" />}
                        <Avatar icon={e.avatar} color={e.color} size="lg" label={iconLabel(e.avatar)} />
                        <span className="lb-step-name">
                          {e.name}
                          {e.isYou && <span className="lb-you"> · you</span>}
                        </span>
                        <span className="lb-step-score df-num">{e.score.toLocaleString()}</span>
                        <span className="lb-step-meta">
                          {Math.round(e.accuracy)}% · combo {e.maxCombo}
                        </span>
                        <span className="lb-plinth">
                          <RankMark rank={e.rank} size={e.rank === 1 ? 'lg' : 'md'} />
                        </span>
                      </li>
                    ))}
                  </ol>
                  {rest.length > 0 && (
                    <ol className="df-list lb-list" aria-label="The rest of the Hall">
                      {rest.map((e) => (
                        <DancerRow
                          key={e.accountId}
                          {...e}
                          meta={`${Math.round(e.accuracy)}% · combo ${e.maxCombo} · ${e.stars} ★`}
                          value={e.score.toLocaleString()}
                        />
                      ))}
                    </ol>
                  )}
                  {you && you.rank > BOARD_LIMIT && (
                    <p className="lb-yours">
                      <span className="df-voice">Your best here</span> <strong className="df-num">#{you.rank}</strong> ·{' '}
                      <span className="df-num">{you.score.toLocaleString()}</span>
                    </p>
                  )}
                  {!you && me && <p className="df-note lb-note">Dance this song and your best round joins the list.</p>}
                </>
              )}
            </div>
          </Panel>

          <Panel title="Top dancers this week" kicker="Every round adds up" sticker="crown" className="lb-side">
            {!top ? (
              <p className="df-note lb-note">Counting the week's steps…</p>
            ) : top.entries.length === 0 ? (
              <p className="df-note lb-note">No rounds in the last seven days. Yours could be the first.</p>
            ) : (
              <ol className="df-list lb-list" aria-label="Top dancers this week">
                {top.entries.map((e) => (
                  <DancerRow
                    key={e.accountId}
                    {...e}
                    meta={`${e.rounds} ${e.rounds === 1 ? 'round' : 'rounds'} · combo ${e.bestCombo}`}
                    value={e.total.toLocaleString()}
                  />
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
