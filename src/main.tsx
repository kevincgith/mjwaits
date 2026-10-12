import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Offline support and installing to the home screen (see public/sw.js).
// Production only - in dev it would cache files that change on every save.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Not supported here (e.g. a private window) - the app works without it.
    })
  })
}

// The in-app splash (index.html), shown when opened from the home screen:
// held until at least 700ms after launch, so it reads as a splash and not a
// flicker, then faded out and removed. In a browser tab it's never shown.
const splash = document.getElementById('splash')
if (splash && getComputedStyle(splash).display !== 'none') {
  window.setTimeout(
    () => {
      splash.classList.add('is-done')
      window.setTimeout(() => splash.remove(), 400)
    },
    Math.max(0, 700 - performance.now()),
  )
} else {
  splash?.remove()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
