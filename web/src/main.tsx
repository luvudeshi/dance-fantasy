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
import { canvasFontsReady } from './theme/fonts'
import { StickerDefs } from './theme/StickerDefs'

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
