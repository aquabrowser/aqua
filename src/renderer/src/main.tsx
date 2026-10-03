import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { modalLayer, popupLayer, statusLayer } from './lib/overlay'
import { bootstrapStores } from './store'
import './styles/tokens.css'
import './styles/base.css'
import './styles/chrome.css'
import './styles/popups.css'
import './styles/dialogs.css'
import './styles/pages.css'

/** The main process passes the theme in the URL hash so the very first paint is right. */
function applyThemeHint(): void {
  const hint = new URLSearchParams(location.hash.slice(1))
  const root = document.documentElement
  const theme = hint.get('theme')
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme
  const dark = hint.get('dark')
  if (dark === 'midnight' || dark === 'slate') root.dataset.dark = dark
}

async function start(): Promise<void> {
  applyThemeHint()
  await bootstrapStores()
  // Open the overlay layers up front so the first menu or dialog appears instantly.
  popupLayer.container()
  modalLayer.container()
  statusLayer.container()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

start().catch((err: unknown) => {
  console.error('[aqua] UI failed to start', err)
  document.body.textContent = 'Aqua could not start its interface. Check the logs for details.'
})
