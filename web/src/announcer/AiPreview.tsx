// Dev page (#/ai): the herald and the signature-dance card against the real API, outside the game.

import { useState, type CSSProperties } from 'react'
import type { ResultsSummary } from '../game/scoring'
import { SignatureCard } from '../signature/SignatureCard'
import { Badge, Button, Corners, Panel, Title } from '../theme/components'
import { useAnnouncer } from './announcer'
import { AnnouncerToggles, HeraldBubble } from './Herald'

/** A made-up round for the "results" buttons (only the fields the herald reads matter). */
function sampleSummary(perfect: boolean): ResultsSummary {
  const move = (name: string, avgScore: number) => ({ moveIndex: 0, id: name, name, avgScore, checkpoints: 4 })
  return {
    state: {
      score: perfect ? 12840 : 9820,
      combo: 0,
      maxCombo: perfect ? 57 : 34,
      counts: { perfect: perfect ? 50 : 38, good: perfect ? 7 : 12, ok: perfect ? 0 : 5, miss: perfect ? 0 : 2 },
      stars: perfect ? 5 : 4.2,
      judged: 57,
      total: 57,
    },
    accuracy: perfect ? 94 : 81,
    perMove: [],
    hardestMove: move('Disco Fever Left', 52),
    bestMove: move('Raise the Roof', 97),
  }
}

export default function AiPreview() {
  const announcer = useAnnouncer()
  const [song, setSong] = useState('Vibe Ace')
  const [started, setStarted] = useState<string | null>(null)
  const [lookup, setLookup] = useState({ title: 'Vibe Ace', artist: '' })
  const [title, setTitle] = useState(lookup.title)
  const [artist, setArtist] = useState(lookup.artist)

  const intro = (): void => {
    announcer.intro({ songTitle: song.trim() || 'Vibe Ace', playerName: 'Ella', difficulty: 'normal' })
    setStarted(song)
  }
  /** In-game moments need a song under way: start one quietly first. */
  const during = (run: () => void): void => {
    if (started !== song) intro()
    run()
  }

  return (
    <div className="df-screen">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="df-container df-stack" style={{ '--df-gap': '28px', paddingBlock: 24 } as CSSProperties}>
        <header className="df-topbar">
          <span className="df-brand">
            Dance <b>Fantasy</b>
          </span>
          <Badge tone="night">AI preview</Badge>
        </header>
        <Title variant="cut" kicker="Meet the">
          Herald
        </Title>
        <p className="df-lede">
          The royal herald cheers you on through the song (Meta Muse, Gemini, or the canned bank when no key is set), and the
          scribes look up a song’s famous dance on the web.
        </p>

        <Panel title="The royal herald" kicker="Fire a moment" sticker="crown">
          <div className="df-spread" style={{ alignItems: 'end' }}>
            <label className="df-stack" style={{ '--df-gap': '6px', alignItems: 'stretch' } as CSSProperties}>
              <span className="df-label">Song</span>
              <input className="df-field" value={song} onChange={(e) => setSong(e.target.value)} />
            </label>
            <AnnouncerToggles />
          </div>
          <div className="df-cluster" style={{ justifyContent: 'flex-start' }}>
            <Button icon="crown" onClick={intro}>
              Intro
            </Button>
            <Button variant="secondary" icon="sparkles" onClick={() => during(() => announcer.onResults([{ combo: 10 }], 9))}>
              Combo ×10
            </Button>
            <Button variant="secondary" icon="sparkles" onClick={() => during(() => announcer.onResults([{ combo: 25 }], 24))}>
              Combo ×25
            </Button>
            <Button variant="secondary" icon="slipper" onClick={() => during(() => announcer.onResults([{ combo: 0 }], 14))}>
              Streak broken
            </Button>
            <Button variant="secondary" icon="trophy" onClick={() => during(() => announcer.results(sampleSummary(false)))}>
              Results
            </Button>
            <Button variant="secondary" icon="crown" onClick={() => during(() => announcer.results(sampleSummary(true)))}>
              Perfect run
            </Button>
            <Button variant="ghost" onClick={() => announcer.hush()}>
              Hush
            </Button>
          </div>
          <HeraldBubble announcer={announcer} placement="inline" />
        </Panel>

        <form
          className="df-cluster"
          style={{ justifyContent: 'flex-start', alignItems: 'end' }}
          onSubmit={(e) => {
            e.preventDefault()
            setLookup({ title: title.trim(), artist: artist.trim() })
          }}
        >
          <label className="df-stack" style={{ '--df-gap': '6px', alignItems: 'stretch' } as CSSProperties}>
            <span className="df-label">Title</span>
            <input className="df-field" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label className="df-stack" style={{ '--df-gap': '6px', alignItems: 'stretch' } as CSSProperties}>
            <span className="df-label">Artist</span>
            <input className="df-field" value={artist} onChange={(e) => setArtist(e.target.value)} />
          </label>
          <Button type="submit" variant="secondary" icon="map">
            Look it up
          </Button>
        </form>
        <SignatureCard title={lookup.title} artist={lookup.artist} />
      </div>
    </div>
  )
}
