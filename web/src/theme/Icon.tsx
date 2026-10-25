import type { CSSProperties } from 'react'
import type { IconName } from './icons'

const SIZES = { xs: 24, sm: 40, md: 64, lg: 96, xl: 144 } as const
const CUTS = { none: '', sm: 'df-st-sm', md: 'df-st', lg: 'df-st-lg' } as const

/**
 * One kit icon as a die-cut sticker. Decorative by default (alt=""); pass `label` when it carries meaning.
 * `size` is a preset or pixels; CSS may override it (e.g. inside .df-btn the icon is 1.75em).
 */
export function Icon({
  name,
  size = 'md',
  cut = 'md',
  label,
  className,
  style,
}: {
  name: IconName
  size?: keyof typeof SIZES | number
  cut?: keyof typeof CUTS
  label?: string
  className?: string
  style?: CSSProperties
}) {
  const px = typeof size === 'number' ? size : SIZES[size]
  const cls = `${CUTS[cut]} ${className ?? ''}`.trim()
  return (
    <img
      src={`/art/icons/${name}.svg`}
      width={px}
      height={px}
      alt={label ?? ''}
      aria-hidden={label ? undefined : true}
      draggable={false}
      className={cls || undefined}
      style={style}
    />
  )
}
