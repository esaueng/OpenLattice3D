import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { startUnresponsiveWatchdog } from './analytics'

// Idle unless the current analytics grant is saved; see docs/glimpse.md.
startUnresponsiveWatchdog()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
