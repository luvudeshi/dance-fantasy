import { useState, type CSSProperties } from 'react'
import { Badge, Button, Card, Corners, Modal, Notice, Panel, Segmented, Slider, Sparkle, Title, Toggle, Token } from './components'
import { Icon } from './Icon'
import { ICON_NAMES } from './icons'
import './styleguide.css'

// Dev page (#/ui): every Dance Fantasy component, class and icon, composed the way screens should use them.

const SWATCHES = [
  ['paper', 'Sticker cream'],
  ['ground', 'Toned paper'],
  ['ground-deep', 'Deep paper'],
  ['cut', 'Die-cut white'],
  ['parchment', 'Parchment'],
  ['ink', 'Ink'],
  ['ink-soft', 'Ink soft'],
  ['gold', 'Antique gold'],
  ['gold-light', 'Gold light'],
  ['gold-shade', 'Gold shade'],
  ['gold-text', 'Gold text'],
  ['blue', 'Powder blue'],
  ['blue-light', 'Blue light'],
  ['blue-deep', 'Blue deep'],
  ['night', 'Mirror night'],
  ['glass', 'Silver glass'],
  ['sage', 'Sage'],
  ['sage-deep', 'Sage deep'],
  ['rasp', 'Raspberry'],
  ['rasp-deep', 'Raspberry deep'],
  ['burg', 'Burgundy'],
] as const

const DIFFICULTY = [
  { value: 'easy', label: 'Gentle' },
  { value: 'normal', label: 'Lively' },
  { value: 'hard', label: 'Wild' },
] as const

const TABS = [
  { id: 'songs', label: 'Songs', icon: 'music-note' },
  { id: 'dancers', label: 'Dancers', icon: 'party' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
] as const

const BOARD = [
  { name: 'Aurora', role: 'the eldest princess', icon: 'crown', score: 9820, medal: '' },
  { name: 'Ella', role: 'the glass slipper', icon: 'slipper', score: 8410, medal: 'df-medal-silver' },
  { name: 'Rapunzel', role: 'the tower dancer', icon: 'clock-tower', score: 7275, medal: 'df-medal-rasp' },
] as const

const swatch = (name: string): CSSProperties => ({ background: `var(--df-${name})` })

export default function StyleGuide() {
  const [demo, setDemo] = useState(true)
  const [mirror, setMirror] = useState(false)
  const [volume, setVolume] = useState(70)
  const [speed, setSpeed] = useState(1)
  const [difficulty, setDifficulty] = useState<(typeof DIFFICULTY)[number]['value']>('normal')
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('songs')
  const [chips, setChips] = useState<string[]>(['Waltz'])
  const [modal, setModal] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [name, setName] = useState('')

  const showToast = (msg: string): void => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600)
  }

  return (
    <div className="df-screen sg">
      <Corners />
      <div className="df-twinkles" aria-hidden="true" />
      <div className="df-container df-stack" style={{ '--df-gap': '40px' } as CSSProperties}>
        <header className="df-topbar">
          <span className="df-brand">
            Dance <b>Fantasy</b>
          </span>
          <div className="df-cluster" style={{ '--df-gap': '12px' } as CSSProperties}>
            <span className="df-badge df-badge-gold">Song 3 of 12</span>
            <span className="df-code-chip" aria-label="Ballroom XQ7M">
              <small aria-hidden="true">Ballroom</small>
              <span className="df-foil" aria-hidden="true">
                XQ7M
              </span>
            </span>
            <Button variant="icon" icon="gear" aria-label="Settings" onClick={() => showToast('Settings would open here.')} />
          </div>
        </header>

        {/* hero: the magic mirror (webcam) beside the die-cut title */}
        <section className="sg-hero">
          <div className="df-mirror sg-cam">
            <img className="df-mirror-crest" src="/art/storybook/crest.svg" alt="" />
            <div className="df-mirror-glass df-mirror-night df-mirror-glare sg-cam-glass">
              <Sparkle className="df-twinkle sg-glint" />
              <p className="df-voice" style={{ color: 'var(--df-on-night)' }}>
                Mirror, mirror, who dances best?
              </p>
              <Icon name="mirror-cam" size="lg" />
              <p className="df-note" style={{ color: 'var(--df-on-night-soft)' }}>
                Your camera appears in the glass
              </p>
            </div>
          </div>
          <div className="df-stack">
            <Title variant="cut" kicker="The">
              Ballroom
            </Title>
            <p className="df-lede">
              The twelve princesses slip out at midnight to dance. Follow their steps in the magic mirror before the clock
              strikes twelve.
            </p>
            <div className="df-cluster" style={{ '--df-gap': '16px 20px' } as CSSProperties}>
              <Button size="lg" icon="sparkles">
                Begin the dance
              </Button>
              <Button variant="secondary" icon="upload">
                Bring a song
              </Button>
              <Button variant="ghost">Learn the steps first</Button>
            </div>
            <p className="df-voice">When the clock strikes twelve, the spell breaks.</p>
          </div>
        </section>

        <div className="sg-grid">
          <Panel title="Buttons" kicker="Figtree 800 on die-cut pills" sticker="wand">
            <div className="df-cluster">
              <Button>Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button disabled>Disabled</Button>
            </div>
            <div className="df-cluster">
              <Button size="sm" icon="sparkles">
                Small
              </Button>
              <Button size="sm" variant="secondary">
                Small quiet
              </Button>
              <Button variant="icon" icon="play" aria-label="Play" />
              <Button variant="icon" icon="pause" aria-label="Pause" />
              <Button variant="icon" size="sm" icon="chat" aria-label="Chat" />
            </div>
            <Button block icon="trophy">
              Block button
            </Button>
          </Panel>

          <Panel title="Type" kicker="Fraunces for the story, Figtree for the UI">
            <p className="df-voice">The storyteller&rsquo;s voice (.df-voice)</p>
            <Title level={2}>A plain Title, level 2</Title>
            <Title level={3} variant="large">
              Large title
            </Title>
            <p className="df-lede">Lede: one or two calm sentences under a title.</p>
            <p className="df-dropcap">
              Once upon a midnight, twelve princesses wore their slippers to ribbons. Nobody knew where they danced, until a
              soldier followed them through the mirror.
            </p>
            <p className="df-note">
              Note text, and numbers in <span className="df-num">12,480</span> lining figures.
            </p>
          </Panel>

          <Panel title="Chips & badges" sticker="sparkles">
            <span className="df-label">Pick the dances (chips, aria-pressed)</span>
            <div className="df-cluster">
              {['Waltz', 'Polka', 'Minuet', 'Galop'].map((c) => (
                <button
                  key={c}
                  type="button"
                  className="df-chip"
                  aria-pressed={chips.includes(c)}
                  onClick={() => setChips((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]))}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="df-cluster">
              <Badge>Paper</Badge>
              <Badge tone="gold" icon="crown">
                Best
              </Badge>
              <Badge tone="rasp">Live</Badge>
              <Badge tone="sage">Easy</Badge>
              <Badge tone="blue">Seated</Badge>
              <Badge tone="night">x3 combo</Badge>
            </div>
          </Panel>

          <Panel title="Controls" kicker="native inputs, sticker skins">
            <Toggle checked={demo} onChange={setDemo} label="Practice dancers" hint="Adds three princesses to dance with" />
            <Toggle checked={mirror} onChange={setMirror} label="Mirror the camera" />
            <Slider label="Music volume" value={volume} onChange={setVolume} format={(v) => `${v}%`} />
            <Slider label="Tempo" value={speed} min={0.5} max={1.5} step={0.05} onChange={setSpeed} format={(v) => `${v.toFixed(2)}x`} />
            <span className="df-label">Difficulty (Segmented)</span>
            <Segmented label="Difficulty" value={difficulty} options={DIFFICULTY} onChange={setDifficulty} />
            <span className="df-label">Tabs</span>
            <div className="df-tabs" role="tablist" aria-label="Library">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" className="df-tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                  <Icon name={t.icon} size="xs" cut="none" />
                  {t.label}
                </button>
              ))}
            </div>
            <label className="df-label" htmlFor="sg-name">
              Your name
            </label>
            <input id="sg-name" className="df-field" placeholder="What the court calls you" value={name} onChange={(e) => setName(e.target.value)} />
            <select className="df-field" aria-label="Song" defaultValue="b">
              <option value="a">Waltz of the Flowers</option>
              <option value="b">The Midnight Galop</option>
            </select>
          </Panel>

          <Panel title="Surfaces">
            <div className="df-cluster" style={{ alignItems: 'stretch' }}>
              <Card style={{ flex: '1 1 10rem' }}>
                <strong className="df-display">.df-card</strong>
                <p className="df-note">Large die-cut paper.</p>
              </Card>
              <Card size="sm" style={{ flex: '1 1 8rem' }}>
                <strong className="df-display">.df-card-sm</strong>
                <p className="df-note">Smaller cut.</p>
              </Card>
            </div>
            <div className="df-scroll">
              <dl className="df-dl">
                <dt>Songs</dt>
                <dd>12</dd>
                <dt>Round length</dt>
                <dd>90s</dd>
                <div className="df-rule" aria-hidden="true" />
                <dt>Judging</dt>
                <dd>Fair</dd>
              </dl>
            </div>
            <div className="df-plate">
              <p className="df-voice">Your score tonight</p>
              <span className="df-foil">9,820</span>
            </div>
          </Panel>

          <Panel title="Ribbons, medals, tokens" sticker="crown">
            <div className="df-cluster">
              <span className="df-ribbon-wrap">
                <span className="df-ribbon">Perfect step!</span>
              </span>
              <span className="df-ribbon-wrap">
                <span className="df-ribbon df-ribbon-gold">The real princess</span>
              </span>
              <span className="df-ribbon-wrap">
                <span className="df-ribbon df-ribbon-burg">Missed it</span>
              </span>
              <span className="df-ribbon-wrap">
                <span className="df-ribbon df-ribbon-ui">Your pick</span>
              </span>
            </div>
            <div className="df-cluster" style={{ '--df-gap': '18px' } as CSSProperties}>
              <span className="df-medal">1</span>
              <span className="df-medal df-medal-silver">2</span>
              <span className="df-medal df-medal-rasp">3</span>
              <span className="df-medal df-medal-sm">A</span>
              <span className="df-seal">
                <span>+100</span>
              </span>
            </div>
            <div className="df-cluster" style={{ '--df-gap': '20px' } as CSSProperties}>
              <Token icon="slipper" size="sm" />
              <Token icon="crown" tick />
              <Token icon="frog-prince" picked label="Frog prince" />
              <Token icon="wolf" off />
              <figure className="df-stack" style={{ '--df-gap': '8px', alignItems: 'center', margin: 0 } as CSSProperties}>
                <Token icon="potion" />
                <figcaption className="df-tag">
                  <span className="df-tag-name">Maya</span>
                  <span className="df-tag-role">the witch</span>
                </figcaption>
              </figure>
            </div>
          </Panel>

          <Panel title="Leaderboard rows" kicker=".df-list / .df-item">
            <ol className="df-list">
              {BOARD.map((p, i) => (
                <li key={p.name} className="df-item" aria-current={i === 0 ? true : undefined}>
                  <span className={`df-medal df-medal-sm ${p.medal}`}>{i + 1}</span>
                  <Icon name={p.icon} className="df-item-icon" cut="sm" />
                  <span className="df-item-body">
                    <span className="df-item-title">{p.name}</span>
                    <span className="df-item-meta">{p.role}</span>
                  </span>
                  <span className="df-item-end">{p.score.toLocaleString()}</span>
                </li>
              ))}
            </ol>
            <button type="button" className="df-item">
              <Icon name="upload" className="df-item-icon" cut="sm" />
              <span className="df-item-body">
                <span className="df-item-title">Bring your own song</span>
                <span className="df-item-meta">an interactive row (button.df-item)</span>
              </span>
              <span className="df-item-end" aria-hidden="true">
                &rsaquo;
              </span>
            </button>
          </Panel>

          <Panel title="Notices & dialogs" sticker="scroll">
            <Notice inline message="Inline notice: the music is loading." icon="music-note" />
            <Notice inline tone="error" message="We can't see you. Step back into the mirror." />
            <Notice inline tone="success" message="Saved to your storybook." />
            <div className="df-cluster">
              <Button variant="secondary" size="sm" onClick={() => showToast('A toast slides up from the bottom.')}>
                Show toast
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setModal(true)}>
                Open modal
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setSheet(true)}>
                Open sheet
              </Button>
            </div>
          </Panel>

          <Panel title="Motion" kicker="out-quint, and nothing when reduced motion is on">
            <div className="df-cluster" style={{ '--df-gap': '28px' } as CSSProperties}>
              <Icon name="clock-tower" size="lg" className="df-bob" />
              <Icon name="sparkles" size="md" className="df-twinkle" />
              <Icon name="dance-shoe" size="lg" className="df-pop-in" />
            </div>
          </Panel>
        </div>

        <Panel title="Palette" kicker="var(--df-*)">
          <div className="df-grid" style={{ '--df-min': '9rem', '--df-gap': '14px' } as CSSProperties}>
            {SWATCHES.map(([token, label]) => (
              <div key={token} className="sg-swatch">
                <span className="df-st-sm" style={swatch(token)} />
                <b>{label}</b>
                <code>--df-{token}</code>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Icons" kicker={`${ICON_NAMES.length} stickers in /art/icons`}>
          <div className="df-grid" style={{ '--df-min': '7rem', '--df-gap': '18px 10px' } as CSSProperties}>
            {ICON_NAMES.map((n) => (
              <figure key={n} className="sg-icon">
                <Icon name={n} size="md" />
                <figcaption>{n}</figcaption>
              </figure>
            ))}
          </div>
        </Panel>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Leave the ball?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setModal(false)}>
              Keep dancing
            </Button>
            <Button onClick={() => setModal(false)}>Leave</Button>
          </>
        }
      >
        <p className="df-lede">Your steps so far are saved in the storybook.</p>
      </Modal>
      <Modal open={sheet} onClose={() => setSheet(false)} title="Pick a song" sheet>
        <div className="df-list">
          {['Waltz of the Flowers', 'The Midnight Galop', 'Your own song'].map((s, i) => (
            <button key={s} type="button" className="df-item" onClick={() => setSheet(false)}>
              <Icon name={i === 2 ? 'upload' : 'music-note'} className="df-item-icon" cut="sm" />
              <span className="df-item-body">
                <span className="df-item-title">{s}</span>
              </span>
            </button>
          ))}
        </div>
      </Modal>
      <Notice message={toast} />
    </div>
  )
}
