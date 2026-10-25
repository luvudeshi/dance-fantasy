import type { CSSProperties } from 'react'
import { Icon } from '../theme/Icon'
import type { IconName } from '../theme/icons'
import type { AccountColor } from './client'
import { useAccount } from './store'
import './account.css'

/** A player's sticker on a disc of their colour (the --df-<color> token). */
export function Avatar({
  icon,
  color,
  size = 'md',
  label,
}: {
  icon: IconName
  color: AccountColor
  size?: 'sm' | 'md' | 'lg'
  label?: string
}) {
  return (
    <span className={`acct-avatar acct-avatar-${size}`} style={{ '--acct-c': `var(--df-${color})` } as CSSProperties}>
      <Icon name={icon} cut="none" size="md" label={label} />
    </span>
  )
}

/** Green when online, faded when away; the text says it too. */
export function OnlineDot({ online }: { online: boolean }) {
  return <span className={`acct-dot${online ? ' is-on' : ''}`} aria-hidden="true" />
}

/** Header chip: your avatar and name; opens the profile. Hidden until the session loads (or if accounts are down). */
export function AccountChip({ href = '#/profile' }: { href?: string }) {
  const { me } = useAccount()
  if (!me) return null
  return (
    <a className="acct-chip" href={href} aria-label={`Your profile: ${me.name}`}>
      <Avatar icon={me.avatar} color={me.color} size="sm" />
      <span className="acct-chip-name">{me.name}</span>
    </a>
  )
}
