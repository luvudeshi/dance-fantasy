import { useEffect, useSyncExternalStore } from 'react'
import { Sparkle } from '../theme/components'
import { BadgeSeal } from './BadgeSeal'
import { TIER_NAMES, badgeQueue, dismissBadge, subscribeBadges } from './model'

const SHOW_MS = 4800

/**
 * "Badge unlocked!" sticker toasts, one at a time from the queue that recordRound fills (announceBadges).
 * Mount once, globally, next to <InviteToast />; it sits at the top so the two never overlap.
 */
export function BadgeToast() {
  const queue = useSyncExternalStore(subscribeBadges, badgeQueue)
  const badge = queue[0]
  useEffect(() => {
    if (!badge) return
    const timer = window.setTimeout(dismissBadge, SHOW_MS)
    return () => window.clearTimeout(timer)
  }, [badge])

  return (
    <div aria-live="polite" className="bdg-toast-region">
      {badge && (
        <div key={badge.id} role="status" className={`bdg-toast bdg-${badge.tier}`}>
          <Sparkle className="bdg-spark bdg-spark-1" />
          <Sparkle className="bdg-spark bdg-spark-2" />
          <Sparkle className="bdg-spark bdg-spark-3" />
          <BadgeSeal badge={badge} size="sm" />
          <span className="bdg-toast-text">
            <span className="df-voice bdg-toast-kicker">Badge unlocked!</span>
            <b className="bdg-toast-name">{badge.name}</b>
            <span className="bdg-toast-meta">
              {TIER_NAMES[badge.tier]} · {badge.description}
            </span>
          </span>
          {queue.length > 1 && (
            <span className="bdg-toast-more" aria-label={`${queue.length - 1} more`}>
              +{queue.length - 1}
            </span>
          )}
          <button type="button" className="df-btn df-btn-icon df-btn-sm" aria-label="Dismiss" onClick={dismissBadge}>
            <svg viewBox="0 0 20 20" className="df-glyph" aria-hidden="true">
              <path d="M5 5 L15 15 M15 5 L5 15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
