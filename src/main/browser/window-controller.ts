import {
  app,
  BrowserWindow,
  screen,
  WebContentsView,
  type ContextMenuParams,
  type Input,
  type Rectangle,
  type Session,
  type WebContents,
  type WebPreferences
} from 'electron'
import { join } from 'path'
import type {
  CommandId,
  CreateTabOptions,
  NavigateOptions,
  FindState,
  OverlayPlacement,
  ProfileIdentity,
  OverlayRole,
  PromptRequest,
  PromptResponse,
  UiCommand,
  WindowState
} from '../../shared/types'
import type { EventMap } from '../../shared/ipc'
import { searchUrl } from '../../shared/search'
import { internalPageOf, isWebUrl, NEW_TAB_URL } from '../../shared/url'
import { classifyInput } from '../omnibox/classify'
import type { ProfileService } from '../services/profiles'
import type { AppContext, WindowOptions } from '../app-context'
import { Disposables, uid } from '../lib/signal'
import type { Services } from '../services'
import type { PromptPayload } from '../services/permissions'
import type { SessionTab, SessionWindow } from '../services/session'
import { currentPalette } from '../theme'
import { applyWebsiteAppearance } from './appearance'
import { showEditableContextMenu, showPageContextMenu, showUiContextMenu } from './menus'
import { resolveShortcut } from './shortcuts'
import { Tab, TAB_WEB_PREFERENCES, type OpenDisposition, type TabHost } from './tab'

/** Heights in DIP; multiples of 4 so every common scale factor lands on whole pixels. */
export const TAB_STRIP_HEIGHT = 40

/** "Aqua", or "Aqua (Private)", "Aqua (Guest)", "Aqua (Work)": what the taskbar and Alt+Tab show. */
function windowTitle(isPrivate: boolean, identity: ProfileIdentity): string {
  if (isPrivate) return 'Aqua (Private)'
  if (identity.kind === 'guest') return 'Aqua (Guest)'
  return identity.kind === 'profile' ? `Aqua (${identity.name})` : 'Aqua'
}
/** Width of the minimize / maximize / close buttons drawn by the title bar overlay. */
const CAPTION_BUTTONS_WIDTH = 138
const TOOLBAR_HEIGHT = 44
const BOOKMARKS_BAR_HEIGHT = 32
const MAX_CLOSED_TABS = 25
/** Bottom → top. */
const OVERLAY_ROLES: readonly OverlayRole[] = ['findbar', 'status', 'modal', 'popup']
/** A page cannot queue more prompts than this; further requests are denied. */
const MAX_PROMPTS_PER_TAB = 3
/** The link status bubble moves aside when the pointer comes this close to it. */
const STATUS_AVOID_MARGIN = 24

const isMac = process.platform === 'darwin'

/**
 * A packaged Aqua's taskbar and Alt+Tab icon is the one in its .exe (build/icon.ico, embedded by
 * electron-builder). Development runs the stock electron.exe, whose icon is Electron's: give the
 * window Aqua's instead. (The build folder isn't shipped, so this is development only.)
 */
const DEV_WINDOW_ICON = app.isPackaged || isMac ? undefined : join(app.getAppPath(), 'build', 'icon.ico')

interface ClosedTab {
  snapshot: SessionTab
  index: number
}

interface Overlay {
  view: WebContentsView
  /**
   * Kept alongside the view: once its contents are destroyed (UI reload, crash),
   * `view.webContents` reads as undefined.
   */
  contents: WebContents
  placement: OverlayPlacement | null
}

interface PendingPrompt {
  request: PromptRequest
  resolve: (response: PromptResponse | null) => void
}

type FocusIntent = 'content' | 'none'

/** The contents if they can still be used, otherwise null. */
function live(contents: WebContents | null | undefined): WebContents | null {
  return contents && !contents.isDestroyed() ? contents : null
}

/**
 * Owns one browser window: its tabs (order, activation, pinning, closed-tab
 * stack), the web view layout, the overlay layers stacked above web content,
 * HTML fullscreen and command dispatch.
 *
 * Z-order inside the window, bottom → top:
 *   UI renderer (window webContents) → tab views (index 0…n) → find bar →
 *   link status → tab-modal prompts → popups
 */
export class BrowserWindowController implements TabHost {
  readonly window: BrowserWindow
  readonly services: Services
  readonly id: number
  private readonly sessionOf: () => Session
  /** The private partition's name, or null for a regular window. */
  readonly partition: string | null
  readonly isPrivate: boolean

  /** Where this window's pages live: the regular profile, or a private window's in-memory partition. */
  get session(): Session {
    return this.sessionOf()
  }

  get webPreferences(): WebPreferences {
    return { ...TAB_WEB_PREFERENCES, session: this.session }
  }

  private tabs: Tab[] = []
  private activeId: string | null = null
  private previousActiveId: string | null = null
  private readonly closedTabs: ClosedTab[] = []
  private readonly closingSnapshots = new Map<string, ClosedTab>()
  /** Tabs whose page should take focus once their navigation commits (omnibox Enter). */
  private readonly focusOnCommit = new Set<string>()
  private readonly overlays = new Map<OverlayRole, Overlay>()
  private readonly attachedViews = new WeakSet<WebContentsView>()
  private readonly disposables = new Disposables()
  /** Tab-modal dialogs and bubbles, oldest first. */
  private prompts: PendingPrompt[] = []
  /** Tabs to open once the vault is unlocked (their data is encrypted until then). */
  private pendingInit: WindowOptions | null = null

  private contentTop: number
  /** Link target shown in the status bubble ('' = hidden). */
  private statusUrl = ''
  private htmlFullscreenTab: Tab | null = null
  private exitFullscreenOnLeave = false
  private stateScheduled = false
  /** UI messages that refer to the next state update, sent right after it. */
  private afterState: Array<() => void> = []
  private destroyed = false
  /**
   * Set while the window closes tab by tab so that every page can run beforeunload ("Leave
   * site?"), as Chrome does. `snapshot` is the window as it was when the close began (what the
   * session keeps); `closed` are the tabs gone so far, which come back if the user stays.
   */
  private windowClose: {
    snapshot: SessionWindow
    /** The tab being closed now, with where it was. */
    current: { tab: Tab; record: ClosedTab } | null
    closed: ClosedTab[]
  } | null = null
  /** The window may close now: its pages agreed, or the close must not wait (see beginWindowClose). */
  private closeConfirmed = false

  constructor(
    private readonly appContext: AppContext,
    options: WindowOptions,
    // A function: the regular session exists only once the encrypted profile has been unsealed.
    browsing: { session: () => Session; partition: string | null }
  ) {
    this.services = appContext.services
    this.sessionOf = browsing.session
    this.partition = browsing.partition
    this.isPrivate = browsing.partition !== null
    const settings = this.services.settings.get()
    const palette = currentPalette(settings, this.isPrivate)
    this.contentTop = TAB_STRIP_HEIGHT + TOOLBAR_HEIGHT + (settings.showBookmarksBar ? BOOKMARKS_BAR_HEIGHT : 0)

    const geometry =
      options.bounds !== undefined
        ? { bounds: options.bounds, maximized: !!options.maximized }
        : this.services.session.lastGeometry()
    const bounds = geometry.bounds

    this.window = new BrowserWindow({
      width: bounds?.width ?? 1280,
      height: bounds?.height ?? 840,
      ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: 480,
      minHeight: 320,
      show: false,
      title: windowTitle(this.isPrivate, appContext.profiles.identity()),
      ...(DEV_WINDOW_ICON ? { icon: DEV_WINDOW_ICON } : {}),
      backgroundColor: palette.frame,
      titleBarStyle: 'hidden',
      ...(isMac
        ? { trafficLightPosition: { x: 14, y: 13 } }
        : { titleBarOverlay: { color: palette.frame, symbolColor: palette.symbols, height: TAB_STRIP_HEIGHT } }),
      webPreferences: {
        preload: appContext.preloadPath,
        session: appContext.uiSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false
      }
    })
    this.id = this.window.id

    this.applyCaptureProtection()
    this.installWindowEvents(geometry.maximized)
    this.installUiGuards()

    // The startup window is filled by the app once the vault opens (startup
    // pages and the saved session are encrypted); other windows wait for it too.
    if (!options.startup) {
      if (this.services.vault.isOpen()) this.initTabs(options.restore ?? null, options.urls ?? [])
      else this.pendingInit = options
    }

    // Theme hint so the UI's first paint already uses the right palette.
    const hint = new URLSearchParams({
      theme: this.isPrivate ? 'dark' : settings.theme,
      ...(settings.darkStyle !== 'classic' ? { dark: settings.darkStyle } : {})
    })
    void this.window.webContents.loadURL(`${appContext.uiUrl()}#${hint}`)
  }

  /** Creates the window's first tabs: a restored session, then `urls`; a New Tab page if both are empty. */
  initTabs(restore: SessionWindow | null, urls: string[]): void {
    this.pendingInit = null
    if (this.destroyed) return
    for (const snapshot of restore?.tabs ?? []) this.insertTab(new Tab(this, { restore: snapshot }), this.tabs.length)
    const restoredActive = restore ? this.tabs[Math.min(restore.activeIndex, this.tabs.length - 1)] : undefined
    for (const url of urls) this.insertTab(new Tab(this, { url }), this.tabs.length)
    if (this.tabs.length === 0) this.insertTab(new Tab(this, { url: NEW_TAB_URL }), 0)
    const active = urls.length > 0 || !restoredActive ? this.tabs[this.tabs.length - 1] : restoredActive
    this.activate(active, this.window.isFocused() ? 'content' : 'none')
  }

  // ─── TabHost ───────────────────────────────────────────────────────────────

  contentBackground(): string {
    return currentPalette(this.services.settings.get(), this.isPrivate).content
  }

  isActive(tab: Tab): boolean {
    return tab.id === this.activeId
  }

  onTabChanged(tab: Tab): void {
    if (tab.id === this.activeId && tab.isClosing === false) this.syncViews()
    this.pushState()
  }

  onTabViewCreated(tab: Tab): void {
    const view = tab.contentView
    if (!view || this.attachedViews.has(view) || this.destroyed) return
    // Index 0 keeps every tab view below the overlay layers.
    this.window.contentView.addChildView(view, 0)
    this.attachedViews.add(view)
    view.setBounds(this.contentBounds())
    const wc = view.webContents
    applyWebsiteAppearance(wc, this.services.settings.get().websiteAppearance)
  }

  onTabCommitted(tab: Tab): void {
    if (tab.id !== this.activeId) return
    this.syncViews()
    this.pushFindState()
    if (this.focusOnCommit.delete(tab.id) && tab.showsWebContent) tab.webContents?.focus()
  }

  /**
   * Chromium hands focus to a frame when its navigation commits, even inside a
   * hidden view. A view that is not on screen must never own keyboard focus,
   * or keystrokes silently disappear into an invisible page.
   */
  /** The link (or other target) under the pointer changed in a tab's page. */
  onTabTargetUrl(tab: Tab, url: string): void {
    if (tab.id !== this.activeId || !this.services.vault.isOpen()) return
    this.showStatus(url)
  }

  private showStatus(url: string): void {
    if (url === this.statusUrl || this.destroyed) return
    this.statusUrl = url
    this.sendCommand({ type: 'status', url })
  }

  onTabFocus(tab: Tab): void {
    // Deferred: re-focusing synchronously inside Chromium's focus change is overridden.
    setTimeout(() => {
      if (this.destroyed || tab.isClosing) return
      const wc = tab.webContents
      const onScreen = this.services.vault.isOpen() && tab.id === this.activeId && tab.showsWebContent
      if (!onScreen && wc?.isFocused()) this.window.webContents.focus()
      // The page took focus (a click into it): the address bar lets go of its focus and selection.
      else if (onScreen) this.sendUi('ui:command', { type: 'page.focused' })
    }, 0)
  }

  onTabOpen(opener: Tab, url: string, disposition: OpenDisposition): void {
    const tab = new Tab(this, { url, openerId: opener.id })
    this.insertTab(tab, this.childInsertIndex(opener))
    if (disposition === 'foreground-tab') this.activate(tab, 'content')
    this.pushState()
  }

  onTabAdoptGuest(opener: Tab, guest: WebContents, disposition: OpenDisposition): void {
    const tab = new Tab(this, { guest, openerId: opener.id })
    this.insertTab(tab, this.childInsertIndex(opener))
    if (disposition === 'foreground-tab') this.activate(tab, 'content')
    this.pushState()
  }

  onTabFullscreen(tab: Tab, fullscreen: boolean): void {
    if (fullscreen) {
      this.htmlFullscreenTab = tab
      this.exitFullscreenOnLeave = !this.window.isFullScreen()
      this.window.setFullScreen(true)
      this.hideOverlays()
    } else if (this.htmlFullscreenTab === tab) {
      this.htmlFullscreenTab = null
      if (this.exitFullscreenOnLeave) this.window.setFullScreen(false)
      this.exitFullscreenOnLeave = false
    }
    this.layout()
    this.pushState()
  }

  onTabFindResult(tab: Tab): void {
    if (tab.id === this.activeId) this.pushFindState()
  }

  onTabContextMenu(tab: Tab, params: ContextMenuParams): void {
    showPageContextMenu(this, tab, params)
  }

  onTabKeyboard(_tab: Tab, input: Input): boolean {
    return this.handleKeyboard(input, 'page')
  }

  onTabCloseCancelled(tab: Tab): void {
    this.closingSnapshots.delete(tab.id)
    // Closing the window: it was hidden meanwhile; the page's question needs it back.
    if (this.windowClose) {
      this.window.show()
      this.window.focus()
    }
    this.activate(tab, 'content')
    this.pushState()
  }

  onTabCloseDeclined(tab: Tab): void {
    if (this.windowClose?.current?.tab === tab) this.abortWindowClose()
  }

  onTabClosed(tab: Tab): void {
    const index = this.tabs.indexOf(tab)
    if (index === -1) return
    this.tabs.splice(index, 1)
    this.focusOnCommit.delete(tab.id)
    this.cancelPrompts(tab)

    const recorded = this.closingSnapshots.get(tab.id)
    this.closingSnapshots.delete(tab.id)
    if (!this.destroyed && recorded && recorded.snapshot.url !== 'about:blank') {
      this.closedTabs.push(recorded)
      if (this.closedTabs.length > MAX_CLOSED_TABS) this.closedTabs.shift()
    }
    if (this.htmlFullscreenTab === tab) this.onTabFullscreen(tab, false)
    if (this.destroyed) return

    if (this.windowClose) {
      const { current } = this.windowClose
      if (current?.tab === tab) {
        this.windowClose.closed.push(current.record)
        this.windowClose.current = null
        this.closeNextTab()
      }
      this.pushState()
      return
    }

    const remaining = this.visibleTabs()
    if (remaining.length === 0) {
      if (!this.tabs.some((t) => t.isClosing)) this.window.close()
      return
    }
    if (this.activeId === tab.id) this.activate(this.pickNextActive(tab, index) ?? remaining[0], 'content')
    this.pushState()
  }

  // ─── Tab operations ────────────────────────────────────────────────────────

  get activeTab(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null
  }

  getTab(id: string): Tab | null {
    return this.tabs.find((t) => t.id === id && !t.isClosing) ?? null
  }

  findTabByWebContentsId(id: number): Tab | null {
    return this.tabs.find((t) => t.webContentsId === id && t.webContents !== null) ?? null
  }

  allTabs(): readonly Tab[] {
    return this.tabs
  }

  createTab(options: CreateTabOptions = {}): Tab {
    const url = options.url ?? NEW_TAB_URL
    const tab = new Tab(this, { url })
    const index = options.index ?? this.tabs.length
    this.insertTab(tab, index)
    if (!options.background) this.activate(tab, 'content')
    this.pushState()
    return tab
  }

  newTab(): void {
    // Activation focuses the omnibox for New Tab pages.
    this.createTab({ url: NEW_TAB_URL })
  }

  activate(tab: Tab, focus: FocusIntent): void {
    if (tab.isClosing) return
    const previous = this.activeTab
    if (previous && previous !== tab) {
      this.previousActiveId = previous.id
      if (this.htmlFullscreenTab === previous) {
        void previous.webContents
          ?.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true)
          .catch(() => undefined)
      }
    }
    this.activeId = tab.id
    // Whatever the previous page's pointer was over is no longer on screen.
    this.showStatus('')
    if (tab.isDiscarded && this.services.vault.isOpen()) tab.wake()
    this.syncViews()
    this.pushFindState()
    if (focus === 'content') this.focusContent()
    this.pushState()
  }

  closeTab(tab: Tab): void {
    if (tab.isClosing) return
    if (this.windowClose) {
      // The window is closing: only the tab whose "Leave site?" was just confirmed goes on.
      if (this.windowClose.current?.tab === tab) {
        this.window.hide()
        tab.close()
      }
      return
    }
    const index = this.tabs.indexOf(tab)
    this.closingSnapshots.set(tab.id, { snapshot: tab.snapshot(), index })
    if (this.visibleTabs().length <= 1) {
      // Closing the last tab closes the window, as in every mainstream browser.
      this.window.close()
      return
    }
    if (tab.id === this.activeId) {
      const next = this.pickNextActive(tab, index)
      if (next) this.activate(next, 'content')
    }
    const wc = tab.webContents
    if (wc && this.services.downloads.activeForSource(wc.id) > 0) tab.retire()
    else tab.close()
    this.pushState()
  }

  /** A retired tab's downloads finished: release its page now. */
  onDownloadSourceIdle(webContentsId: number): void {
    const tab = this.findTabByWebContentsId(webContentsId)
    if (tab?.isClosing) tab.destroy()
  }

  moveTab(tab: Tab, targetIndex: number): void {
    const from = this.tabs.indexOf(tab)
    if (from === -1) return
    this.tabs.splice(from, 1)
    const pinnedCount = this.tabs.filter((t) => t.pinned).length
    const [min, max] = tab.pinned ? [0, pinnedCount] : [pinnedCount, this.tabs.length]
    this.tabs.splice(Math.max(min, Math.min(max, targetIndex)), 0, tab)
    this.pushState()
  }

  setPinned(tab: Tab, pinned: boolean): void {
    if (tab.pinned === pinned) return
    const from = this.tabs.indexOf(tab)
    this.tabs.splice(from, 1)
    tab.pinned = pinned
    const pinnedCount = this.tabs.filter((t) => t.pinned).length
    // Pinning appends to the pinned group; unpinning puts the tab first among unpinned tabs.
    this.tabs.splice(pinnedCount, 0, tab)
    this.pushState()
  }

  duplicate(tab: Tab): void {
    const snapshot = tab.snapshot()
    const copy = new Tab(this, { restore: { ...snapshot, pinned: tab.pinned } })
    this.insertTab(copy, this.tabs.indexOf(tab) + 1)
    this.activate(copy, 'content')
  }

  reopenClosedTab(): void {
    const closed = this.closedTabs.pop()
    if (!closed) return
    const tab = new Tab(this, { restore: closed.snapshot })
    this.insertTab(tab, closed.index)
    this.activate(tab, 'content')
  }

  closeOtherTabs(keep: Tab): void {
    for (const tab of [...this.tabs]) if (tab !== keep && !tab.pinned) this.closeTab(tab)
  }

  closeTabsToRight(anchor: Tab): void {
    const index = this.tabs.indexOf(anchor)
    for (const tab of this.tabs.slice(index + 1)) this.closeTab(tab)
  }

  /** Focuses an existing tab showing `url`'s internal page, or opens one. */
  openInternal(url: string): void {
    const page = internalPageOf(url)
    const existing = this.tabs.find((t) => !t.isClosing && internalPageOf(t.currentUrl) === page)
    if (existing) this.activate(existing, 'content')
    else this.createTab({ url })
  }

  /** Omnibox submission: classify the text, then load / search / hand off externally. */
  goFromOmnibox(input: string, options: NavigateOptions = {}): void {
    const classified = classifyInput(input, { ctrlEnter: options.ctrlEnter })
    if (classified.type === 'search' && !classified.query) return
    if (classified.type === 'external') {
      void this.activeTab?.openExternal(classified.url, 'user')
      return
    }
    const url =
      classified.type === 'search'
        ? searchUrl(this.services.settings.get().searchEngine, classified.query)
        : classified.url
    switch (options.disposition ?? 'current') {
      case 'new-tab': {
        const tab = this.createTab({ url })
        this.focusOnCommit.add(tab.id)
        return
      }
      case 'background-tab':
        this.createTab({ url, background: true })
        return
      case 'new-window':
        this.openInNewWindow(url)
        return
      default:
        this.navigateActive(url, true)
    }
  }

  openInNewWindow(url: string): void {
    this.appContext.openWindow({ urls: [url], private: this.isPrivate })
  }

  openInPrivateWindow(url: string): void {
    this.appContext.openWindow({ urls: [url], private: true })
  }

  /** Opens `url` next to `from` the way a link click would. Web addresses only (see `isWebUrl`). */
  openFromTab(from: Tab, url: string, background: boolean): void {
    if (!isWebUrl(url)) return
    this.onTabOpen(from, url, background ? 'background-tab' : 'foreground-tab')
  }

  get canReopenClosedTab(): boolean {
    return this.closedTabs.length > 0
  }

  navigateActive(url: string, typed: boolean, bookmark = false): void {
    const tab = this.activeTab
    if (!tab) return
    tab.load(url, { typed, bookmark })
    this.focusOnCommit.add(tab.id)
    this.activate(tab, 'content')
  }

  // ─── Layout & views ────────────────────────────────────────────────────────

  setContentTop(top: number): void {
    const next = Math.round(top)
    if (next === this.contentTop) return
    this.contentTop = next
    this.layout()
  }

  focusContent(): void {
    const tab = this.activeTab
    if (!tab) return
    if (tab.showsWebContent && this.services.vault.isOpen()) {
      tab.webContents?.focus()
    } else {
      this.window.webContents.focus()
      if (internalPageOf(tab.currentUrl) === 'newtab') this.sendUiAfterState('ui:command', { type: 'omnibox.focus' })
    }
  }

  /** Recomputes which web view is visible. Everything else is hidden. */
  syncViews(): void {
    if (this.destroyed) return
    const open = this.services.vault.isOpen()
    const active = this.activeTab
    if (active && open) this.onTabViewCreated(active)
    this.layout()
    // Pages draw above the UI: none may cover the lock screen or the first-run welcome.
    const shown = open && this.services.settings.get().onboardingCompleted
    for (const tab of this.tabs) tab.setVisible(shown && tab === active && tab.showsWebContent && !tab.isClosing)
    if (!open) this.hideOverlays()
  }

  layout(): void {
    if (this.destroyed || this.window.isMinimized()) return
    const bounds = this.contentBounds()
    if (bounds.width <= 0 || bounds.height <= 0) return
    this.activeTab?.setBounds(bounds)
    for (const role of OVERLAY_ROLES) this.applyOverlay(role)
  }

  /**
   * Settings → Privacy → Hide from screen capture: screenshots, recordings and screen sharing (OBS,
   * Discord, Teams …) show nothing where this window is. Windows' WDA_EXCLUDEFROMCAPTURE
   * (Windows 10 2004 and later; earlier versions capture a black window), macOS' sharingType none.
   */
  /** The profiles, and which one (or a guest session) this window belongs to. */
  get profiles(): ProfileService {
    return this.appContext.profiles
  }

  applyCaptureProtection(): void {
    if (!this.destroyed) this.window.setContentProtection(this.services.settings.get().hideFromCapture)
  }

  /** Re-applies the website appearance setting to every open page. */
  applyWebsiteAppearance(): void {
    const mode = this.services.settings.get().websiteAppearance
    for (const tab of this.tabs) {
      const wc = tab.webContents
      if (wc) applyWebsiteAppearance(wc, mode)
    }
  }

  private contentBounds(): Rectangle {
    const [width, height] = this.window.getContentSize()
    const top = this.htmlFullscreenTab ? 0 : Math.min(this.contentTop, height)
    return { x: 0, y: top, width, height: Math.max(0, height - top) }
  }

  // ─── Overlays ──────────────────────────────────────────────────────────────

  showOverlay(role: OverlayRole, placement: OverlayPlacement, focus: boolean): void {
    const overlay = this.overlays.get(role)
    if (!overlay) return
    overlay.placement = placement
    this.applyOverlay(role)
    if (focus && overlay.view.getVisible()) live(overlay.contents)?.focus()
  }

  hideOverlay(role: OverlayRole, restoreFocus = true): void {
    const overlay = this.overlays.get(role)
    if (!overlay) return
    const hadFocus = live(overlay.contents)?.isFocused() ?? false
    overlay.placement = null
    overlay.view.setVisible(false)
    // Never refocus while the window is inactive: that could steal OS activation.
    if (restoreFocus && hadFocus && this.window.isFocused()) this.focusContent()
  }

  private hideOverlays(): void {
    for (const overlay of this.overlays.values()) overlay.view.setVisible(false)
  }

  private applyOverlay(role: OverlayRole): void {
    const overlay = this.overlays.get(role)
    if (!overlay) return
    const placement = overlay.placement
    // Only tab-modal prompts may cover HTML fullscreen content (a page can alert() from fullscreen).
    if (!placement || !this.services.vault.isOpen() || (this.htmlFullscreenTab && role !== 'modal')) {
      overlay.view.setVisible(false)
      return
    }
    const [width, height] = this.window.getContentSize()
    const content = this.contentBounds()
    let rect: Rectangle
    switch (placement.type) {
      case 'rect': {
        const r = placement.rect
        const w = Math.min(Math.round(r.width), width)
        const x = Math.max(0, Math.min(Math.round(r.x), width - w))
        const y = Math.max(0, Math.round(r.y))
        rect = { x, y, width: w, height: Math.max(0, Math.min(Math.round(r.height), height - y)) }
        break
      }
      case 'content-top-right':
        rect = {
          x: Math.max(0, width - placement.width - placement.right),
          y: content.y + placement.top,
          width: Math.min(placement.width, width),
          height: placement.height
        }
        break
      case 'content':
        rect = content
        break
      case 'content-anchored': {
        const w = Math.min(Math.round(placement.width), width)
        const x = Math.max(0, Math.min(content.x + Math.round(placement.left), width - w))
        const y = Math.max(0, content.y + Math.round(placement.top))
        rect = { x, y, width: w, height: Math.max(0, Math.min(Math.round(placement.height), height - y)) }
        break
      }
      case 'content-bottom-left': {
        const w = Math.min(Math.round(placement.width), width)
        const h = Math.min(Math.round(placement.height), content.height)
        const y = content.y + content.height - h
        // As in Chrome: the bubble gets out of the way of the pointer instead of covering what it points at.
        const pointer = this.pointerInWindow()
        const inTheWay =
          pointer.x >= 0 &&
          pointer.x < w + STATUS_AVOID_MARGIN &&
          pointer.y > y - STATUS_AVOID_MARGIN &&
          pointer.y <= content.y + content.height
        rect = { x: inTheWay ? width - w : 0, y, width: w, height: h }
        break
      }
    }
    overlay.view.setBounds(rect)
    overlay.view.setVisible(rect.width > 0 && rect.height > 0)
  }

  /** The pointer's position in window content coordinates. */
  private pointerInWindow(): { x: number; y: number } {
    const point = screen.getCursorScreenPoint()
    const bounds = this.window.getContentBounds()
    return { x: point.x - bounds.x, y: point.y - bounds.y }
  }

  /** The UI creates overlay documents with `window.open`; they share its renderer. */
  private adoptOverlay(role: OverlayRole, guest: WebContents): void {
    const view = new WebContentsView({ webContents: guest })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    this.overlays.set(role, { view, contents: guest, placement: null })
    this.restack()

    guest.on('before-input-event', (event, input) => {
      if (this.handleKeyboard(input, 'overlay')) event.preventDefault()
    })
    guest.on('context-menu', (_e, params) => showEditableContextMenu(this.window, guest, params))
    guest.on('will-navigate', (event) => event.preventDefault())
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.once('destroyed', () => {
      if (this.overlays.get(role)?.view === view) this.overlays.delete(role)
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view)
    })
  }

  /**
   * Layers must stack in a fixed order whatever order the UI created them in.
   * Re-adding a child view moves it to the top, so add them bottom → top.
   */
  private restack(): void {
    for (const role of OVERLAY_ROLES) {
      const overlay = this.overlays.get(role)
      if (overlay) this.window.contentView.addChildView(overlay.view)
    }
  }

  private destroyOverlays(): void {
    for (const [role, overlay] of this.overlays) {
      this.overlays.delete(role)
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(overlay.view)
      live(overlay.contents)?.close()
    }
  }

  // ─── Find in page ──────────────────────────────────────────────────────────

  openFind(): void {
    const tab = this.activeTab
    if (!tab || !tab.showsWebContent) return
    tab.find.open = true
    tab.find.focusToken++
    this.pushFindState()
  }

  findQuery(tab: Tab, text: string): void {
    tab.findQuery(text)
    this.pushFindState()
  }

  findStep(tab: Tab, forward: boolean): void {
    if (!tab.find.open) return this.openFind()
    tab.findStep(forward)
  }

  closeFind(tab: Tab): void {
    tab.findStop()
    this.pushFindState()
    if (tab.id === this.activeId) this.focusContent()
  }

  private pushFindState(): void {
    const tab = this.activeTab
    const state: FindState | null = tab && tab.find.open && tab.showsWebContent ? { ...tab.find } : null
    this.sendUi('find:state', state)
  }

  // ─── Commands & keyboard ───────────────────────────────────────────────────

  handleKeyboard(input: Input, source: 'ui' | 'page' | 'overlay'): boolean {
    const shortcut = resolveShortcut(input)
    if (!shortcut) return false
    const open = this.services.vault.isOpen()
    const allowedWhileLocked: CommandId[] = [
      'window.close',
      'window.fullscreen',
      'app.quit',
      'window.new',
      'window.new-guest'
    ]
    // While locked, swallow browsing shortcuts but let Esc etc. reach the lock screen.
    if (!open && !allowedWhileLocked.includes(shortcut.command)) return !shortcut.passThrough
    if (shortcut.passThrough) {
      if (source === 'page') this.run(shortcut.command, shortcut.arg)
      return false
    }
    this.run(shortcut.command, shortcut.arg)
    return true
  }

  run(command: CommandId, arg?: number): void {
    const tab = this.activeTab
    const vaultOpen = this.services.vault.isOpen()
    if (!vaultOpen && !['window.close', 'window.fullscreen', 'app.quit', 'window.new', 'vault.lock'].includes(command))
      return
    switch (command) {
      case 'tab.new':
        return this.newTab()
      case 'tab.close':
        if (tab) this.closeTab(tab)
        return
      case 'tab.reopen':
        return this.reopenClosedTab()
      case 'tab.next':
      case 'tab.prev': {
        const list = this.visibleTabs()
        if (!tab || list.length < 2) return
        const i = list.indexOf(tab)
        const next = list[(i + (command === 'tab.next' ? 1 : -1) + list.length) % list.length]
        return this.activate(next, 'content')
      }
      case 'tab.select': {
        const list = this.visibleTabs()
        const target = arg === -1 ? list[list.length - 1] : list[arg ?? 0]
        if (target) this.activate(target, 'content')
        return
      }
      case 'tab.duplicate':
        if (tab) this.duplicate(tab)
        return
      case 'window.new':
        this.appContext.openWindow()
        return
      case 'window.new-private':
        this.appContext.openWindow({ private: true })
        return
      case 'window.new-guest':
        return this.appContext.openGuest()
      case 'window.close':
        return this.window.close()
      case 'window.fullscreen':
        if (this.htmlFullscreenTab) {
          void this.htmlFullscreenTab.webContents
            ?.executeJavaScript('document.exitFullscreen()', true)
            .catch(() => undefined)
        } else this.window.setFullScreen(!this.window.isFullScreen())
        return
      case 'nav.back':
        return tab?.goBack()
      case 'nav.forward':
        return tab?.goForward()
      case 'nav.reload':
        return tab?.reload(false)
      case 'nav.reload-hard':
        return tab?.reload(true)
      case 'nav.stop':
        if (tab?.state().loading) tab.stop()
        return
      case 'omnibox.focus':
        this.window.webContents.focus()
        return this.sendUi('ui:command', { type: 'omnibox.focus' })
      case 'find.open':
        return this.openFind()
      case 'find.next':
      case 'find.prev':
        if (tab) this.findStep(tab, command === 'find.next')
        return
      case 'bookmark.page':
        return this.sendUi('ui:command', { type: 'popup.open', popup: 'bookmark' })
      case 'bookmarks.toggle-bar': {
        const current = this.services.settings.get().showBookmarksBar
        this.services.settings.update({ showBookmarksBar: !current })
        return
      }
      case 'page.zoom-in':
      case 'page.zoom-out':
      case 'page.zoom-reset':
        if (!tab) return
        tab.zoom(command === 'page.zoom-in' ? 1 : command === 'page.zoom-out' ? -1 : 0)
        // Zoom is per-origin: other tabs on the same site follow.
        for (const controller of this.appContext.windows()) for (const t of controller.allTabs()) t.syncZoom()
        return
      case 'page.print':
        if (tab?.showsWebContent) tab.webContents?.print()
        return
      case 'page.view-source':
        if (tab && /^https?:/.test(tab.currentUrl)) {
          this.createTab({ url: `view-source:${tab.currentUrl}`, index: this.tabs.indexOf(tab) + 1 })
        }
        return
      case 'page.devtools': {
        const wc = tab?.showsWebContent ? tab.webContents : null
        if (!wc) return
        if (wc.isDevToolsOpened()) wc.closeDevTools()
        else wc.openDevTools({ mode: 'detach' })
        return
      }
      case 'open.history':
        return this.openInternal('aqua://history')
      case 'open.downloads':
        return this.openInternal('aqua://downloads')
      case 'open.settings':
        return this.openInternal('aqua://settings')
      case 'open.profiles':
        if (this.appContext.profiles.isGuest) return
        return this.openInternal('aqua://settings/profiles')
      case 'privacy.hide-from-capture': {
        const hide = !this.services.settings.get().hideFromCapture
        this.services.settings.update({ hideFromCapture: hide })
        return
      }
      case 'vault.lock':
        return this.services.vault.lock()
      case 'app.quit':
        return app.quit()
    }
  }

  // ─── State ─────────────────────────────────────────────────────────────────

  state(): WindowState {
    return {
      windowId: this.id,
      tabs: this.visibleTabs().map((t) => t.state()),
      activeTabId: this.activeId,
      canReopenClosedTab: this.closedTabs.length > 0,
      htmlFullscreen: this.htmlFullscreenTab !== null,
      focused: this.window.isFocused(),
      maximized: this.window.isMaximized(),
      prompts: this.prompts.map((p) => p.request),
      private: this.isPrivate
    }
  }

  snapshot(): SessionWindow {
    // While closing tab by tab, the session keeps the window as it was when the close began.
    if (this.windowClose) return this.windowClose.snapshot
    const tabs = this.visibleTabs()
    const active = this.activeTab
    return {
      bounds: this.window.getNormalBounds(),
      maximized: this.window.isMaximized(),
      tabs: tabs.map((t) => t.snapshot()),
      activeIndex: Math.max(0, active ? tabs.indexOf(active) : 0)
    }
  }

  pushState(): void {
    if (this.stateScheduled || this.destroyed) return
    this.stateScheduled = true
    setImmediate(() => {
      this.stateScheduled = false
      if (this.destroyed) return
      this.sendUi('window:state', this.state())
      this.appContext.sessionChanged()
      for (const send of this.afterState.splice(0)) send()
    })
  }

  /**
   * Sends a UI message once the UI has the state it refers to. Activating a
   * New Tab page focuses the address bar: sent before the state, the UI would
   * focus and select the previous tab's address for a frame.
   */
  private sendUiAfterState<K extends keyof EventMap>(channel: K, ...args: Parameters<EventMap[K]>): void {
    this.afterState.push(() => this.sendUi(channel, ...args))
    this.pushState()
  }

  sendUi<K extends keyof EventMap>(channel: K, ...args: Parameters<EventMap[K]>): void {
    const wc = this.window.webContents
    if (!this.destroyed && !wc.isDestroyed()) wc.send(channel, ...args)
  }

  onThemeChanged(): void {
    if (this.destroyed) return
    const palette = currentPalette(this.services.settings.get(), this.isPrivate)
    this.window.setBackgroundColor(palette.frame)
    if (!isMac)
      this.window.setTitleBarOverlay({ color: palette.frame, symbolColor: palette.symbols, height: TAB_STRIP_HEIGHT })
    for (const tab of this.tabs) tab.setPlaceholderColor(palette.content)
  }

  onVaultChanged(): void {
    if (this.destroyed) return
    const open = this.services.vault.isOpen()
    if (!open) {
      this.showStatus('')
      // Hidden pages must not keep keyboard focus: typing goes to the lock screen.
      if (this.window.isFocused()) this.window.webContents.focus()
    }
    if (open && this.pendingInit) {
      const options = this.pendingInit
      this.initTabs(options.restore ?? null, options.urls ?? [])
    }
    const tab = this.activeTab
    if (tab?.isDiscarded && open) tab.wake()
    this.syncViews()
    this.pushFindState()
    this.pushState()
  }

  // ─── Tab-modal prompts ─────────────────────────────────────────────────────

  /** `signal`: withdraws the prompt (it resolves null) when the question no longer applies. */
  requestPrompt(tab: Tab, payload: PromptPayload, signal?: AbortSignal): Promise<PromptResponse | null> {
    if (this.destroyed || tab.isClosing || signal?.aborted) return Promise.resolve(null)
    if (this.prompts.filter((p) => p.request.tabId === tab.id).length >= MAX_PROMPTS_PER_TAB) {
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      const request = { ...payload, id: uid('p'), tabId: tab.id } as PromptRequest
      this.prompts.push({ request, resolve })
      signal?.addEventListener('abort', () => this.withdrawPrompt(request.id), { once: true })
      if (tab.id === this.activeId && !this.window.isFocused()) this.window.flashFrame(true)
      this.onTabChanged(tab)
    })
  }

  private withdrawPrompt(id: string): void {
    const index = this.prompts.findIndex((p) => p.request.id === id)
    if (index === -1) return
    const [{ request, resolve }] = this.prompts.splice(index, 1)
    resolve(null)
    const tab = this.getTab(request.tabId)
    if (tab) this.onTabChanged(tab)
    else this.pushState()
  }

  /** Closes a tab again after the user confirmed leaving it (see Tab: "Leave site?"). */
  requestTabClose(tab: Tab): void {
    if (this.tabs.includes(tab)) this.closeTab(tab)
  }

  /** Answers a prompt from the UI. The response must match the prompt's kind. */
  respondPrompt(id: string, response: PromptResponse): void {
    const index = this.prompts.findIndex((p) => p.request.id === id)
    if (index === -1) return
    const { request, resolve } = this.prompts[index]
    const expected =
      request.kind === 'alert' || request.kind === 'confirm' || request.kind === 'prompt' ? 'dialog' : request.kind
    if (response.kind !== expected) throw new Error(`prompt ${id} expects a ${expected} response`)
    this.prompts.splice(index, 1)
    resolve(response)
    const tab = this.getTab(request.tabId)
    if (tab) this.onTabChanged(tab)
    else this.pushState()
  }

  promptKind(id: string): PromptRequest['kind'] | null {
    return this.prompts.find((p) => p.request.id === id)?.request.kind ?? null
  }

  cancelPrompts(tab: Tab): void {
    const mine = this.prompts.filter((p) => p.request.tabId === tab.id)
    if (mine.length === 0) return
    this.prompts = this.prompts.filter((p) => p.request.tabId !== tab.id)
    for (const p of mine) p.resolve(null)
    if (!tab.isClosing) this.onTabChanged(tab)
    else this.pushState()
  }

  hasPrompt(tab: Tab, kinds?: ReadonlyArray<PromptPayload['kind']>): boolean {
    return this.prompts.some((p) => p.request.tabId === tab.id && (!kinds || kinds.includes(p.request.kind)))
  }

  // ─── Content blocking ──────────────────────────────────────────────────────

  isBlockerPaused(url: string): boolean {
    return this.services.contentBlocker.isPaused(url, this.partition)
  }

  /**
   * Pauses or resumes blocking on the tab's site, then reloads the page so the
   * change applies to all of it. Returns false for pages it does not apply to.
   */
  setBlockerPaused(tab: Tab, paused: boolean): boolean {
    if (!this.services.contentBlocker.setPaused(tab.currentUrl, paused, this.partition)) return false
    // Regular windows share the list: every tab on that site follows.
    for (const controller of this.isPrivate ? [this] : this.appContext.windows().filter((c) => !c.isPrivate))
      controller.refreshBlockerState()
    tab.reload()
    return true
  }

  /** Re-reads each tab's paused state (the list changed). */
  refreshBlockerState(): void {
    for (const tab of this.tabs) {
      const paused = this.isBlockerPaused(tab.currentUrl)
      if (tab.blockerPaused === paused) continue
      tab.blockerPaused = paused
      this.onTabChanged(tab)
    }
  }

  setTaskbarProgress(value: number, paused: boolean): void {
    if (!this.destroyed)
      this.window.setProgressBar(value, {
        mode: value < 0 ? 'none' : paused ? 'paused' : value > 1 ? 'indeterminate' : 'normal'
      })
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private visibleTabs(): Tab[] {
    return this.tabs.filter((t) => !t.isClosing)
  }

  private insertTab(tab: Tab, index: number): void {
    const pinnedCount = this.tabs.filter((t) => t.pinned).length
    const clamped = tab.pinned ? Math.min(index, pinnedCount) : Math.max(pinnedCount, Math.min(index, this.tabs.length))
    this.tabs.splice(clamped, 0, tab)
  }

  /** Links open after the opener and after any tabs it already opened (Chrome's grouping). */
  private childInsertIndex(opener: Tab): number {
    let i = this.tabs.indexOf(opener) + 1
    while (i < this.tabs.length && this.tabs[i].openerId === opener.id) i++
    return i
  }

  private pickNextActive(closing: Tab, index: number): Tab | null {
    const candidates = this.tabs.filter((t) => t !== closing && !t.isClosing)
    if (candidates.length === 0) return null
    if (closing.openerId && closing.openerId === this.previousActiveId) {
      const opener = candidates.find((t) => t.id === closing.openerId)
      if (opener) return opener
    }
    for (let i = index + 1; i < this.tabs.length; i++) if (candidates.includes(this.tabs[i])) return this.tabs[i]
    for (let i = index - 1; i >= 0; i--) if (candidates.includes(this.tabs[i])) return this.tabs[i]
    return candidates[0]
  }

  private installWindowEvents(maximized: boolean): void {
    const win = this.window
    win.once('ready-to-show', () => {
      if (maximized) win.maximize()
      win.show()
    })
    const relayout = (): void => {
      this.layout()
      this.pushState()
    }
    win.on('resize', () => this.layout())
    win.on('maximize', relayout)
    win.on('unmaximize', relayout)
    win.on('restore', relayout)
    win.on('enter-full-screen', relayout)
    win.on('leave-full-screen', relayout)
    win.on('focus', () => {
      win.flashFrame(false)
      this.pushState()
    })
    // Popups are closed by the UI (which debounces transient activation flips);
    // hiding them here too would desynchronise UI state and the overlay.
    win.on('blur', () => this.pushState())
    win.on('app-command', (_e, command) => {
      if (command === 'browser-backward') this.run('nav.back')
      else if (command === 'browser-forward') this.run('nav.forward')
    })
    win.on('swipe', (_e, direction) => {
      if (direction === 'left') this.run('nav.back')
      else if (direction === 'right') this.run('nav.forward')
    })
    // The tab strip's empty space is a window drag area, so a right-click there never reaches the
    // UI: Windows opens the system menu instead. Show the tab strip menu, as Chrome does; the
    // caption buttons keep the system menu.
    win.on('system-context-menu', (event, point) => {
      const content = win.getContentBounds()
      const x = point.x - content.x
      const y = point.y - content.y
      const onStrip = y >= 0 && y < TAB_STRIP_HEIGHT && x < content.width - CAPTION_BUTTONS_WIDTH
      if (!onStrip || !this.services.vault.isOpen() || this.htmlFullscreenTab) return
      event.preventDefault()
      showUiContextMenu(this, { kind: 'tabstrip' })
    })
    win.on('close', (event) => {
      if (!this.closeConfirmed && this.beginWindowClose()) {
        event.preventDefault()
        return
      }
      this.appContext.windowClosing(this)
    })
    // Windows is logging off or shutting down: there is no time to ask anything.
    win.on('session-end', () => {
      this.closeConfirmed = true
    })
    win.on('closed', () => this.dispose())
  }

  /**
   * The window was asked to close. Returns true when it has to wait: its pages run their
   * beforeunload first, one at a time (the active tab first), while the window is hidden. A page
   * that asks "Leave site?" brings it back. When every page has agreed the window closes for real.
   *
   * No waiting while the vault is locked (the question couldn't be shown over the lock screen)
   * or when no tab has a live page.
   */
  private beginWindowClose(): boolean {
    if (this.windowClose) return true
    if (!this.services.vault.isOpen() || !this.visibleTabs().some((t) => t.webContents !== null)) return false
    this.windowClose = { snapshot: this.snapshot(), current: null, closed: [] }
    this.hideOverlays()
    this.window.hide()
    this.closeNextTab()
    return true
  }

  private closeNextTab(): void {
    const state = this.windowClose
    if (!state || state.current) return
    // Tabs without a live page (discarded, not restored yet) have no beforeunload: dispose() ends them.
    const next =
      [this.activeTab, ...this.tabs].find((t): t is Tab => !!t && !t.isClosing && t.webContents !== null) ?? null
    if (!next) {
      this.closeConfirmed = true
      this.window.close()
      // Electron gives up a quit when a window delays its close. Elsewhere the last window closing
      // quits anyway (window-all-closed); on macOS it doesn't, so the quit is resumed here.
      if (isMac && this.appContext.isQuitting()) setImmediate(() => app.quit())
      return
    }
    state.current = { tab: next, record: { snapshot: next.snapshot(), index: this.tabs.indexOf(next) } }
    next.close()
  }

  /** "Stay" in a page's "Leave site?" while the window was closing: it stays open, as it was. */
  private abortWindowClose(): void {
    const state = this.windowClose
    if (!state) return
    this.windowClose = null
    // Undo in reverse order, so each tab returns to the index it had when it closed; it loads when shown.
    for (const { snapshot, index } of state.closed.reverse())
      this.insertTab(new Tab(this, { restore: snapshot }), index)
    this.window.show()
    this.appContext.windowCloseCancelled()
    this.pushState()
  }

  private installUiGuards(): void {
    const wc = this.window.webContents
    wc.setVisualZoomLevelLimits(1, 1).catch(() => undefined)
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('before-input-event', (event, input) => {
      if (this.handleKeyboard(input, 'ui')) event.preventDefault()
    })
    wc.on('context-menu', (_e, params) => showEditableContextMenu(this.window, wc, params))
    wc.on('did-start-navigation', (details) => {
      // UI reload (dev HMR or crash recovery): its overlay documents die with it.
      if (details.isMainFrame && !details.isSameDocument) this.destroyOverlays()
    })
    wc.on('render-process-gone', (_e, details) => {
      console.error('[ui] renderer gone:', details.reason)
      this.destroyOverlays()
      if (!this.destroyed && details.reason !== 'clean-exit') setTimeout(() => !this.destroyed && wc.reload(), 250)
    })
    wc.setWindowOpenHandler((details) => {
      const role = OVERLAY_ROLES.find((r) => details.frameName === `aqua-overlay-${r}`) ?? null
      if (!role || details.url !== 'about:blank' || this.overlays.has(role)) return { action: 'deny' }
      return {
        action: 'allow',
        createWindow: (options) => {
          const guest = (options as { webContents?: WebContents }).webContents
          if (!guest) throw new Error('overlay: missing guest webContents')
          this.adoptOverlay(role, guest)
          return guest
        }
      }
    })
  }

  private dispose(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.disposables.dispose()
    const prompts = this.prompts
    this.prompts = []
    for (const p of prompts) p.resolve(null)
    this.destroyOverlays()
    for (const tab of [...this.tabs]) tab.destroy()
    this.tabs = []
    this.closedTabs.length = 0
    this.closingSnapshots.clear()
    this.focusOnCommit.clear()
    this.appContext.windowClosed(this)
  }

  private sendCommand(command: UiCommand): void {
    this.sendUi('ui:command', command)
  }

  /**
   * Opens the downloads bubble when a download starts in this window, and
   * closes a tab that was opened only to fetch the file (it never committed a
   * page and would otherwise stay blank), as Chrome does.
   */
  onDownloadStarted(source: WebContents | null): void {
    if (this.window.isFocused()) this.sendCommand({ type: 'popup.open', popup: 'downloads' })
    const tab = source ? this.findTabByWebContentsId(source.id) : null
    if (!tab || tab.isClosing || this.visibleTabs().length <= 1) return
    const history = tab.webContents?.navigationHistory
    const committed = history ? history.getAllEntries().some((e) => e.url && e.url !== 'about:blank') : true
    // closeTab() keeps the page alive (hidden) until the transfer finishes.
    // Not recorded as a closed tab: reopening it would just re-download.
    if (!committed) {
      this.closeTab(tab)
      this.closingSnapshots.delete(tab.id)
    }
  }

  addDisposable(dispose: () => void): void {
    this.disposables.add(dispose)
  }
}
