import { AccountChip } from '../account/AccountChip'
import { Icon } from '../theme/Icon'
import './shell.css'

/** The API server's state, as the header polls it (App.tsx useServerHealth). */
export interface ServerState {
  state: 'checking' | 'ok' | 'offline'
  /** API version or the failure reason (tooltip). */
  detail?: string
}

const LABEL = { checking: 'Checking…', ok: 'Online', offline: 'Server offline' } as const
const TONE = { checking: '', ok: 'df-badge-sage', offline: 'df-badge-rasp' } as const

/** A small badge: is the ball's server reachable? */
export function ServerStatus({ server }: { server: ServerState }) {
  return (
    <span className={`df-badge shell-status ${TONE[server.state]}`} title={server.detail} role="status">
      <span className={`shell-dot shell-dot-${server.state}`} aria-hidden="true" />
      <span className="shell-status-text">{LABEL[server.state]}</span>
    </span>
  )
}

/** Slim sticky sticker header on every screen but the title menu: brand, server status, back to the menu. */
export function ShellBar({ server, title }: { server: ServerState; title?: string }) {
  return (
    <header className="shell-bar">
      <div className="shell-bar-inner">
        <a className="df-brand shell-brand" href="#/" aria-label="Dance Fantasy: main menu">
          Dance <b>Fantasy</b>
        </a>
        {title && <span className="df-voice shell-where">{title}</span>}
        <div className="shell-bar-end">
          <ServerStatus server={server} />
          <AccountChip />
          <a className="df-btn df-btn-secondary df-btn-sm shell-menu-btn" href="#/">
            <Icon name="castle" size="xs" cut="none" />
            Menu
          </a>
        </div>
      </div>
    </header>
  )
}
