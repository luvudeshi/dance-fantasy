import { useEffect, useId, useRef, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from 'react'
import { Icon } from './Icon'
import type { IconName } from './icons'

// Tiny typed wrappers over the df- classes (tokens.css, sticker.css, controls.css, pieces.css).
// Each one only composes classes and wires the a11y; anything fancier is plain markup with the classes.

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  icon,
  type = 'button',
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'icon'
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
  /** a kit icon before the label (for variant "icon" it is the whole button: also pass aria-label) */
  icon?: IconName
}) {
  return (
    <button
      type={type}
      className={cx('df-btn', `df-btn-${variant}`, size !== 'md' && `df-btn-${size}`, block && 'df-btn-block', className)}
      {...rest}
    >
      {icon && <Icon name={icon} size="xs" cut="none" />}
      {children}
    </button>
  )
}

export function Card({
  size = 'md',
  flush = false,
  className,
  ...rest
}: ComponentPropsWithoutRef<'div'> & { size?: 'sm' | 'md'; flush?: boolean }) {
  return <div className={cx(size === 'sm' ? 'df-card-sm' : 'df-card', flush && 'df-flush', className)} {...rest} />
}

/** A card with a heading row: optional italic kicker, title, actions on the right, an icon pinned on its corner. */
export function Panel({
  title,
  kicker,
  actions,
  sticker,
  className,
  children,
  ...rest
}: Omit<ComponentPropsWithoutRef<'section'>, 'title'> & {
  title?: ReactNode
  kicker?: ReactNode
  actions?: ReactNode
  sticker?: IconName
}) {
  const titleId = useId()
  return (
    <section className={cx('df-panel', className)} aria-labelledby={title ? titleId : undefined} {...rest}>
      {sticker && <Icon name={sticker} size={76} className="df-panel-sticker" />}
      {(title || actions) && (
        <div className="df-panel-head">
          <hgroup className="df-hgroup">
            {kicker && <p className="df-voice">{kicker}</p>}
            {title && (
              <h2 id={titleId} className="df-panel-title">
                {title}
              </h2>
            )}
          </hgroup>
          {actions && <div className="df-cluster">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Badge({
  tone = 'paper',
  icon,
  className,
  children,
}: {
  tone?: 'paper' | 'gold' | 'rasp' | 'sage' | 'blue' | 'night'
  icon?: IconName
  className?: string
  children: ReactNode
}) {
  return (
    <span className={cx('df-badge', tone !== 'paper' && `df-badge-${tone}`, className)}>
      {icon && <Icon name={icon} size="xs" cut="none" />}
      {children}
    </span>
  )
}

/** On/off switch (a native checkbox with role="switch"). */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  className,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
  className?: string
}) {
  return (
    <label className={cx('df-switch', className)}>
      <input
        type="checkbox"
        role="switch"
        className="df-switch-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="df-switch-track" aria-hidden="true" />
      <span>
        {label}
        {hint && <span className="df-note df-block">{hint}</span>}
      </span>
    </label>
  )
}

/** Labelled range input; the value shows on the right in Fraunces. */
export function Slider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  format = String,
  disabled = false,
  className,
}: {
  label: ReactNode
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  format?: (value: number) => string
  disabled?: boolean
  className?: string
}) {
  const id = useId()
  const fill = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0
  return (
    <div className={cx('df-control', className)}>
      <label htmlFor={id} className="df-label">
        {label}
      </label>
      <output htmlFor={id} className="df-control-value">
        {format(value)}
      </output>
      <input
        id={id}
        type="range"
        className="df-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--df-fill': `${fill}%` } as CSSProperties}
      />
    </div>
  )
}

/** One-of-N choice as native radios (arrow keys work); the chosen segment turns raspberry. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: {
  /** accessible name of the group */
  label: string
  value: T
  options: readonly { value: T; label: ReactNode }[]
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}) {
  const name = useId()
  return (
    <div className={cx('df-segmented', className)} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className="df-segment">
          <input
            type="radio"
            className="df-sr-only"
            name={name}
            value={o.value}
            checked={o.value === value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  )
}

/**
 * Native <dialog> as a paper sticker (or a bottom sheet). Esc, the close button and a backdrop click all call
 * onClose; the parent owns `open`.
 */
export function Modal({
  open,
  onClose,
  title,
  actions,
  sheet = false,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  actions?: ReactNode
  sheet?: boolean
  children?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className={cx('df-modal', sheet && 'df-sheet')}
      aria-labelledby={titleId}
      onClose={() => {
        if (open) onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="df-modal-body">
        <div className="df-modal-head">
          <h2 id={titleId} className="df-title">
            {title}
          </h2>
          <button type="button" className="df-btn df-btn-icon df-btn-sm" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 20 20" className="df-glyph" aria-hidden="true">
              <path d="M5 5 L15 15 M15 5 L5 15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
        {actions && <div className="df-modal-actions">{actions}</div>}
      </div>
    </dialog>
  )
}

/** A small paper sticker that slides up from the bottom (toast), or sits inline with `inline`. Null hides it. */
export function Notice({
  message,
  tone = 'info',
  icon,
  inline = false,
}: {
  message: ReactNode
  tone?: 'info' | 'error' | 'success'
  icon?: IconName
  inline?: boolean
}) {
  const body =
    message === null || message === undefined || message === false ? null : (
      <p
        key={typeof message === 'string' ? message : undefined}
        role="status"
        className={cx('df-notice', tone !== 'info' && `df-notice-${tone}`)}
      >
        {icon && <Icon name={icon} size="sm" cut="none" />}
        <span>{message}</span>
      </p>
    )
  if (inline) return body
  return (
    <div aria-live="polite" className="df-notice-region">
      {body}
    </div>
  )
}

/**
 * Page and section titles. variant "cut" is the big die-cut raspberry lettering ("The / Ballroom"),
 * "large" a bigger plain title. `kicker` is the italic storyteller line above it.
 */
export function Title({
  level = 1,
  variant = 'plain',
  kicker,
  id,
  className,
  children,
}: {
  level?: 1 | 2 | 3
  variant?: 'plain' | 'large' | 'cut'
  kicker?: ReactNode
  id?: string
  className?: string
  children: ReactNode
}) {
  const Heading = `h${level}` as const
  const heading = (
    <Heading
      id={id}
      className={cx(variant === 'cut' ? 'df-cut-letters' : 'df-title', variant === 'large' && 'df-title-lg', !kicker && className)}
    >
      {children}
    </Heading>
  )
  if (!kicker) return heading
  return (
    <hgroup className={cx('df-hgroup', className)}>
      <p className={cx('df-voice', variant === 'cut' && 'df-kicker')}>{kicker}</p>
      {heading}
    </hgroup>
  )
}

/** A player's token: a kit icon sticker, optionally on a gold medallion (picked), dimmed (off) or ticked. */
export function Token({
  icon,
  size = 'md',
  label,
  picked = false,
  off = false,
  tick = false,
  className,
}: {
  icon: IconName
  size?: 'sm' | 'md' | 'lg' | 'xl'
  label?: string
  picked?: boolean
  off?: boolean
  tick?: boolean
  className?: string
}) {
  return (
    <span
      className={cx('df-token', size !== 'md' && `df-token-${size}`, picked && 'df-token-picked', off && 'df-token-off', className)}
    >
      <Icon name={icon} cut="none" size="lg" label={label} />
      {tick && (
        <span className="df-token-tick" aria-hidden="true">
          <svg viewBox="0 0 12 12">
            <path d="M2 6.5 L5 9 L10 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </span>
  )
}

/** A four-point sparkle in currentColor, for glints on glass and paper. */
export function Sparkle({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="-13 -13 26 26" className={className} style={style} aria-hidden="true">
      <path d="M0,-13C2,-2 2,-2 13,0C2,2 2,2 0,13C-2,2 -2,2 -13,0C-2,-2 -2,-2 0,-13Z" fill="currentColor" />
    </svg>
  )
}

/** Gold corner ornaments framing the page (one SVG mirrored into each corner). */
export function Corners() {
  return (
    <div aria-hidden="true" className="df-corners">
      <span className="df-corner df-corner-tl" />
      <span className="df-corner df-corner-tr" />
      <span className="df-corner df-corner-bl" />
      <span className="df-corner df-corner-br" />
    </div>
  )
}
