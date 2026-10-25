import { useEffect, useState } from 'react'
import { getMyBadges } from '../account/client'
import { errorMessage } from '../lib/errors'
import { Badge, Modal, Notice, Panel } from '../theme/components'
import { BadgeSeal } from './BadgeSeal'
import { TIER_NAMES, byTier, progressLabel, progressPct, type EarnedBadge, type LockedBadge, type MyBadges, type Tier } from './model'

// The profile's badge shelf: earned badges as die-cut stickers on their tier ring, locked ones as faint
// outlines with progress ("3 / 5 songs"), each opening a detail card.

const TIER_TONE: Record<Tier, 'gold' | 'blue' | 'paper'> = { gold: 'gold', silver: 'blue', bronze: 'paper' }
type Shown = { badge: EarnedBadge; earned: true } | { badge: LockedBadge; earned: false }

const earnedOn = (at: number): string => new Date(at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })

function Bar({ pct }: { pct: number }) {
  return (
    <span className="bdg-bar" aria-hidden="true">
      <span style={{ width: `${pct}%` }} />
    </span>
  )
}

/** `refreshKey`: anything that changes when a badge may have been earned (rounds, friends, username). */
export function BadgeShelf({ refreshKey }: { refreshKey?: string }) {
  const [data, setData] = useState<MyBadges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    getMyBadges(ctrl.signal).then(
      (d) => {
        setData(d)
        setError(null)
      },
      (err: unknown) => {
        if (!ctrl.signal.aborted) setError(errorMessage(err))
      },
    )
    return () => ctrl.abort()
  }, [refreshKey])

  const tiles: Shown[] = data
    ? [
        ...byTier(data.earned).map((badge): Shown => ({ badge, earned: true })),
        ...byTier(data.locked).map((badge): Shown => ({ badge, earned: false })),
      ]
    : []
  const total = data ? data.earned.length + data.locked.length : 0

  return (
    <Panel
      title="Badges"
      kicker="Stickers for your dance card"
      sticker="sparkles"
      className="acct-wide"
      actions={data && <Badge tone="gold">{`${data.earned.length} of ${total} collected`}</Badge>}
    >
      {error && !data ? (
        <Notice inline tone="error" message={error} />
      ) : !data ? (
        <p className="df-note acct-note">Polishing the trophy case…</p>
      ) : (
        <ul className="bdg-grid">
          {tiles.map((t) => (
            <li key={t.badge.id}>
              <button
                type="button"
                className={`bdg-tile df-bare${t.earned ? '' : ' is-locked'}`}
                aria-haspopup="dialog"
                onClick={() => setShown(t)}
              >
                <BadgeSeal badge={t.badge} locked={!t.earned} />
                <span className="bdg-name">{t.badge.name}</span>
                <span className="bdg-meta">
                  <span className="df-sr-only">{t.earned ? 'Earned, ' : 'Locked, '}</span>
                  {t.earned ? TIER_NAMES[t.badge.tier] : progressLabel(t.badge)}
                </span>
                {!t.earned && t.badge.progress.need > 1 && <Bar pct={progressPct(t.badge)} />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {shown && (
        <Modal open onClose={() => setShown(null)} title={shown.badge.name}>
          <div className="bdg-detail">
            <BadgeSeal badge={shown.badge} locked={!shown.earned} size="lg" />
            <div className="bdg-detail-body">
              <Badge tone={TIER_TONE[shown.badge.tier]} icon={shown.earned ? shown.badge.icon : undefined}>
                {`${TIER_NAMES[shown.badge.tier]} badge`}
              </Badge>
              <p className="bdg-detail-desc">{shown.badge.description}</p>
              {shown.earned ? (
                <p className="df-note acct-note">Earned {earnedOn(shown.badge.earnedAt)}.</p>
              ) : (
                <>
                  <p className="df-note acct-note">
                    {shown.badge.progress.need > 1 ? `So far: ${progressLabel(shown.badge)}.` : 'Not earned yet. Keep dancing!'}
                  </p>
                  {shown.badge.progress.need > 1 && <Bar pct={progressPct(shown.badge)} />}
                </>
              )}
            </div>
          </div>
        </Modal>
      )}
    </Panel>
  )
}
