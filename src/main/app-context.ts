import type { Rectangle, Session } from 'electron'
import type { BrowserWindowController } from './browser/window-controller'
import type { Services } from './services'
import type { ProfileService } from './services/profiles'
import type { SessionWindow } from './services/session'

export interface WindowOptions {
  /** Restore a saved window (tabs are created lazily). */
  restore?: SessionWindow
  /** URLs to open as tabs; defaults to a single New Tab page. */
  urls?: string[]
  bounds?: Rectangle | null
  maximized?: boolean
  /**
   * The first window of a launch: it opens empty behind the lock screen and
   * the app fills it with the startup pages once the vault is unlocked.
   */
  startup?: boolean
  /** A private window, with its own in-memory session. */
  private?: boolean
}

/** What window controllers need from the application shell. */
export interface AppContext {
  readonly services: Services
  /** Isolated, cookie-less session used only by trusted browser UI. */
  readonly uiSession: Session
  readonly preloadPath: string
  /** The profiles, and which one (or a guest session) this process runs. */
  readonly profiles: ProfileService
  uiUrl(): string
  isQuitting(): boolean
  openWindow(options?: WindowOptions): BrowserWindowController
  /** A guest window: a new window in a guest session, or the guest session's process started. */
  openGuest(): void
  windows(): BrowserWindowController[]
  /** Something persisted in the session file changed. */
  sessionChanged(): void
  windowClosing(controller: BrowserWindowController): void
  /** A window that was closing stays open after all (a page's "Leave site?" was answered Stay). */
  windowCloseCancelled(): void
  windowClosed(controller: BrowserWindowController): void
}
