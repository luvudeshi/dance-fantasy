import { useEffect, useState, type CSSProperties } from 'react'
import { errorMessage } from '../lib/errors'
import { Button, Corners, Notice, Panel, Title, Token } from '../theme/components'
import { ICON_NAMES, type IconName } from '../theme/icons'
import { AccountSheet } from './AccountSheet'
import { Avatar } from './AccountChip'
import { COLORS, getHistory, iconLabel, updateMe, type AccountColor, type History, type RoundMode } from './client'
import { ensureSession, setMe, useAccount } from './store'
import './account.css'

// Profile (#/profile): name, sticker, colour, friend code, stats and recent rounds, plus the optional
// "keep your account on other devices" sheet.

const COLOR_NAMES: Record<AccountColor, string> = {
  rasp: 'Raspberry',
  gold: 'Antique gold',
  blue: 'Powder blue',
  sage: 'Sage',
  burg: 'Burgundy',
  night: 'Midnight',
}
const MODE_NAMES: Record<RoundMode, string> = { solo: 'Solo', party: 'Party', room: 'Room' }

const gap = (v: string): CSSProperties => ({ '--df-gap': v }) as CSSProperties
const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function ProfilePage() {
  const { me, status, error: bootError } = useAccount()
  const [draft, setDraft] = useState<string | null>(null) // the name being typed; null shows the saved one
  const [history, setHistory] = useState<History | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [sheet, setSheet] = useState(false)

  useEffect(() => void ensureSession(), [])
  const rounds = me?.stats.rounds
  const meId = me?.id
  useEffect(() => {
    if (!meId) return
    const ctrl = new AbortController()
    getHistory(ctrl.signal).then(setHistory, (err: unknown) => {
      if (!ctrl.signal.aborted) setError(errorMessage(err))
    })
    return () => ctrl.abort()
  }, [meId, rounds])

  const flash = (msg: string): void => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400)
  }

  const save = async (patch: { name?: string; avatar?: IconName; color?: AccountColor }): Promise<void> => {
    setError(null)
    try {
      setMe(await updateMe(patch))
      if (patch.name !== undefined) setDraft(null)
      flash('Saved to your dance card.')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const copyCode = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      flash('Friend code copied.')
    } catch {
      flash(`Your code is ${code}.`) // clipboard blocked (http, permissions): at least show it
    }
  }

  const share = async (code: string): Promise<void> => {
    try {
      await navigator.share({ title: 'Dance Fantasy', text: `Add me on Dance Fantasy! My friend code is ${code}.` })
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) await copyCode(code)
    }
  }

  if (!me) {
    return (
      <div className="df-screen acct-page">
        <div className="df-container acct-page-body">
          <Notice
            inline
            tone={status === 'unavailable' ? 'error' : 'info'}
            icon="crystal-ball"
            message={status === 'unavailable' ? `Profiles are resting right now. ${bootError ?? ''}` : 'Opening your dance card…'}
          />
        </div>
      </div>
    )
  }

  const name = draft ?? me.name
  const trimmed = name.replace(/\s+/g, ' ').trim()
  return (
    <div className="df-screen acct-page">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="df-container df-stack acct-page-body" style={gap('28px')}>
        <header className="acct-hero">
          <Avatar icon={me.avatar} color={me.color} size="lg" label={iconLabel(me.avatar)} />
          <div className="df-stack" style={gap('8px')}>
            <Title variant="large" kicker="Your dance card">
              {me.name}
            </Title>
            <p className="df-lede acct-lede">
              {me.isGuest ? 'Dancing as a guest on this device.' : `Saved as @${me.username}.`} Friends find you by your code.
            </p>
          </div>
        </header>

        {error && <Notice inline tone="error" message={error} />}

        <div className="acct-panels">
          <Panel title="Who you are" kicker="What the court calls you" sticker="crown">
            <form
              className="acct-name-row"
              onSubmit={(e) => {
                e.preventDefault()
                if (trimmed && trimmed !== me.name) void save({ name: trimmed })
              }}
            >
              <label className="df-label" htmlFor="acct-name">
                Your name
              </label>
              <input
                id="acct-name"
                className="df-field"
                value={name}
                maxLength={24}
                autoComplete="nickname"
                onChange={(e) => setDraft(e.target.value)}
              />
              <Button type="submit" variant="secondary" disabled={!trimmed || trimmed === me.name}>
                Save
              </Button>
            </form>

            <fieldset className="acct-fieldset">
              <legend className="df-label">Your colour</legend>
              <div className="df-cluster" style={gap('10px')}>
                {COLORS.map((c) => (
                  <label key={c} className="acct-swatch-label" title={COLOR_NAMES[c]}>
                    <input
                      type="radio"
                      name="acct-color"
                      className="df-sr-only"
                      checked={me.color === c}
                      onChange={() => void save({ color: c })}
                    />
                    <span className="acct-swatch" style={{ '--acct-c': `var(--df-${c})` } as CSSProperties} />
                    <span className="df-sr-only">{COLOR_NAMES[c]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="acct-fieldset">
              <legend className="df-label">Your sticker</legend>
              <div className="acct-picker">
                {ICON_NAMES.map((n) => (
                  <label key={n} className="acct-pick" title={iconLabel(n)}>
                    <input
                      type="radio"
                      name="acct-avatar"
                      className="df-sr-only"
                      checked={me.avatar === n}
                      onChange={() => void save({ avatar: n })}
                    />
                    <Token icon={n} size="sm" picked={me.avatar === n} label={iconLabel(n)} />
                  </label>
                ))}
              </div>
            </fieldset>
          </Panel>

          <div className="df-stack" style={gap('40px')}>
            <Panel title="Your friend code" kicker="Share it so friends can add you" sticker="key">
              <div className="df-cluster" style={gap('12px')}>
                <span className="df-code-chip acct-code-chip" aria-label={`Friend code ${me.friendCode}`}>
                  <small aria-hidden="true">Code</small>
                  <span className="df-foil" aria-hidden="true" translate="no">
                    {me.friendCode}
                  </span>
                </span>
                <Button variant="secondary" size="sm" icon="scroll" onClick={() => void copyCode(me.friendCode)}>
                  Copy
                </Button>
                {'share' in navigator && (
                  <Button variant="secondary" size="sm" icon="party" onClick={() => void share(me.friendCode)}>
                    Share
                  </Button>
                )}
              </div>
              <a className="df-btn df-btn-ghost df-btn-sm acct-link" href="#/friends">
                Your friends ({me.stats.friends}) &rsaquo;
              </a>
            </Panel>

            <Panel title="Your stats" kicker="Every round you have danced" sticker="trophy">
              <div className="df-scroll">
                <dl className="df-dl">
                  <dt>Rounds</dt>
                  <dd>{(history?.totalRounds ?? me.stats.rounds).toLocaleString()}</dd>
                  <dt>Best score</dt>
                  <dd>{(history?.bestScore ?? me.stats.bestScore).toLocaleString()}</dd>
                  <dt>Average accuracy</dt>
                  <dd>{history ? `${Math.round(history.avgAccuracy)}%` : '–'}</dd>
                  <div className="df-rule" aria-hidden="true" />
                  <dt>Day streak</dt>
                  <dd>{history ? `${history.dayStreak} ${history.dayStreak === 1 ? 'day' : 'days'}` : '–'}</dd>
                  <dt>Friends</dt>
                  <dd>{me.stats.friends}</dd>
                </dl>
              </div>
            </Panel>

            <Panel title="Keep your account" kicker="Optional" sticker="castle">
              <p className="df-note acct-note">
                {me.isGuest
                  ? 'Add a username and password to log in on other devices. Guests can already do everything here.'
                  : `Logged in as @${me.username}. Log in with it on any device.`}
              </p>
              <div>
                <Button variant="secondary" icon="key" onClick={() => setSheet(true)}>
                  {me.isGuest ? 'Keep it on other devices' : 'Account & log out'}
                </Button>
              </div>
            </Panel>
          </div>

          <Panel title="Recent rounds" kicker="Your last twenty dances" sticker="music-note" className="acct-wide">
            {!history ? (
              <p className="df-note acct-note">Leafing through the storybook…</p>
            ) : history.rounds.length === 0 ? (
              <p className="df-note acct-note">No rounds yet. Dance one and it lands here.</p>
            ) : (
              <ol className="df-list">
                {history.rounds.map((r) => (
                  <li key={`${r.at}-${r.analysisId}`} className="df-item">
                    <span className={`df-medal df-medal-sm${r.stars >= 4 ? '' : r.stars >= 2.5 ? ' df-medal-silver' : ' df-medal-rasp'}`}>
                      <span aria-hidden="true">{Math.floor(r.stars)}</span>
                      <span className="df-sr-only">{r.stars} stars</span>
                    </span>
                    <span className="df-item-body">
                      <span className="df-item-title">{r.songTitle}</span>
                      <span className="df-item-meta">
                        {MODE_NAMES[r.mode]} · {Math.round(r.accuracy)}% · combo {r.maxCombo} · {when(r.at)}
                      </span>
                    </span>
                    <span className="df-item-end">{r.score.toLocaleString()}</span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>
      <AccountSheet open={sheet} onClose={() => setSheet(false)} />
      <Notice message={toast} tone="success" />
    </div>
  )
}
