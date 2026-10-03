import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  powerMonitor,
  screen,
  session,
  webContents,
  type Session,
  type WebContents
} from 'electron'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { AppContext, WindowOptions } from './app-context'
import type { Tab } from './browser/tab'
import { BrowserWindowController } from './browser/window-controller'
import { registerIpc } from './ipc'
import { appendErrorLog, formatErrorEntry, redactForLog } from './lib/error-log'
import { resolveProfileLocation } from './lib/profile-location'
import { mark } from './lib/startup-trace'
import { installInternalProtocol, installUiProtocol, registerSchemes, UI_HOST, UI_SCHEME } from './protocols'
import { createServices, flushAll, type Services } from './services'
import { migrateLegacyProfile, removeDefaultSessionLeftovers } from './services/legacy-profile'
import { fitToDisplays } from './services/session'
import type { UpdaterOptions } from './services/updater'
import { performPendingWipe } from './services/vault'
import type { EventMap } from '../shared/ipc'
import type { AutoLockTime, BrowserSettings } from '../shared/types'

const DEV_UI_URL = process.env['ELECTRON_RENDERER_URL']
const AUTO_LOCK_MS: Record<AutoLockTime, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  never: 0
}

// ─── Pre-ready configuration ─────────────────────────────────────────────────

/** Whether files can be created in `dir` (a portable build on a read-only drive cannot keep its data there). */
function writableFolder(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.write-test-${process.pid}`)
    writeFileSync(probe, '')
    rmSync(probe)
    return true
  } catch {
    return false
  }
}

// Where the profile lives: AQUA_USER_DATA_DIR (testing, a second identity), the AquaData folder of a
// portable copy (so it travels with the drive and leaves nothing on the computer it runs on), or the
// usual per-user folder. See lib/profile-location.ts.
const profileLocation = resolveProfileLocation({
  env: process.env,
  exeDir: dirname(app.getPath('exe')),
  isPackaged: app.isPackaged,
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  isWritable: writableFolder
})
if (profileLocation.path) app.setPath('userData', profileLocation.path)
// Development only: where an isolated test profile saves downloads. Normalised: Chromium fails every
// download when the downloads folder is set with forward slashes.
if (!app.isPackaged && process.env['AQUA_DOWNLOADS_DIR'])
  app.setPath('downloads', resolve(process.env['AQUA_DOWNLOADS_DIR']))

/**
 * Only a copy installed by Aqua-Browser-Setup.exe updates itself: the installer leaves its
 * uninstaller next to the program (electron-builder's NSIS template). A portable copy, wherever
 * its profile lives, is replaced by hand. Development builds can test the updater against a local
 * server with AQUA_UPDATE_CONFIG=<app-update.yml>.
 */
function updaterOptions(): UpdaterOptions {
  const devConfig = app.isPackaged ? undefined : process.env['AQUA_UPDATE_CONFIG']
  if (devConfig) return { disabledReason: null, devConfigPath: resolve(devConfig) }
  if (!app.isPackaged) return { disabledReason: 'development' }
  const installed = existsSync(join(dirname(app.getPath('exe')), 'Uninstall Aqua Browser.exe'))
  return { disabledReason: installed ? null : 'portable' }
}

/**
 * A packaged Aqua never runs with a remote debugging endpoint: it would hand
 * every open page, its cookies and storage to any local program (info-stealers
 * relaunch browsers with exactly these switches). Development builds keep them.
 */
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address']
if (app.isPackaged && DEBUG_SWITCHES.some((name) => app.commandLine.hasSwitch(name))) {
  console.error('[aqua] refusing to start with remote debugging enabled')
  app.exit(1)
}

/** The regular browsing session. Not "persist:": cookies and site data never touch the disk (see CookieJar). */
const BROWSING_PARTITION = 'aqua-browsing'

mark('main script')
registerSchemes()
// Every renderer is sandboxed, including ones created implicitly (popups, devtools).
app.enableSandbox()
// Must equal `appId` in electron-builder.json: the installer stamps it on the Start menu and desktop
// shortcuts, and Windows groups a window with its pinned shortcut only when the two match.
if (process.platform === 'win32') app.setAppUserModelId('com.aquabrowser.app')

// Present as the Chromium build we actually ship: many sites reject "Electron/x" UAs.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s?Electron\/\S+/i, '')
  .replace(new RegExp(`\\s?${app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\S+`, 'i'), '')

// ─── Application ─────────────────────────────────────────────────────────────

class AquaApp implements AppContext {
  readonly services: Services
  readonly uiSession: Session
  readonly preloadPath = join(__dirname, '../preload/index.js')
  /** Page protections for every frame of the browsing session (see preload/tab.ts). */
  private readonly tabPreloadPath = join(__dirname, '../preload/tab.js')

  private readonly controllers = new Set<BrowserWindowController>()
  /** The regular browsing session: created at the first unlock, once the saved cookies can be read. */
  private regular: Session | null = null
  /** Set once the cookie jar has had its final save. */
  private savedForQuit = false
  private quitting = false
  /** Set once the final window saved the session, so quitting cannot overwrite it with nothing. */
  private sessionFinal = false
  private sessionTimer: NodeJS.Timeout | null = null
  /** URLs handed to Aqua (command line, second instance) while the vault was locked. */
  private pendingUrls: string[] = []
  /** Last private partition stamp, so two windows opened in the same millisecond still get their own. */
  private privateStamp = 0

  constructor() {
    this.uiSession = session.fromPartition('aqua-ui')
    this.services = createServices(
      app.getPath('userData'),
      {
        ask: (webContents, request) => {
          const hit = this.tabForWebContents(webContents)
          return hit ? hit.controller.requestPrompt(hit.tab, request) : Promise.resolve(null)
        }
      },
      updaterOptions()
    )
  }

  start(): void {
    const { services } = this
    // Websites see the OS colour scheme unless Settings → Appearance overrides it
    // per tab; Aqua's own theme is applied by the UI and the native palette.
    nativeTheme.themeSource = 'system'
    this.hardenSessions()
    if (!DEV_UI_URL) installUiProtocol(this.uiSession, join(__dirname, '../renderer'))

    services.certificates.installAppHandler()

    registerIpc({
      services,
      uiOrigin: () => this.uiOrigin(),
      windowForUi: (wc) => [...this.controllers].find((c) => c.window.webContents === wc) ?? null,
      tabForWebContents: (wc) => this.tabForWebContents(wc),
      browsingSession: () => this.regular,
      profileLocation
    })
    this.wireServices()
    this.installAutoLock()
    this.installMenu()

    // The first window opens straight away (behind the lock screen); its tabs
    // come from the encrypted profile, so they are created once it is unlocked.
    this.pendingUrls = urlsFromArgv(process.argv)
    const first = this.openWindow({ startup: true })
    mark('first window created')
    // The filter engine is only needed after the unlock: let the window draw first.
    const startBlocker = (): void => services.contentBlocker.start()
    first.window.once('ready-to-show', () => {
      mark('first window shown')
      setTimeout(startBlocker, 0)
      services.updater.start()
    })
    setTimeout(startBlocker, 2000).unref()
    services.contentBlocker.setBlockedListener((id) => this.countBlocked(id))
    // Downloads a page starts on its own are limited per tab (see DownloadGate).
    services.downloads.setGate((source, filename) => {
      const hit = source && !source.isDestroyed() ? this.tabForWebContents(source) : null
      return hit ? hit.tab.gateDownload(filename) : true
    })
    services.vault.opened.on(() => void this.startBrowsing().then(() => this.openStartupTabs(first)))

    app.on('second-instance', (_e, argv) => {
      if (!this.quitting) this.openUrls(urlsFromArgv(argv))
    })
    app.on('open-url', (event, url) => {
      event.preventDefault()
      this.openUrls([url])
    })
    app.on('activate', () => {
      if (this.controllers.size === 0) this.openWindow()
    })
    screen.on('display-metrics-changed', () => this.controllers.forEach((c) => c.layout()))
  }

  // ─── AppContext ────────────────────────────────────────────────────────────

  uiUrl(): string {
    return DEV_UI_URL ?? `${UI_SCHEME}://${UI_HOST}/index.html`
  }

  uiOrigin(): string {
    return DEV_UI_URL ? new URL(DEV_UI_URL).origin : `${UI_SCHEME}://${UI_HOST}`
  }

  isQuitting(): boolean {
    return this.quitting
  }

  openWindow(options: WindowOptions = {}): BrowserWindowController {
    const browsing = options.private
      ? this.createPrivateSession()
      : { session: () => this.regularSession(), partition: null }
    if (!options.private) this.sessionFinal = false
    const controller = new BrowserWindowController(this, options, browsing)
    this.controllers.add(controller)
    return controller
  }

  windows(): BrowserWindowController[] {
    return [...this.controllers]
  }

  sessionChanged(): void {
    // Before the first unlock the saved session is unreadable: never overwrite it.
    if (this.quitting || this.sessionFinal || this.sessionTimer || !this.services.db.isUnlocked) return
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null
      this.saveSession()
    }, 1000)
  }

  windowClosing(controller: BrowserWindowController): void {
    // Private windows leave nothing behind, not even their size and position.
    if (this.quitting || controller.isPrivate) return
    const geometry = { bounds: controller.window.getNormalBounds(), maximized: controller.window.isMaximized() }
    if (!this.services.db.isUnlocked) {
      this.services.session.save(this.services.session.windows(), geometry)
      return
    }
    const others = [...this.controllers].filter((c) => c !== controller && !c.isPrivate)
    if (others.length === 0 && process.platform !== 'darwin') {
      // Last window on Windows/Linux: the app quits next, so this snapshot is final.
      this.services.session.save([controller.snapshot()], geometry)
      this.sessionFinal = true
    } else {
      this.services.session.save(
        others.map((c) => c.snapshot()),
        geometry
      )
    }
  }

  windowCloseCancelled(): void {
    // A quit stops with the window that stayed (Electron cancels it): Aqua is running on as usual.
    this.quitting = false
    this.services.updater.quitCancelled()
  }

  windowClosed(controller: BrowserWindowController): void {
    this.controllers.delete(controller)
    if (controller.partition !== null) void this.discardPrivateSession(controller.session, controller.partition)
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** True until the cookies have had their final save; the quit waits for it (see the boot code). */
  needsFinalSave(): boolean {
    return !this.savedForQuit && this.regular !== null && this.services.db.isUnlocked
  }

  /** Last save of the cookie jar into the vault, as Aqua quits. */
  async finalSave(): Promise<void> {
    this.savedForQuit = true
    await this.services.cookies.save()
    this.services.db.flush()
  }

  beforeQuit(): void {
    if (this.quitting) return
    this.quitting = true
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    if (!this.sessionFinal && this.controllers.size > 0 && this.services.db.isUnlocked) this.saveSession()
    flushAll(this.services)
  }

  private saveSession(): void {
    const windows = [...this.controllers].filter((c) => !c.isPrivate)
    if (windows.length === 0) return
    this.services.session.save(windows.map((c) => c.snapshot()))
  }

  /** The focused window, else the most recent one; `regular` skips private windows. */
  private lastFocused(regular = false): BrowserWindowController | null {
    const focused = BrowserWindow.getFocusedWindow()
    const list = [...this.controllers].filter((c) => !regular || !c.isPrivate)
    return list.find((c) => c.window === focused) ?? list[list.length - 1] ?? null
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  private regularSession(): Session {
    if (!this.regular) throw new Error('the profile is still sealed: unlock first')
    return this.regular
  }

  /**
   * First unlock: create the browsing session, put the saved cookies back in
   * and wait (briefly) for the filter lists, so the first page loads already
   * signed in and already filtered.
   */
  private async startBrowsing(): Promise<void> {
    if (this.regular) return
    const { services } = this
    const ses = session.fromPartition(BROWSING_PARTITION)
    this.regular = ses
    this.configureBrowsing(ses, null)
    await Promise.all([services.cookies.attach(ses), services.contentBlocker.whenReady(8000)])
    await migrateLegacyProfile(app.getPath('userData'), services.db, services.cookies)
  }

  /** What every browsing session gets: page protections, certificates, permissions, downloads, blocking. */
  private configureBrowsing(ses: Session, partition: string | null): void {
    const { services } = this
    // Websites get the languages of this computer (Aqua ships only its English interface locale).
    ses.setUserAgent(ses.getUserAgent(), acceptLanguages())
    installInternalProtocol(ses)
    ses.registerPreloadScript({ type: 'frame', id: 'aqua-page', filePath: this.tabPreloadPath })
    services.certificates.attach(ses)
    services.permissions.attach(ses, { private: partition !== null })
    services.downloads.attach(ses, partition)
    services.contentBlocker.attach(ses, partition)
  }

  /**
   * A private window's session. Without the "persist:" prefix Chromium keeps
   * its cookies, cache and site storage in memory only; nothing is written to
   * the profile directory.
   */
  private createPrivateSession(): { session: () => Session; partition: string } {
    this.privateStamp = Math.max(Date.now(), this.privateStamp + 1)
    const partition = `incognito-${this.privateStamp}`
    const ses = session.fromPartition(partition)
    this.configureBrowsing(ses, partition)
    return { session: () => ses, partition }
  }

  /** A private window closed: drop everything its session still holds in memory. */
  private async discardPrivateSession(ses: Session, partition: string): Promise<void> {
    this.services.downloads.discard(partition)
    this.services.contentBlocker.forgetPartition(partition)
    await Promise.allSettled([
      ses.clearStorageData(),
      ses.clearCache(),
      ses.clearAuthCache(),
      ses.clearHostResolverCache(),
      ses.clearCodeCaches({ urls: [] }),
      ses.closeAllConnections()
    ])
  }

  /** The blocker cancelled (or neutered) a request from this page. */
  private countBlocked(webContentsId: number): void {
    const hit = this.tabForWebContentsId(webContentsId)
    if (!hit) return
    hit.tab.blockedCount++
    hit.controller.onTabChanged(hit.tab)
  }

  private windowForWebContents(wc: WebContents): BrowserWindowController | null {
    for (const c of this.controllers) {
      if (c.window.webContents === wc || c.findTabByWebContentsId(wc.id)) return c
    }
    return null
  }

  private tabForWebContents(wc: WebContents): { controller: BrowserWindowController; tab: Tab } | null {
    return this.tabForWebContentsId(wc.id)
  }

  private tabForWebContentsId(id: number): { controller: BrowserWindowController; tab: Tab } | null {
    for (const controller of this.controllers) {
      const tab = controller.findTabByWebContentsId(id)
      if (tab) return { controller, tab }
    }
    return null
  }

  private broadcast<K extends keyof EventMap>(channel: K, ...args: Parameters<EventMap[K]>): void {
    for (const c of this.controllers) c.sendUi(channel, ...args)
  }

  /** Links from other applications: open as tabs now, or right after the next unlock. Never in a private window. */
  private openUrls(urls: string[]): void {
    const target = this.lastFocused(true)
    if (!target) {
      this.openWindow({ urls })
      return
    }
    if (target.window.isMinimized()) target.window.restore()
    target.window.focus()
    if (this.services.vault.isOpen()) for (const url of urls) target.createTab({ url })
    else this.pendingUrls.push(...urls)
  }

  /** Startup behaviour (Settings → On startup), plus any URLs Aqua was launched with. */
  private openStartupTabs(first: BrowserWindowController): void {
    const { settings, session: sessions } = this.services
    const urls = this.pendingUrls.splice(0)
    const s = settings.get()
    const target = this.controllers.has(first) ? first : this.openWindow({ startup: true })
    if (s.startupBehavior === 'continue') {
      const saved = sessions.windows()
      if (saved.length > 0) {
        target.initTabs(saved[0], saved.length === 1 ? urls : [])
        saved.slice(1).forEach((w, i, rest) => {
          this.openWindow({
            restore: w,
            bounds: fitToDisplays(w.bounds),
            maximized: w.maximized,
            urls: i === rest.length - 1 ? urls : []
          })
        })
        return
      }
    } else if (s.startupBehavior === 'pages' && s.startupPages.length > 0) {
      target.initTabs(null, [...s.startupPages, ...urls])
      return
    }
    target.initTabs(null, urls)
  }

  private wireServices(): void {
    const s = this.services
    let lastSettings = s.settings.get()
    s.settings.changed.on((next) => {
      if (next.darkStyle !== lastSettings.darkStyle || next.theme !== lastSettings.theme) {
        this.controllers.forEach((c) => c.onThemeChanged())
      }
      if (next.websiteAppearance !== lastSettings.websiteAppearance) {
        this.controllers.forEach((c) => c.applyWebsiteAppearance())
      }
      if (next.blockerPausedSites.join() !== lastSettings.blockerPausedSites.join()) {
        this.controllers.forEach((c) => c.refreshBlockerState())
      }
      // Pages stay hidden behind the first-run welcome until it is done (see syncViews).
      if (next.onboardingCompleted !== lastSettings.onboardingCompleted) this.controllers.forEach((c) => c.syncViews())
      if (next.webrtcProxyOnly !== lastSettings.webrtcProxyOnly) {
        // Calls already connected keep their route; new connections follow the setting.
        const policy = webrtcPolicy(next)
        for (const contents of webContents.getAllWebContents()) contents.setWebRTCIPHandlingPolicy(policy)
      }
      lastSettings = next
      this.broadcast('settings:changed', next)
    })
    nativeTheme.on('updated', () => this.controllers.forEach((c) => c.onThemeChanged()))

    s.bookmarks.changed.on((list) => this.broadcast('bookmarks:changed', list))
    // A download is shown only in the windows of its own session.
    s.downloads.changed.on(({ entry, partition }) => {
      for (const c of this.controllers) if (c.partition === partition) c.sendUi('downloads:changed', entry)
    })
    s.downloads.reset.on(({ entries, partition }) => {
      for (const c of this.controllers) if (c.partition === partition) c.sendUi('downloads:reset', entries)
    })
    s.downloads.started.on(({ source }) => {
      const controller = source ? this.windowForWebContents(source) : this.lastFocused()
      controller?.onDownloadStarted(source)
    })
    s.downloads.sourceIdle.on((id) => this.controllers.forEach((c) => c.onDownloadSourceIdle(id)))
    s.downloads.progress.on(({ value, paused }) => this.controllers.forEach((c) => c.setTaskbarProgress(value, paused)))
    s.contentBlocker.changed.on((info) => this.broadcast('blocker:changed', info))
    s.ntpImage.changed.on(() => this.broadcast('ntp:image-changed'))
    s.updater.changed.on((status) => this.broadcast('updater:status', status))

    s.vault.changed.on((status) => {
      this.broadcast('vault:changed', status)
      this.controllers.forEach((c) => c.onVaultChanged())
      // Links that arrived while locked (after startup, which handles its own).
      if (status.state === 'unlocked' && this.pendingUrls.length > 0 && s.db.isUnlocked) {
        const target = this.lastFocused(true)
        if (target && target.allTabs().length > 0)
          for (const url of this.pendingUrls.splice(0)) target.createTab({ url })
      }
    })
  }

  private installAutoLock(): void {
    const { vault, settings } = this.services
    const lock = (): void => vault.lock()
    powerMonitor.on('lock-screen', lock)
    powerMonitor.on('suspend', lock)
    setInterval(() => {
      const limit = AUTO_LOCK_MS[settings.get().autoLockTimer]
      if (!limit || !vault.isOpen()) return
      if (powerMonitor.getSystemIdleTime() * 1000 >= limit) vault.lock()
    }, 15_000).unref()
  }

  private installMenu(): void {
    if (process.platform !== 'darwin') {
      // No menu bar on Windows/Linux; this also removes Electron's default
      // accelerators (e.g. Ctrl+R reloading the browser UI itself).
      Menu.setApplicationMenu(null)
      return
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
  }

  /** Session-level hardening that applies regardless of window. */
  private hardenSessions(): void {
    this.uiSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    this.uiSession.setPermissionCheckHandler(() => false)
    this.uiSession.on('will-download', (event) => event.preventDefault())

    // The default session is persistent (it keeps its files in the profile folder), so no page may
    // ever load in it: every browsing session is created explicitly. Refusing its web traffic makes
    // a slip - a view created without a session - fail loudly instead of writing cookies to disk.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, done) => {
        console.error(`[aqua] blocked a request in the default session: ${details.url}`)
        done({ cancel: true })
      }
    )

    app.on('web-contents-created', (_event, contents) => {
      // No <webview> anywhere: tabs are WebContentsViews owned by the main process.
      contents.on('will-attach-webview', (e) => e.preventDefault())
      // Electron has no session-wide WebRTC switch: every page (tabs, popups) is set as it is created.
      contents.setWebRTCIPHandlingPolicy(webrtcPolicy(this.services.settings.get()))
    })
  }
}

/**
 * How pages may connect for WebRTC (calls, screen sharing, P2P transfers).
 * - Default: only through the default network route (a VPN's, when one is on), and local network
 *   addresses are never offered to the other side. Voice servers such as Discord's need direct UDP,
 *   which this allows.
 * - Proxy only: no direct UDP at all, so nothing bypasses a proxy; without a proxy, calls can't connect.
 */
function webrtcPolicy(settings: BrowserSettings): 'default_public_interface_only' | 'disable_non_proxied_udp' {
  return settings.webrtcProxyOnly ? 'disable_non_proxied_udp' : 'default_public_interface_only'
}

/** The system's preferred languages as an Accept-Language list, each followed by its base language. */
function acceptLanguages(): string {
  const tags = app.getPreferredSystemLanguages().flatMap((tag) => {
    const base = tag.split('-')[0]
    return base && base !== tag ? [tag, base] : [tag]
  })
  const list = [...new Set(tags.filter(Boolean))]
  return (list.length ? list : ['en-US', 'en']).join(',')
}

function urlsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((arg) => /^(https?|file):\/\//i.test(arg))
}

// ─── Errors nothing else caught ─────────────────────────────────────────────

/**
 * The last stop for errors no code path caught, instead of Electron's dialog with the stack:
 *   1. the details go to the local log only (`<profile>/logs/main.log`, scrubbed: lib/error-log.ts);
 *   2. the user gets a short notice, with no paths or stack;
 *   3. an open vault is locked (its key zeroed): Aqua never runs on in an unknown state with the
 *      key in memory. Unlocking again is a deliberate step.
 */
function installErrorGuards(current: () => AquaApp | null): void {
  let noticeShown = false
  const handle = (kind: string, error: unknown): void => {
    try {
      const versions = `Aqua ${app.getVersion()}, Electron ${process.versions.electron}`
      const entry = formatErrorEntry(kind, error, new Date(), versions)
      appendErrorLog(app.getPath('userData'), redactForLog(entry, homedir()))

      const running = current()
      if (running?.isQuitting()) return
      let locked = false
      if (running?.services.vault.isOpen()) {
        running.services.vault.lock()
        locked = true
      }
      // One notice at a time: an error that repeats doesn't stack dialogs.
      if (noticeShown) return
      noticeShown = true
      const message = 'Aqua ran into an unexpected error.'
      const detail = locked
        ? 'Your vault was locked to keep it safe. Unlock it to continue.'
        : 'You can keep using Aqua. If something stops working, restart it.'
      if (!app.isReady()) {
        dialog.showErrorBox(message, detail)
        noticeShown = false
        return
      }
      const options = { type: 'error' as const, title: 'Aqua', message, detail, buttons: ['OK'], noLink: true }
      const parent = BrowserWindow.getFocusedWindow()
      void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).finally(() => {
        noticeShown = false
      })
    } catch {
      // Nothing more can be done here; throwing would end the process.
    }
  }
  process.on('uncaughtException', (error) => handle('uncaughtException', error))
  process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason))
}

// ─── Boot ────────────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // A wipe confirmed in the previous run is finished before anything opens the profile.
  if (performPendingWipe(app.getPath('userData'))) console.info('[vault] profile wiped')
  // Likewise, before Chromium opens (and later rewrites) them.
  removeDefaultSessionLeftovers(app.getPath('userData'))
  let aqua: AquaApp | null = null
  installErrorGuards(() => aqua)
  app.whenReady().then(() => {
    mark('app ready')
    aqua = new AquaApp()
    mark('services loaded')
    aqua.start()
  })
  app.on('before-quit', () => aqua?.beforeQuit())
  // Every window is closed by now: save the cookies one last time, close the vault (zeroing its key), then really exit.
  let finalSaving = false
  app.on('will-quit', (event) => {
    const running = aqua
    if (!running) return
    // A second quit while the final save runs: that save exits when it is done.
    if (finalSaving) {
      event.preventDefault()
      return
    }
    if (!running.needsFinalSave()) {
      running.services.db.close()
      running.services.updater.installOnExit()
      return
    }
    finalSaving = true
    event.preventDefault()
    void running.finalSave().finally(() => {
      running.services.db.close()
      // app.exit() skips the "quit" event electron-updater listens for: start a downloaded update here.
      running.services.updater.installOnExit()
      app.exit(0)
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
