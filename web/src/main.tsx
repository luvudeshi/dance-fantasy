import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme/tokens.css'
import './theme/base.css'
import './theme/sticker.css'
import './theme/controls.css'
import './theme/pieces.css'
import './theme/screens/index.css'
import './theme/fonts.css'
import App from './App.tsx'
import { defaultStorage } from './lib/storage'
import { REEL_STORAGE_KEY } from './reel/flag'
import { canvasFontsReady } from './theme/fonts'
import { StickerDefs } from './theme/StickerDefs'

// The highlight reel is on by default: the first run stores "1" (Settings turns it off with "0").
try {
  const store = defaultStorage()
  if (store && store.getItem(REEL_STORAGE_KEY) === null) store.setItem(REEL_STORAGE_KEY, '1')
} catch (err) {
  console.warn('[reel] default not saved', err)
}

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing from index.html')

// Canvas text (HUD, cue cards, stage) needs Fraunces + Figtree loaded before its first frame.
void canvasFontsReady().then(() =>
  createRoot(root).render(
    <StrictMode>
      <StickerDefs />
      <App />
    </StrictMode>,
  ),
)
