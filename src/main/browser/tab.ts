import {
  dialog,
  WebContentsView,
  type BrowserWindow,
  type ContextMenuParams,
  type Input,
  type WebContents,
  type WebPreferences
} from 'electron'
import type { JsDialogRequest } from '../../shared/ipc'
import type { FindState, LoadStage, PromptResponse, SecurityLevel, TabError, TabState } from '../../shared/types'
import { stripTrackingParams } from '../../shared/tracking'
import { isInternalUrl, NEW_TAB_URL } from '../../shared/url'
import { uid } from '../lib/signal'
import type { Services } from '../services'
import type { PromptPayload } from '../services/permissions'
import type { SessionEntry, SessionTab } from '../services/session'
import { DownloadGate } from './download-gate'
import { externalTarget, launchExternal } from './external'

export type OpenDisposition = 'foreground-tab' | 'background-tab'

export interface TabHost {
  readonly window: BrowserWindow
  readonly services: Services
  /** A private window: tabs record no history and write nothing to the vault. */
  readonly isPrivate: boolean
  /** Preferences for new tab pages (carries the window's session). */
  readonly webPreferences: WebPreferences
  /** Whether ad and tracker blocking is paused for this page's site. */
  isBlockerPaused(url: string): boolean
  /** Colour shown in place of a tab's page until its first document commits. */
  contentBackground(): string
  /** Shows a tab-modal prompt; resolves null if it was dismissed without an answer. */
  requestPrompt(tab: Tab, payload: PromptPayload, signal?: AbortSignal): Promise<PromptResponse | null>
  /** Closes the tab (again) through the window, as the close button would. */
  requestTabClose(tab: Tab): void
  /** Resolves every pending prompt of the tab with null (navigation, close, crash). */
  cancelPrompts(tab: Tab): void
  hasPrompt(tab: Tab, kinds?: ReadonlyArray<PromptPayload['kind']>): boolean
  isActive(tab: Tab): boolean
  onTabChanged(tab: Tab): void
  /** A WebContentsView now exists for this tab and must be attached to the window. */
  onTabViewCreated(tab: Tab): void
  onTabCommitted(tab: Tab): void
  /** The tab's web contents received keyboard focus (possibly while hidden). */
  onTabFocus(tab: Tab): void
  /** The link under the pointer (Chromium's "target URL"); '' when there is none. */
  onTabTargetUrl(tab: Tab, url: string): void
  onTabOpen(opener: Tab, url: string, disposition: OpenDisposition): void
  onTabAdoptGuest(opener: Tab, guest: WebContents, disposition: OpenDisposition): void
  onTabFullscreen(tab: Tab, fullscreen: boolean): void
  onTabFindResult(tab: Tab): void
  onTabContextMenu(tab: Tab, params: ContextMenuParams): void
  onTabKeyboard(tab: Tab, input: Input): boolean
  onTabClosed(tab: Tab): void
  /** The page held up its close with beforeunload: the tab stays while Aqua asks "Leave site?". */
  onTabCloseCancelled(tab: Tab): void
  /** The user answered that "Leave site?" with Stay (or it was dismissed): the tab stays open. */
  onTabCloseDeclined(tab: Tab): void
}

export interface TabInit {
  url?: string
  /** Restored tab: create lazily on first activation. */
  restore?: SessionTab
  /** Adopt a WebContents created by `window.open` (keeps `window.opener`). */
  guest?: WebContents
  pinned?: boolean
  openerId?: string | null
}

/**
 * A view's background colour doubles as the page's base canvas colour, which
 * pages without a background of their own (and dark `color-scheme` pages
 * aside) expect to be white, as in every browser.
 */
const PAGE_CANVAS = '#ffffff'

/** Chrome's zoom ladder. */
const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
const POPUP_GESTURE_WINDOW_MS = 5000
/**
 * A navigation this soon after the user acted (a click in the page, the
 * address bar, Back, Reload) counts as the user moving on: the new page's
 * download limits start over.
 */
const DOWNLOAD_RESET_INTENT_MS = 5000
/** "Leave site?" for a navigation Aqua started this recently is asked in Aqua's own dialog (see will-prevent-unload). */
const LEAVE_INTENT_MS = 3000
/** A page opening this many dialogs within DIALOG_FLOOD_MS gets the rest suppressed automatically. */
const DIALOG_FLOOD_COUNT = 5
const DIALOG_FLOOD_MS = 10_000
/** After "Cancel" on an external-app prompt, the page may not ask again for this long. */
const EXTERNAL_COOLDOWN_MS = 4000
/** Even for sites allowed to open an app, launches are at least this far apart. */
const EXTERNAL_LAUNCH_GAP_MS = 3000
/** A site that redirects straight back to the tagged URL gets its way instead of looping. */
const STRIP_LOOP_WINDOW_MS = 5000
const CLOSE_TIMEOUT_MS = 2500
const MAX_SESSION_ENTRIES = 25
/** Schemes web content may navigate to on its own. */
const WEB_SCHEMES = new Set(['http:', 'https:', 'about:', 'data:', 'blob:', 'file:'])
/** Privileged schemes that only the browser itself may open. */
const PRIVILEGED_SCHEMES = new Set([
  'aqua:',
  'aqua-ui:',
  'aqua-resource:',
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'view-source:',
  'javascript:'
])
const PAGE_DIALOGS = ['alert', 'confirm', 'prompt'] as const

/**
 * Every tab page. The tab preload (dialogs, clipboard and passkey protection,
 * link cleaning) is registered on the browsing session instead of here:
 * Electron drops `preload` from the preferences of pages opened with
 * `window.open`, and a session preload reaches those too.
 * `nodeIntegrationInSubFrames` means "run preloads in sub-frames" - Node
 * itself stays disabled by the sandbox.
 */
export const TAB_WEB_PREFERENCES: WebPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  safeDialogs: true,
  spellcheck: true,
  navigateOnDragDrop: false,
  scrollBounce: true
}

/** What alert/confirm/prompt return for a response (null: suppressed or dismissed). */
function dialogResult(kind: JsDialogRequest['kind'], response: PromptResponse | null): unknown {
  const answer = response?.kind === 'dialog' && response.accepted ? response : null
  switch (kind) {
    case 'alert':
      return true
    case 'confirm':
      return answer !== null
    case 'prompt':
      return answer ? (answer.value ?? '') : null
  }
}

export function securityFor(url: string, certException: boolean): SecurityLevel {
  if (isInternalUrl(url)) return 'internal'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'neutral'
  }
  switch (parsed.protocol) {
    case 'https:':
      return certException ? 'cert-error' : 'secure'
    case 'http:': {
      const h = parsed.hostname
      const local = h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]'
      return local ? 'neutral' : 'insecure'
    }
    case 'file:':
      return 'file'
    default:
      return 'neutral'
  }
}

function isCertificateError(code: number): boolean {
  return code <= -200 && code > -300
}

/**
 * One browser tab: owns a sandboxed WebContentsView, translates its
 * lifecycle events into `TabState`, and guarantees release of the view and
 * its renderer when closed.
 */
export class Tab {
  readonly id = uid('t')
  openerId: string | null
  pinned: boolean

  private view: WebContentsView | null = null
  /** The view's contents, kept separately: `view.webContents` reads undefined once destroyed. */
  private contents: WebContents | null = null
  private restore: SessionTab | null = null
  private closing = false
  private disposed = false
  private closeTimer: NodeJS.Timeout | null = null
  private unresponsiveDialog: AbortController | null = null
  /** The last navigation Aqua started for this tab, so it can be repeated once the user confirms leaving. */
  private lastIntent: { at: number; repeat: () => void } | null = null
  /** The user chose "Leave" in Aqua's dialog: the next unload goes ahead without asking again. */
  private leaveConfirmedUntil = 0
  private askingToLeave = false
  private lastUserInput = 0
  /** When Aqua itself last navigated this tab or saved something from it for the user. */
  private browserActionAt = 0
  /** Automatic-download limits of the current page (see DownloadGate). */
  private readonly downloadGate = new DownloadGate()
  /** The pending "Download multiple files?" answer that held downloads wait for. */
  private downloadAnswer: Promise<boolean> | null = null
  /** Bumped when the gate resets, so a late answer for the previous page is ignored. */
  private downloadGeneration = 0
  private blockedPopupUrls: string[] = []
  private historyVisitId: string | null = null
  private pendingTyped: string | null = null
  /** Transition reported for the next main-frame commit (webNavigation.onCommitted). */
  /** Dialogs opened by the current document; from the second one the user may suppress the rest. */
  private dialogCount = 0
  private dialogsSuppressed = false
  private dialogTimes: number[] = []
  private externalPromptOpen = false
  private externalBlockedUntil = 0
  private lastExternalLaunch = 0
  private contentsId = -1
  /** A document has committed: the view shows the page canvas, no longer the placeholder colour. */
  private committed = false
  private lastStripped: { url: string; at: number } | null = null

  // Observable state
  private url: string
  private title: string
  private favicon: string | null = null
  private loading = false
  private loadStage: LoadStage = 'idle'
  private audible = false
  private muted = false
  private canGoBack = false
  private canGoForward = false
  private error: TabError | null = null
  private crashed = false
  private zoomFactor = 1
  /** Requests blocked on the current page. */
  blockedCount = 0
  /** Blocking is paused for the current site. */
  blockerPaused = false

  readonly find: FindState

  constructor(
    private readonly host: TabHost,
    init: TabInit
  ) {
    this.pinned = init.pinned ?? init.restore?.pinned ?? false
    this.openerId = init.openerId ?? null
    this.find = { tabId: this.id, open: false, text: '', matches: 0, activeMatch: 0, focusToken: 0 }

    if (init.restore) {
      this.restore = init.restore
      this.url = init.restore.url
      this.title = init.restore.title || init.restore.url
      this.favicon = init.restore.favicon
      this.muted = init.restore.muted
    } else if (init.guest) {
      this.url = init.guest.getURL() || 'about:blank'
      this.title = ''
      this.createView(init.guest)
    } else {
      this.url = init.url ?? NEW_TAB_URL
      this.title = ''
      this.createView()
      this.load(this.url)
    }
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  get webContents(): WebContents | null {
    return this.contents && !this.contents.isDestroyed() ? this.contents : null
  }

  /** Id of the tab's page (webContents), or -1 before it exists. */
  get webContentsId(): number {
    return this.contentsId
  }

  get contentView(): WebContentsView | null {
    return this.view
  }

  get currentUrl(): string {
    return this.url
  }

  get currentTitle(): string {
    return this.title
  }

  get currentFavicon(): string | null {
    return this.favicon
  }

  get isDiscarded(): boolean {
    return this.restore !== null
  }

  get isClosing(): boolean {
    return this.closing
  }

  /** True when the web view (rather than a UI-rendered page) should be on screen. */
  get showsWebContent(): boolean {
    return !this.restore && !this.error && !this.crashed && !isInternalUrl(this.url) && this.view !== null
  }

  state(): TabState {
    const certException = this.host.services.certificates.hasException(hostname(this.url))
    return {
      id: this.id,
      url: this.url,
      title: this.title || this.fallbackTitle(),
      favicon: this.favicon,
      pinned: this.pinned,
      loading: this.loading,
      loadStage: this.loadStage,
      audible: this.audible,
      muted: this.muted,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      security: this.error && isCertificateError(this.error.code) ? 'cert-error' : securityFor(this.url, certException),
      error: this.error,
      crashed: this.crashed,
      zoomFactor: this.zoomFactor,
      blockedCount: this.blockedCount,
      blockerPaused: this.blockerPaused,
      blockedPopups: this.blockedPopupUrls.length,
      hasPrompt: this.host.hasPrompt(this),
      discarded: this.restore !== null
    }
  }

  snapshot(): SessionTab {
    if (this.restore) return { ...this.restore, pinned: this.pinned, muted: this.muted }
    let entries: SessionEntry[] = []
    let index = 0
    const wc = this.webContents
    if (wc) {
      const all = wc.navigationHistory.getAllEntries()
      const active = wc.navigationHistory.getActiveIndex()
      const start = Math.max(0, active - (MAX_SESSION_ENTRIES - 1))
      entries = all
        .slice(start, active + 1)
        .filter((e) => !e.url.startsWith('view-source:'))
        .map((e) => ({ url: e.url, title: e.title }))
      index = Math.max(0, entries.length - 1)
    }
    return {
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      pinned: this.pinned,
      muted: this.muted,
      entries,
      index
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Materialises a restored tab. Returns true if a view was created. */
  wake(): boolean {
    if (!this.restore) return false
    const data = this.restore
    this.restore = null
    this.createView()
    const wc = this.webContents!
    if (data.muted) wc.setAudioMuted(true)
    const entries = data.entries.filter((e) => e.url)
    if (entries.length > 0) {
      wc.navigationHistory.restore({ entries, index: Math.min(data.index, entries.length - 1) }).catch(() => undefined)
    } else {
      this.load(data.url)
    }
    return true
  }

  setVisible(visible: boolean): void {
    this.view?.setVisible(visible)
  }

  /** Theme changed: recolour the placeholder of a page that has not committed yet. */
  setPlaceholderColor(color: string): void {
    if (!this.committed) this.view?.setBackgroundColor(color)
  }

  setBounds(bounds: Electron.Rectangle): void {
    this.view?.setBounds(bounds)
  }

  /** Graceful close: runs beforeunload; falls back to a hard close if the page hangs. */
  close(): void {
    if (this.closing || this.disposed) return
    this.closing = true
    // A page blocked in alert() could not run its beforeunload handler.
    this.host.cancelPrompts(this)
    const wc = this.webContents
    if (!wc) {
      this.finalize()
      return
    }
    this.closeTimer = setTimeout(() => {
      if (!wc.isDestroyed()) wc.close()
    }, CLOSE_TIMEOUT_MS)
    wc.close({ waitForBeforeUnload: true })
  }

  /**
   * Removes the tab from the UI without destroying its page (used while the
   * page still owns an active download). `destroy()` finishes the job.
   */
  retire(): void {
    if (this.closing || this.disposed) return
    this.closing = true
    this.host.cancelPrompts(this)
    this.view?.setVisible(false)
    this.webContents?.setAudioMuted(true)
  }

  /** Immediate teardown (window closing / app quitting). */
  destroy(): void {
    if (this.disposed) return
    this.closing = true
    const wc = this.webContents
    if (wc && !wc.isDestroyed()) wc.close()
    this.finalize()
  }

  // ─── Downloads ─────────────────────────────────────────────────────────────

  /**
   * Whether a download this page just started may go ahead: yes or no right
   * away, or a promise for the user's answer (the download waits, paused).
   * See DownloadGate for the rules.
   */
  gateDownload(filename: string): boolean | Promise<boolean> {
    const gate = this.downloadGate
    const verdict = gate.decide(Date.now(), Math.max(this.lastUserInput, this.browserActionAt))
    if (verdict !== 'ask') return verdict === 'allow'
    if (!this.downloadAnswer) {
      const generation = this.downloadGeneration
      gate.markAsking()
      const origin = webOrigin(this.url) || originOf(this.url)
      this.downloadAnswer = this.host
        .requestPrompt(this, { kind: 'downloads', origin, filename })
        .then(
          (response) => (response?.kind === 'downloads' ? response.decision : 'dismiss'),
          () => 'dismiss' as const
        )
        .then((decision) => {
          if (generation === this.downloadGeneration) gate.answer(decision, Date.now())
          this.downloadAnswer = null
          return decision === 'allow'
        })
    }
    return this.downloadAnswer
  }

  /** "Save link as…" and friends: the user asked for this download, so no limit applies. */
  saveAs(url: string): void {
    const wc = this.webContents
    if (!wc) return
    this.browserActionAt = Date.now()
    wc.downloadURL(url)
  }

  private resetDownloadGate(): void {
    this.downloadGate.reset()
    this.downloadGeneration++
    this.downloadAnswer = null
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  load(url: string, options: { typed?: boolean; bookmark?: boolean } = {}): void {
    if (this.restore) this.restore = null
    if (!this.view) this.createView()
    const wc = this.webContents
    if (!wc) return
    this.host.cancelPrompts(this)
    this.browserActionAt = Date.now()
    this.noteIntent(() => this.load(url, options))
    url = this.withoutTracking(url) ?? url
    this.pendingTyped = options.typed ? url : null
    wc.loadURL(url).catch(() => {
      /* failures surface through did-fail-load */
    })
  }

  goBack(): void {
    const nav = this.webContents?.navigationHistory
    if (!nav?.canGoBack()) return
    this.host.cancelPrompts(this)
    this.browserActionAt = Date.now()
    this.noteIntent(() => this.goBack())
    nav.goBack()
  }

  goForward(): void {
    const nav = this.webContents?.navigationHistory
    if (!nav?.canGoForward()) return
    this.host.cancelPrompts(this)
    this.browserActionAt = Date.now()
    this.noteIntent(() => this.goForward())
    nav.goForward()
  }

  goToIndex(index: number): void {
    const nav = this.webContents?.navigationHistory
    if (!nav || index < 0 || index >= nav.length()) return
    this.host.cancelPrompts(this)
    this.browserActionAt = Date.now()
    this.noteIntent(() => this.goToIndex(index))
    nav.goToIndex(index)
  }

  reload(hard = false): void {
    if (this.restore) {
      this.wake()
      return
    }
    const wc = this.webContents
    if (!wc) return
    this.host.cancelPrompts(this)
    this.browserActionAt = Date.now()
    this.noteIntent(() => this.reload(hard))
    if (hard) wc.reloadIgnoringCache()
    else wc.reload()
  }

  stop(): void {
    this.webContents?.stop()
  }

  // ─── Page dialogs & external applications ─────────────────────────────────

  /**
   * alert() / confirm() / prompt() from one of this tab's frames. Resolves
   * with the value the page's call returns.
   */
  async runDialog(request: JsDialogRequest, frameOrigin: string, embedded: boolean): Promise<unknown> {
    if (this.closing || this.disposed || this.dialogsSuppressed) return dialogResult(request.kind, null)
    // A page answering dialogs with more dialogs as fast as they are dismissed loses the right to show them.
    const now = Date.now()
    this.dialogTimes = [...this.dialogTimes.filter((t) => now - t < DIALOG_FLOOD_MS), now]
    if (this.dialogTimes.length > DIALOG_FLOOD_COUNT) {
      this.dialogsSuppressed = true
      return dialogResult(request.kind, null)
    }
    this.dialogCount++
    const response = await this.host.requestPrompt(this, {
      kind: request.kind,
      origin: frameOrigin,
      embedded,
      message: request.message,
      defaultValue: request.defaultValue,
      offerSuppress: this.dialogCount > 1
    })
    if (response?.kind === 'dialog' && response.suppress) this.dialogsSuppressed = true
    return dialogResult(request.kind, response)
  }

  /**
   * A link, script or the user asked to open another application (discord:,
   * steam:, tg:, mailto: …). Sites the user trusted for that scheme open it
   * directly; otherwise the user is asked, one prompt per tab at a time.
   * A page can't use this to spam: no new prompt for a few seconds after a
   * "Cancel", and launches are spaced out even for trusted sites.
   */
  async openExternal(url: string, requester: 'page' | 'user'): Promise<void> {
    const target = await externalTarget(url)
    if (!target || this.closing) return
    const origin = requester === 'page' ? webOrigin(this.url) : ''
    if (requester === 'page' && Date.now() < this.externalBlockedUntil) return
    const grants = this.host.services.protocolGrants
    if (origin && grants.isAllowed(origin, target.scheme)) {
      if (Date.now() - this.lastExternalLaunch < EXTERNAL_LAUNCH_GAP_MS) return
      this.lastExternalLaunch = Date.now()
      return launchExternal(url)
    }
    // A private window may use grants made elsewhere but never records new ones.
    const canRemember = !!origin && !!target.appName && !this.host.isPrivate
    if (this.externalPromptOpen) return
    this.externalPromptOpen = true
    try {
      const response = await this.host.requestPrompt(this, {
        kind: 'external',
        origin,
        url,
        scheme: target.scheme,
        appName: target.appName,
        appIcon: target.appIcon,
        canRemember
      })
      if (response?.kind !== 'external' || !response.allow) {
        this.externalBlockedUntil = Date.now() + EXTERNAL_COOLDOWN_MS
        return
      }
      if (response.remember && canRemember) grants.allow(origin, target.scheme)
      this.lastExternalLaunch = Date.now()
      await launchExternal(url)
    } finally {
      this.externalPromptOpen = false
    }
  }

  navigationEntries(): Array<{ index: number; title: string; url: string }> {
    const nav = this.webContents?.navigationHistory
    if (!nav) return []
    return nav.getAllEntries().map((e, index) => ({ index, title: e.title, url: e.url }))
  }

  activeEntryIndex(): number {
    return this.webContents?.navigationHistory.getActiveIndex() ?? -1
  }

  // ─── Media / zoom / find ───────────────────────────────────────────────────

  setMuted(muted: boolean): void {
    this.muted = muted
    if (this.restore) this.restore.muted = muted
    this.webContents?.setAudioMuted(muted)
    this.host.onTabChanged(this)
  }

  zoom(step: -1 | 0 | 1): void {
    const wc = this.webContents
    if (!wc) return
    const current = wc.getZoomFactor()
    let next = 1
    if (step !== 0) {
      const index = ZOOM_LEVELS.findIndex((z) => z >= current - 0.001)
      const base = index === -1 ? ZOOM_LEVELS.length - 1 : index
      const target = step > 0 ? (ZOOM_LEVELS[base] > current + 0.001 ? base : base + 1) : base - 1
      next = ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, target))]
    }
    wc.setZoomFactor(next)
    this.syncZoom()
  }

  syncZoom(): void {
    const wc = this.webContents
    const z = wc ? Math.round(wc.getZoomFactor() * 100) / 100 : 1
    if (z !== this.zoomFactor) {
      this.zoomFactor = z
      this.host.onTabChanged(this)
    }
  }

  findQuery(text: string): void {
    const wc = this.webContents
    this.find.text = text
    if (!wc) return
    if (!text) {
      wc.stopFindInPage('clearSelection')
      this.find.matches = 0
      this.find.activeMatch = 0
      this.host.onTabFindResult(this)
      return
    }
    wc.findInPage(text, { findNext: true })
  }

  findStep(forward: boolean): void {
    const wc = this.webContents
    if (!wc || !this.find.text) return
    wc.findInPage(this.find.text, { forward, findNext: false })
  }

  findStop(): void {
    this.webContents?.stopFindInPage('keepSelection')
    this.find.open = false
    this.find.matches = 0
    this.find.activeMatch = 0
  }

  // ─── Popups ────────────────────────────────────────────────────────────────

  openLastBlockedPopup(): void {
    const url = this.blockedPopupUrls.pop()
    if (url) this.host.onTabOpen(this, url, 'foreground-tab')
    this.host.onTabChanged(this)
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Adds a history entry - never in a private window. */
  private recordVisit(url: string, title: string, favicon: string | null, typed: boolean): string | null {
    return this.host.isPrivate ? null : this.host.services.history.addVisit(url, title, favicon, typed)
  }

  /**
   * The URL without tracking parameters when the setting is on and the URL
   * has any, otherwise null. Link clicks are cleaned in the page itself (tab
   * preload); this covers browser-initiated loads and server redirects. Only
   * top-level documents are cleaned, so subresource URLs a page builds itself
   * (signed API calls) are never altered.
   */
  private withoutTracking(url: string): string | null {
    if (!this.host.services.settings.get().stripTrackingParams) return null
    const cleaned = stripTrackingParams(url)
    if (!cleaned) return null
    const last = this.lastStripped
    if (last && last.url === cleaned && Date.now() - last.at < STRIP_LOOP_WINDOW_MS) return null
    this.lastStripped = { url: cleaned, at: Date.now() }
    return cleaned
  }

  private fallbackTitle(): string {
    if (this.loading && !isInternalUrl(this.url)) return 'Loading…'
    if (this.url === 'about:blank') return 'Untitled'
    return this.url.replace(/^https?:\/\//, '')
  }

  private createView(guest?: WebContents): void {
    const view = guest
      ? new WebContentsView({ webContents: guest })
      : new WebContentsView({ webPreferences: this.host.webPreferences })
    view.setBackgroundColor(this.host.contentBackground())
    view.setVisible(false)
    this.view = view
    this.contents = view.webContents
    this.contentsId = view.webContents.id
    this.bind(view.webContents)
    this.host.onTabViewCreated(this)
  }

  private updateNavState(): void {
    const nav = this.webContents?.navigationHistory
    this.canGoBack = nav?.canGoBack() ?? false
    this.canGoForward = nav?.canGoForward() ?? false
  }

  private bind(wc: WebContents): void {
    const host = this.host
    const changed = (): void => host.onTabChanged(this)

    wc.on('did-start-loading', () => {
      this.loading = true
      this.loadStage = 'started'
      changed()
    })

    wc.on('did-stop-loading', () => {
      this.loading = false
      this.loadStage = 'idle'
      this.updateNavState()
      changed()
    })

    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      this.blockedCount = 0
    })

    wc.on('did-navigate', (_e, url) => {
      const crossOrigin = originOf(url) !== originOf(this.url)
      // A new document: dialogs, bubbles and prompts of the previous one are void.
      host.cancelPrompts(this)
      if (!this.committed) {
        this.committed = true
        this.view?.setBackgroundColor(PAGE_CANVAS)
      }
      this.dialogCount = 0
      this.dialogsSuppressed = false
      this.dialogTimes = []
      const now = Date.now()
      const userIntent = now - Math.max(this.lastUserInput, this.browserActionAt) < DOWNLOAD_RESET_INTENT_MS
      // A page that navigates itself (even to another site) keeps its limits; the user moving on resets them.
      if (crossOrigin ? userIntent : now - this.browserActionAt < DOWNLOAD_RESET_INTENT_MS) this.resetDownloadGate()
      this.url = url
      this.blockerPaused = host.isBlockerPaused(url)
      this.error = null
      this.crashed = false
      this.loadStage = 'committed'
      this.blockedPopupUrls = []
      if (crossOrigin) this.favicon = null
      this.updateNavState()
      this.find.matches = 0
      this.find.activeMatch = 0
      const typed = this.pendingTyped === url
      this.pendingTyped = null
      this.historyVisitId = this.recordVisit(url, wc.getTitle() === url ? '' : wc.getTitle(), this.favicon, typed)
      this.syncZoom()
      host.onTabCommitted(this)
      changed()
    })

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      this.url = url
      this.updateNavState()
      this.historyVisitId = this.recordVisit(url, this.title, this.favicon, false)
      changed()
    })

    wc.on('dom-ready', () => {
      if (this.loadStage === 'committed' || this.loadStage === 'started') {
        this.loadStage = 'dom-ready'
        changed()
      }
    })

    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return // -3 ERR_ABORTED: user stop / superseded navigation
      this.url = validatedURL || this.url
      this.error = { code, name: description || `ERR_${Math.abs(code)}`, url: validatedURL }
      // Error pages never report a title; show the host like other browsers do.
      this.title = hostname(this.url) || this.url
      this.favicon = null
      this.crashed = false
      this.updateNavState()
      host.onTabCommitted(this)
      changed()
    })

    wc.on('page-title-updated', (_e, title) => {
      this.title = title
      if (this.historyVisitId) host.services.history.updateVisit(this.historyVisitId, { title })
      changed()
    })

    wc.on('page-favicon-updated', (_e, favicons) => {
      const icon = favicons.find((f) => /^(https?|data):/.test(f)) ?? null
      if (!icon || icon === this.favicon) return
      this.favicon = icon
      if (this.historyVisitId) host.services.history.updateVisit(this.historyVisitId, { favicon: icon })
      if (!host.isPrivate) host.services.bookmarks.updateFavicon(this.url, icon)
      changed()
    })

    wc.on('audio-state-changed', (event) => {
      this.audible = event.audible
      changed()
    })

    wc.on('render-process-gone', (_e, details) => {
      if (this.closing || details.reason === 'clean-exit') return
      this.crashed = true
      this.loading = false
      this.loadStage = 'idle'
      this.unresponsiveDialog?.abort()
      host.cancelPrompts(this)
      changed()
    })

    // A page waiting in alert() is blocked on purpose, not hung.
    wc.on('unresponsive', () => {
      if (!host.hasPrompt(this, PAGE_DIALOGS)) void this.promptUnresponsive(wc)
    })
    wc.on('responsive', () => this.unresponsiveDialog?.abort())

    wc.on('enter-html-full-screen', () => host.onTabFullscreen(this, true))
    wc.on('leave-html-full-screen', () => host.onTabFullscreen(this, false))

    wc.on('found-in-page', (_e, result) => {
      if (typeof result.matches === 'number') this.find.matches = result.matches
      if (typeof result.activeMatchOrdinal === 'number') this.find.activeMatch = result.activeMatchOrdinal
      host.onTabFindResult(this)
    })

    wc.on('focus', () => host.onTabFocus(this))
    wc.on('update-target-url', (_e, url) => host.onTabTargetUrl(this, url))
    wc.on('zoom-changed', (_e, direction) => this.zoom(direction === 'in' ? 1 : -1))
    wc.on('context-menu', (_e, params) => host.onTabContextMenu(this, params))

    wc.on('before-input-event', (event, input) => {
      if (host.onTabKeyboard(this, input)) event.preventDefault()
    })

    wc.on('input-event', (_e, input) => {
      const t = input.type
      if (t === 'mouseDown' || t === 'rawKeyDown' || t === 'keyDown' || t === 'gestureTap' || t === 'touchStart') {
        this.lastUserInput = Date.now()
      }
    })

    wc.on('will-prevent-unload', (event) => {
      // Confirmed in Aqua's dialog a moment ago: this is the repeated close or navigation.
      if (Date.now() < this.leaveConfirmedUntil) {
        this.leaveConfirmedUntil = 0
        event.preventDefault()
        return
      }
      const closing = this.closing
      const intent = this.lastIntent && Date.now() - this.lastIntent.at < LEAVE_INTENT_MS ? this.lastIntent : null
      if (!closing && !intent) {
        // A navigation the page started itself (a link, a script): the answer is needed synchronously,
        // before Aqua could learn where it leads, so the system dialog asks.
        const choice = dialog.showMessageBoxSync(host.window, {
          type: 'question',
          message: 'Leave site?',
          detail: 'Changes you made may not be saved.',
          buttons: ['Leave', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        })
        if (choice === 0) event.preventDefault()
        return
      }
      // Stay for now, ask in Aqua's own (themed, tab-modal) dialog, and repeat the action on "Leave".
      if (closing) {
        this.closing = false
        if (this.closeTimer) clearTimeout(this.closeTimer)
        this.closeTimer = null
        host.onTabCloseCancelled(this)
      }
      if (this.askingToLeave) return
      this.askingToLeave = true
      const repeat = closing ? () => host.requestTabClose(this) : intent!.repeat
      const origin = webOrigin(this.url) || originOf(this.url)
      void host.requestPrompt(this, { kind: 'leave', origin }).then((response) => {
        this.askingToLeave = false
        if (this.disposed) return
        if (response?.kind !== 'leave' || !response.leave) {
          if (closing) host.onTabCloseDeclined(this)
          return
        }
        this.leaveConfirmedUntil = Date.now() + LEAVE_INTENT_MS
        repeat()
      })
    })

    // Web content may not navigate to privileged or external schemes on its own.
    const guard = (event: Electron.Event, url: string): void => {
      const scheme = schemeOf(url)
      if (WEB_SCHEMES.has(scheme)) return
      event.preventDefault()
      if (!PRIVILEGED_SCHEMES.has(scheme)) void this.openExternal(url, 'page')
    }
    wc.on('will-frame-navigate', (details) => guard(details, details.url))
    wc.on('will-redirect', (details) => {
      guard(details, details.url)
      if (details.defaultPrevented || !details.isMainFrame || details.isSameDocument) return
      // Tracking redirectors (newsletters, t.co …) land on tagged URLs: follow them without the tags.
      const cleaned = this.withoutTracking(details.url)
      if (!cleaned) return
      details.preventDefault()
      this.load(cleaned)
    })

    wc.setWindowOpenHandler((details) => {
      const scheme = schemeOf(details.url)
      if (!WEB_SCHEMES.has(scheme) && details.url !== '') {
        if (!PRIVILEGED_SCHEMES.has(scheme)) void this.openExternal(details.url, 'page')
        return { action: 'deny' }
      }
      const hasGesture = Date.now() - this.lastUserInput < POPUP_GESTURE_WINDOW_MS
      if (!hasGesture) {
        if (details.url && details.url !== 'about:blank') {
          this.blockedPopupUrls.push(details.url)
          if (this.blockedPopupUrls.length > 20) this.blockedPopupUrls.shift()
          changed()
        }
        return { action: 'deny' }
      }
      const disposition: OpenDisposition =
        details.disposition === 'background-tab' ? 'background-tab' : 'foreground-tab'
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: TAB_WEB_PREFERENCES },
        createWindow: (options) => {
          // window.open and target=_blank: Chromium has already created the page, passed in
          // `options.webContents` (absent from the typings); adopting it keeps `window.opener`.
          const guest = (options as { webContents?: WebContents }).webContents
          if (guest) {
            host.onTabAdoptGuest(this, guest, disposition)
            return guest
          }
          // A link opened with the middle button or a modifier key: Chromium creates no page for
          // it, so it opens like "Open link in new tab". Electron uses the return value only when
          // it passed a guest, so there is nothing to return here.
          host.onTabOpen(this, details.url, disposition)
          return undefined as unknown as WebContents
        }
      }
    })

    wc.once('destroyed', () => this.finalize())
  }

  private async promptUnresponsive(wc: WebContents): Promise<void> {
    if (this.unresponsiveDialog || this.closing) return
    const controller = new AbortController()
    this.unresponsiveDialog = controller
    try {
      // Withdrawn by the controller's signal as soon as the page responds again.
      const response = await this.host.requestPrompt(
        this,
        { kind: 'unresponsive', title: this.title || this.url },
        controller.signal
      )
      if (response?.kind === 'unresponsive' && response.exit && !wc.isDestroyed()) wc.forcefullyCrashRenderer()
    } finally {
      this.unresponsiveDialog = null
    }
  }

  /** Remembers how to repeat a navigation Aqua starts, for the "Leave site?" question it may raise. */
  private noteIntent(repeat: () => void): void {
    this.lastIntent = { at: Date.now(), repeat }
  }

  private finalize(): void {
    if (this.disposed) return
    this.disposed = true
    this.closing = true
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = null
    this.unresponsiveDialog?.abort()
    const view = this.view
    this.view = null
    if (view && !this.host.window.isDestroyed()) {
      try {
        this.host.window.contentView.removeChildView(view)
      } catch {
        /* already detached */
      }
    }
    this.host.onTabClosed(this)
  }
}

function schemeOf(url: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)
  return match ? `${match[1].toLowerCase()}:` : ''
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** Origin of an http(s) page, or '' for anything a grant must not be tied to. */
function webOrigin(url: string): string {
  return /^https?:/i.test(url) ? originOf(url) : ''
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
