import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './theme/tokens.css'
import './theme/base.css'
import './theme/sticker.css'
import './theme/controls.css'
import './theme/pieces.css'
import './theme/screens/index.css'
import App from './App.tsx'
import { StickerDefs } from './theme/StickerDefs'

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing from index.html')

createRoot(root).render(
  <StrictMode>
    <StickerDefs />
    <App />
  </StrictMode>,
)
