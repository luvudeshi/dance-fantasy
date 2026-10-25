// "Signature dance" card for a song: what the famous dance looks like, its key moments, the library moves
// that capture it and where that came from. Loading, not-configured (no keys), error (retry) and
// nothing-found states. Mount it with the song (its analysis id, or a library file) and its title.

import { useEffect, useState } from 'react'
import { useLatest } from '../lib/useLatest'
import { Badge, Button, Panel } from '../theme/components'
import { Icon } from '../theme/Icon'
import {
  formatMoment,
  loadMoveNames,
  loadSignature,
  moveNames,
  safeUrl,
  signatureKey,
  type Signature,
  type SignatureResult,
  type SignatureSong,
} from './signature'
import './signature.css'

interface Loaded {
  key: string
  result: SignatureResult
  names: ReadonlyMap<string, string>
}

export function SignatureCard({ song, title, className }: { song: SignatureSong; title: string; className?: string }) {
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const key = `${signatureKey(song)}\n${attempt}`
  const songRef = useLatest(song) // a fresh object every render; `key` names the song

  useEffect(() => {
    let live = true
    void loadSignature(songRef.current).then(async (result) => {
      const needsNames = result.status === 'ok' && result.signature.suggestedMoveIds.length > 0
      const names = needsNames ? await loadMoveNames() : new Map<string, string>()
      if (live) setLoaded({ key, result, names })
    })
    return () => {
      live = false
    }
  }, [key, songRef])

  const result = loaded?.key === key ? loaded.result : null
  const panelClass = `df-signature${className ? ` ${className}` : ''}`

  if (!result) {
    return (
      <Panel title="Signature dance" kicker="The scribes are searching…" className={panelClass} aria-busy="true">
        <div className="df-signature-wait">
          <Icon name="quill" size="sm" cut="sm" className="df-bob" />
          <p className="df-note">
            Looking up the famous steps of <strong>{title}</strong>…
          </p>
        </div>
      </Panel>
    )
  }

  // No search / AI keys on this server: no card at all (players never see setup notes).
  if (result.status === 'not-configured') return null

  if (result.status === 'error') {
    return (
      <Panel
        title="Signature dance"
        kicker="The scribes came back empty-handed"
        className={`${panelClass} is-quiet`}
        actions={
          <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        }
      >
        <p className="df-note">{result.message}</p>
      </Panel>
    )
  }

  return <SignatureView title={title} signature={result.signature} names={loaded?.names ?? new Map()} className={panelClass} />
}

function SignatureView({ title, signature, names, className }: { title: string; signature: Signature; names: ReadonlyMap<string, string>; className: string }) {
  const moves = moveNames(signature.suggestedMoveIds, names)
  const sources = signature.sources.flatMap((s) => {
    const link = safeUrl(s.link)
    return link ? [{ ...s, link, thumbnail: safeUrl(s.thumbnail, true) }] : []
  })
  return (
    <Panel
      title="Signature dance"
      kicker={signature.found ? `The famous steps of ${title}` : `No famous dance for ${title} (yet)`}
      sticker={signature.found ? 'dance-shoe' : undefined}
      className={className}
    >
      <p className="df-lede df-display">{signature.found ? signature.summary : `${signature.summary} The floor is yours to invent one!`}</p>

      {signature.found && signature.keyMoments.length > 0 && (
        <section className="df-stack df-signature-part" aria-label="Key moments">
          <h3 className="df-label">Key moments</h3>
          <ol className="df-list">
            {signature.keyMoments.map((m, i) => (
              <li key={`${i}-${m.label}`} className="df-item">
                <span className="df-medal df-medal-sm">{i + 1}</span>
                <span className="df-item-body">
                  <span className="df-item-title">{m.label}</span>
                </span>
                {formatMoment(m.approxTimeSec) && <span className="df-item-end">{formatMoment(m.approxTimeSec)}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {signature.found && moves.length > 0 && (
        <section className="df-stack df-signature-part" aria-label="Moves that capture it">
          <h3 className="df-label">Moves that capture it</h3>
          <ul className="df-cluster df-signature-moves">
            {moves.map((m) => (
              <li key={m.id}>
                <Badge tone="gold">{m.name}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sources.length > 0 && (
        <section className="df-stack df-signature-part" aria-label="Where the scribes looked">
          <h3 className="df-label">Where the scribes looked</h3>
          <ul className="df-signature-sources">
            {sources.map((s) => (
              <li key={s.link}>
                <a className="df-signature-source" href={s.link} target="_blank" rel="noopener noreferrer">
                  {s.thumbnail ? (
                    <img className="df-signature-thumb" src={s.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" width={96} height={54} />
                  ) : (
                    <span className="df-signature-thumb is-icon" aria-hidden="true">
                      <Icon name="scroll" size={36} cut="none" />
                    </span>
                  )}
                  <span className="df-signature-source-text">
                    <span className="df-signature-source-title">{s.title}</span>
                    <span className="df-signature-source-site">{s.source}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Panel>
  )
}
