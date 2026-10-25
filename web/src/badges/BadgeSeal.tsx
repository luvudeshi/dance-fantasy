import { Icon } from '../theme/Icon'
import type { BadgeInfo } from './model'
import './badges.css'

/** A badge's sticker on its tier ring (bronze, silver or gold); `locked` shows the empty slot's faint outline. */
export function BadgeSeal({ badge, locked = false, size = 'md' }: { badge: BadgeInfo; locked?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`bdg-seal bdg-${badge.tier} bdg-seal-${size}${locked ? ' is-locked' : ''}`} aria-hidden="true">
      <Icon name={badge.icon} size="md" cut={locked ? 'none' : 'sm'} />
    </span>
  )
}
