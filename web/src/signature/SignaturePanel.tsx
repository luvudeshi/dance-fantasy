// Lobby panel (on unless ?signature=0): looks up the chosen song's viral dance. With a signature move
// it is pinned on every chorus; a known dance without one gets "Learn the real dance" links.

import { useEffect, useState } from 'react'
import type { PinnedMoveRequest } from '@shared/moves'
import type { SongChoice } from '../game/session'
import { errorMessage, isAbortError } from '../lib/errors'
import { readSongTags, titleFromFileName } from './id3'
import { inspiredBy, lookupSignature, pinsFor, safeLink, type SignatureLookup } from './dances'
import './dances.css'

const DEBOUNCE_MS = 450

type LookupState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'done'; result: SignatureLookup } | { kind: 'error'; message: string }

type Answer = { query: string } & ({ kind: 'done'; result: SignatureLookup } | { kind: 'error'; message: string })

function defaultTitle(choice: SongChoice | null): string {
  if (!choice) return ''
  return choice.kind === 'library' ? (choice.title ?? titleFromFileName(choice.file)) : titleFromFileName(choice.file.name)
}

export function SignaturePanel({ choice, onPins }: { choice: SongChoice | null; onPins: (pins: PinnedMoveRequest[]) => void }) {
  const [forChoice, setForChoice] = useState(choice)
  const [title, setTitle] = useState(() => defaultTitle(choice))
  const [artist, setArtist] = useState('')
  const [answer, setAnswer] = useState<Answer | null>(null)

  // A new song: its title from the library or the file name (then the upload's ID3 tag, below).
  if (choice !== forChoice) {
    setForChoice(choice)
    setTitle(defaultTitle(choice))
    setArtist('')
  }

  useEffect(() => {
    if (choice?.kind !== 'upload') return
    let live = true
    void readSongTags(choice.file).then((tags) => {
      if (!live) return
      if (tags.title) setTitle(tags.title)
      if (tags.artist) setArtist(tags.artist)
    })
    return () => {
      live = false
    }
  }, [choice])

  const query = title.trim() ? `${title.trim()}\n${artist.trim()}` : ''
  // Library songs are known to the server, so their own title may also be searched online.
  const songFile = choice?.kind === 'library' ? choice.file : undefined
  useEffect(() => {
    onPins([])
    if (!query) return
    const ac = new AbortController()
    const timer = window.setTimeout(() => {
      const [t, a] = query.split('\n')
      lookupSignature(t, a, ac.signal, songFile ? { file: songFile } : undefined).then(
        (result) => {
          setAnswer({ query, kind: 'done', result })
          onPins(pinsFor(result))
        },
        (err: unknown) => {
          if (!isAbortError(err)) setAnswer({ query, kind: 'error', message: errorMessage(err) })
        },
      )
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      ac.abort()
    }
  }, [query, onPins, songFile])

  const state: LookupState = !query ? { kind: 'idle' } : answer?.query === query ? answer : { kind: 'loading' }

  return (
    <section className="mb-sig-panel" aria-label="Signature dance">
      <div className="mb-sig-head">
        <span className="mb-sig-star" aria-hidden="true">
          ★
        </span>
        <strong>Signature dance</strong>
        <span className="dim">famous songs get their viral dance on the chorus</span>
      </div>
      <div className="mb-sig-fields">
        <label>
          <span className="field-label">Song title</span>
          <input type="text" value={title} placeholder="e.g. Y.M.C.A." onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </label>
        <label>
          <span className="field-label">Artist (optional)</span>
          <input type="text" value={artist} placeholder="e.g. Village People" onChange={(e) => setArtist(e.target.value)} maxLength={200} />
        </label>
      </div>
      <SignatureResult state={state} />
    </section>
  )
}

function SignatureResult({ state }: { state: LookupState }) {
  if (state.kind === 'idle') return <p className="dim mb-sig-note">Pick or upload a song, or type its title.</p>
  if (state.kind === 'loading') return <p className="dim mb-sig-note">Looking for a signature dance…</p>
  if (state.kind === 'error') return <p className="dim mb-sig-note">Couldn’t look up a signature dance ({state.message}). The routine is unchanged.</p>
  const r = state.result
  if (!r.found || !r.danceName) {
    return (
      <>
        <p className="dim mb-sig-note">No famous dance found for “{r.title}”. You get an original routine.</p>
        {r.configured === false && <p className="dim mb-sig-note">Online search isn’t set up on this server, so only the built-in dances are known.</p>}
        <Links result={r} heading="Search results" />
      </>
    )
  }
  const credit = r.creator ? `, created by ${r.creator}` : ''
  if (r.moveId) {
    return (
      <>
        <p className="mb-sig-pinned">
          ★ <strong>{r.moveName ?? r.danceName}</strong> ({inspiredBy(r.danceName)}
          {credit}) lands on every chorus. Its points count double!
        </p>
        <Links result={r} heading="Watch the real dance" />
      </>
    )
  }
  return (
    <div className="mb-sig-learn">
      <p>
        <strong>Learn the real dance:</strong> {r.danceName}
        {credit}
        {r.year ? ` (${r.year})` : ''}
      </p>
      <p className="dim mb-sig-note">We don’t have a move for it yet, so your routine is original.</p>
      <Links result={r} heading="Videos" />
    </div>
  )
}

function Links({ result, heading }: { result: SignatureLookup; heading: string }) {
  const links = result.links.flatMap((l) => {
    const href = safeLink(l.url)
    return href ? [{ ...l, href }] : []
  })
  if (links.length === 0) return null
  return (
    <div className="mb-sig-links">
      <span className="field-label">{heading}</span>
      <ul>
        {links.map((l) => (
          <li key={l.href}>
            <a href={l.href} target="_blank" rel="noopener noreferrer">
              {l.thumbnail && <img className="mb-sig-thumb" src={l.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />}
              {l.title}
            </a>{' '}
            <span className="dim">· {l.source}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
