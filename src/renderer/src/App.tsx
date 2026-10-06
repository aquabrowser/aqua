import { useEffect, useLayoutEffect, useState } from 'react'
import { BrowserChrome } from './chrome/BrowserChrome'
import { PromptLayer } from './chrome/PromptLayer'
import { StatusBubble } from './chrome/StatusBubble'
import { LockScreen } from './pages/LockScreen'
import { OnboardingSearch } from './pages/Onboarding'
import { env, popupStore, useSettings, useStore, vaultStore, windowStore } from './store'

/** Reserves space for the native window controls (Windows/Linux overlay, macOS traffic lights). */
function useCaptionInsets(): void {
  useLayoutEffect(() => {
    const style = document.documentElement.style
    if (env.platform === 'darwin') {
      style.setProperty('--traffic-w', '72px')
      style.setProperty('--caption-w', '8px')
      return
    }
    type Wco = EventTarget & { visible: boolean; getTitlebarAreaRect(): DOMRect }
    const wco = (navigator as Navigator & { windowControlsOverlay?: Wco }).windowControlsOverlay
    const update = (): void => {
      if (!wco) return style.setProperty('--caption-w', '138px')
      if (!wco.visible) return style.setProperty('--caption-w', '8px')
      const rect = wco.getTitlebarAreaRect()
      const right = window.innerWidth - (rect.x + rect.width)
      style.setProperty('--caption-w', `${Math.max(0, Math.round(right))}px`)
    }
    update()
    wco?.addEventListener('geometrychange', update)
    window.addEventListener('resize', update)
    return () => {
      wco?.removeEventListener('geometrychange', update)
      window.removeEventListener('resize', update)
    }
  }, [])
}

export function App() {
  const settings = useSettings()
  const vault = useStore(vaultStore)
  const focused = useStore(windowStore, (s) => s.focused)
  const maximized = useStore(windowStore, (s) => s.maximized)
  const isPrivate = useStore(windowStore, (s) => s.private)
  const locked = vault.state !== 'unlocked'
  // The welcome's last step, once a new vault is open (it resumes after a restart until done).
  const welcoming = !locked && !settings.onboardingCompleted

  useCaptionInsets()

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.platform = env.platform
    // "System" leaves the choice to `color-scheme: light dark`, which follows the OS live.
    // Private windows are always dark, so they can't be mistaken for regular ones.
    if (isPrivate) root.dataset.theme = 'dark'
    else if (settings.theme === 'system') delete root.dataset.theme
    else root.dataset.theme = settings.theme
    root.toggleAttribute('data-private', isPrivate)
    // What the taskbar and Alt+Tab show (the window takes its title from this page).
    const profile = env.profile
    const label = isPrivate
      ? 'Private'
      : profile.kind === 'guest'
        ? 'Guest'
        : profile.kind === 'profile'
          ? profile.name
          : null
    document.title = label ? `Aqua (${label})` : 'Aqua'
    if (settings.darkStyle === 'classic') delete root.dataset.dark
    else root.dataset.dark = settings.darkStyle
    root.classList.toggle('window-inactive', !focused)
    root.classList.toggle('maximized', maximized)
  }, [settings.theme, settings.darkStyle, focused, maximized, isPrivate])

  // Keep the lock screen mounted after unlocking for the length of its fade-out.
  const [lockMounted, setLockMounted] = useState(locked)
  useEffect(() => {
    if (locked) {
      setLockMounted(true)
      popupStore.set(null)
      return
    }
    const timer = window.setTimeout(() => setLockMounted(false), 420)
    return () => window.clearTimeout(timer)
  }, [locked])

  // The same for the welcome's search engine step.
  const [welcomeMounted, setWelcomeMounted] = useState(welcoming)
  useEffect(() => {
    if (welcoming) {
      setWelcomeMounted(true)
      return
    }
    const timer = window.setTimeout(() => setWelcomeMounted(false), 420)
    return () => window.clearTimeout(timer)
  }, [welcoming])

  const covered = locked || welcoming
  return (
    <>
      <BrowserChrome inert={covered} />
      {!covered && <PromptLayer />}
      {!covered && <StatusBubble />}
      {/* Under the lock screen, so the new vault's setup fades straight into it. */}
      {welcomeMounted && !locked && <OnboardingSearch leaving={!welcoming} />}
      {lockMounted && <LockScreen status={vault} leaving={!locked} />}
    </>
  )
}
