import {
  app,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
  type WebFrameMain
} from 'electron'
import {
  JS_DIALOG_CHANNEL,
  PAGE_COSMETICS_CHANNEL,
  PAGE_START_CHANNEL,
  PAGE_STORAGE_CHANNEL,
  type InvokeMap,
  type JsDialogRequest,
  type PageStart,
  type SendMap
} from '../shared/ipc'
import type {
  BrowserSettings,
  ClearDataKind,
  ClearDataSummary,
  CommandId,
  ContextMenuRequest,
  DownloadAction,
  NavigateOptions,
  OverlayPlacement,
  OverlayRole,
  PermissionKind,
  PromptResponse,
  Rect,
  SiteInfo,
  UiBootstrap
} from '../shared/types'
import { showUiContextMenu } from './browser/menus'
import type { Tab } from './browser/tab'
import type { BrowserWindowController } from './browser/window-controller'
import type { ProfileLocation } from './lib/profile-location'
import { storageReport } from './services/storage-report'
import { persistsStorage, sanitizeStorageItems, webOriginOf } from './lib/site-storage'
import { ValidationError, arr, bool, int, num, obj, oneOf, optStr, str } from './lib/validate'
import { classifyInput } from './omnibox/classify'
import { suggest } from './omnibox/suggest'
import type { Services } from './services'
import { normalizeWebAddress } from '../shared/url'
import { originOf } from './services/permissions'
import { WIPE_CONFIRMATION } from './services/vault'

export interface IpcHost {
  services: Services
  uiOrigin(): string
  windowForUi(webContents: WebContents): BrowserWindowController | null
  tabForWebContents(webContents: WebContents): { controller: BrowserWindowController; tab: Tab } | null
  /** The regular browsing session; null while the encrypted profile has not been unsealed. */
  browsingSession(): Session | null
  /** Where the profile lives (decided at start-up). */
  profileLocation: ProfileLocation
}

interface Ctx {
  controller: BrowserWindowController
  services: Services
}

type Handler<K extends keyof InvokeMap> = (
  ctx: Ctx,
  ...args: unknown[]
) => ReturnType<InvokeMap[K]> | Promise<Awaited<ReturnType<InvokeMap[K]>>>

const COMMANDS: readonly CommandId[] = [
  'tab.new',
  'tab.close',
  'tab.reopen',
  'tab.next',
  'tab.prev',
  'tab.select',
  'tab.duplicate',
  'window.new',
  'window.new-private',
  'window.close',
  'window.fullscreen',
  'nav.back',
  'nav.forward',
  'nav.reload',
  'nav.reload-hard',
  'nav.stop',
  'omnibox.focus',
  'find.open',
  'find.next',
  'find.prev',
  'bookmark.page',
  'bookmarks.toggle-bar',
  'page.zoom-in',
  'page.zoom-out',
  'page.zoom-reset',
  'page.print',
  'page.view-source',
  'page.devtools',
  'open.history',
  'open.downloads',
  'open.settings',
  'vault.lock',
  'app.quit'
]
const OVERLAY_ROLES: readonly OverlayRole[] = ['popup', 'modal', 'status', 'findbar']
const DOWNLOAD_ACTIONS: readonly DownloadAction[] = ['pause', 'resume', 'cancel', 'retry', 'open', 'show', 'remove']
const CLEAR_KINDS: readonly ClearDataKind[] = ['history', 'downloads', 'cache', 'cookies']
const PERMISSIONS: readonly PermissionKind[] = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'midi',
  'clipboard-read'
]
const OPEN_DISPOSITIONS = ['current', 'new-tab', 'background-tab'] as const
const NAV_DISPOSITIONS = ['current', 'new-tab', 'background-tab', 'new-window'] as const
const DIALOG_KINDS = ['alert', 'confirm', 'prompt'] as const
const PERMISSION_DECISIONS = ['allow', 'block', 'dismiss'] as const
/** "Cookies and other site data" - everything a site can store, except the HTTP cache. */
const SITE_DATA_TYPES = [
  'cookies',
  'localStorage',
  'indexedDB',
  'serviceWorkers',
  'fileSystems',
  'webSQL',
  'backgroundFetch'
] as const

/** Channels that operate on browsing data and therefore require an unlocked vault. */
const REQUIRES_UNLOCK =
  /^(tabs|nav|omnibox|prompt|site|bookmarks|downloads|history|shortcuts|blocker|find|settings|ntp|storage|updater):/

export function registerIpc(host: IpcHost): void {
  const { services } = host

  /**
   * Only the top frame of a window's UI renderer, served from the UI origin,
   * may talk to the main process. Overlay documents are driven by that same
   * renderer and never call IPC themselves.
   */
  function context(event: IpcMainInvokeEvent | IpcMainEvent, channel: string): Ctx {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) throw new Error(`[ipc] ${channel}: rejected sub-frame sender`)
    // Built manually: WHATWG `URL.origin` is "null" for custom schemes such as aqua-ui:.
    let origin = ''
    try {
      const url = new URL(frame.url)
      origin = `${url.protocol}//${url.host}`
    } catch {
      /* fallthrough */
    }
    if (origin !== host.uiOrigin())
      throw new Error(`[ipc] ${channel}: rejected untrusted origin ${origin || frame.url}`)
    const controller = host.windowForUi(event.sender)
    if (!controller) throw new Error(`[ipc] ${channel}: no window for sender`)
    if (REQUIRES_UNLOCK.test(channel) && !services.vault.isOpen()) throw new Error(`[ipc] ${channel}: vault is locked`)
    return { controller, services }
  }

  function handle<K extends keyof InvokeMap>(channel: K, handler: Handler<K>): void {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(context(event, channel), ...args)
      } catch (err) {
        if (err instanceof ValidationError) throw new Error(`[ipc] ${channel}: ${err.message}`)
        throw err
      }
    })
  }

  function on<K extends keyof SendMap>(channel: K, handler: (ctx: Ctx, ...args: unknown[]) => void): void {
    ipcMain.on(channel, (event, ...args) => {
      try {
        handler(context(event, channel), ...args)
      } catch (err) {
        console.warn(String(err))
      }
    })
  }

  const tabOf = (ctx: Ctx, id: unknown) => ctx.controller.getTab(str(id, 64))

  const rect = (raw: unknown): Rect => {
    const r = obj(raw)
    return {
      x: num(r.x, -10000, 10000),
      y: num(r.y, -10000, 10000),
      width: num(r.width, 0, 10000),
      height: num(r.height, 0, 10000)
    }
  }

  // ─── UI ────────────────────────────────────────────────────────────────────

  handle('ui:bootstrap', ({ controller }): UiBootstrap => {
    const open = services.vault.isOpen()
    return {
      platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
      state: controller.state(),
      settings: services.settings.get(),
      bookmarks: open ? services.bookmarks.list() : [],
      downloads: open ? services.downloads.list(controller.partition) : [],
      vault: services.vault.status(),
      contentBlocker: services.contentBlocker.info(),
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8
      }
    }
  })

  handle('ui:command', ({ controller }, command, arg) => {
    controller.run(oneOf(command, COMMANDS), arg === undefined ? undefined : int(arg, -1, 1000))
  })

  handle('ui:context-menu', ({ controller }, raw) => {
    const r = obj(raw)
    let request: ContextMenuRequest
    switch (r.kind) {
      case 'tab':
        request = { kind: 'tab', tabId: str(r.tabId, 64) }
        break
      case 'tabstrip':
        request = { kind: 'tabstrip' }
        break
      case 'bookmark':
        request = { kind: 'bookmark', bookmarkId: str(r.bookmarkId, 64) }
        break
      case 'bookmarks-overflow':
        request = {
          kind: 'bookmarks-overflow',
          bookmarkIds: arr(r.bookmarkIds, (v) => str(v, 64), 5000),
          x: num(r.x),
          y: num(r.y)
        }
        break
      case 'nav-history':
        request = {
          kind: 'nav-history',
          direction: oneOf(r.direction, ['back', 'forward'] as const),
          x: num(r.x),
          y: num(r.y)
        }
        break
      case 'omnibox':
        request = { kind: 'omnibox', hasSelection: bool(r.hasSelection), canUndo: bool(r.canUndo) }
        break
      default:
        throw new ValidationError('unknown menu kind')
    }
    showUiContextMenu(controller, request)
  })

  on('ui:content-top', ({ controller }, top) => controller.setContentTop(num(top, 0, 2000)))
  on('ui:focus-content', ({ controller }) => controller.focusContent())
  on('ui:overlay-show', ({ controller }, role, rawPlacement, focus) => {
    const p = obj(rawPlacement)
    let placement: OverlayPlacement
    switch (p.type) {
      case 'rect':
        placement = { type: 'rect', rect: rect(p.rect) }
        break
      case 'content-top-right':
        placement = {
          type: 'content-top-right',
          width: num(p.width, 0, 4000),
          height: num(p.height, 0, 4000),
          right: num(p.right, -100, 4000),
          top: num(p.top, -200, 4000)
        }
        break
      case 'content':
        placement = { type: 'content' }
        break
      case 'content-anchored':
        placement = {
          type: 'content-anchored',
          left: num(p.left, -4000, 4000),
          top: num(p.top, -4000, 4000),
          width: num(p.width, 0, 4000),
          height: num(p.height, 0, 4000)
        }
        break
      case 'content-bottom-left':
        placement = { type: 'content-bottom-left', width: num(p.width, 0, 4000), height: num(p.height, 0, 200) }
        break
      default:
        throw new ValidationError('bad placement')
    }
    controller.showOverlay(oneOf(role, OVERLAY_ROLES), placement, bool(focus))
  })
  on('ui:overlay-hide', ({ controller }, role) => controller.hideOverlay(oneOf(role, OVERLAY_ROLES)))

  // ─── Tabs & navigation ─────────────────────────────────────────────────────

  handle('tabs:create', ({ controller }, raw) => {
    const o = raw === undefined ? {} : obj(raw)
    let url = optStr(o.url)
    if (url !== undefined) {
      const c = classifyInput(url)
      if (c.type !== 'url') throw new ValidationError('tabs:create expects a URL')
      url = c.url
    }
    const tab = controller.createTab({
      url,
      background: o.background === undefined ? false : bool(o.background),
      index: o.index === undefined ? undefined : int(o.index, 0, 10000)
    })
    return tab.id
  })
  handle('tabs:activate', (ctx, id, focus) => {
    const tab = tabOf(ctx, id)
    if (tab) ctx.controller.activate(tab, bool(focus) ? 'content' : 'none')
  })
  handle('tabs:close', (ctx, id) => {
    const tab = tabOf(ctx, id)
    if (tab) ctx.controller.closeTab(tab)
  })
  handle('tabs:move', (ctx, id, index) => {
    const tab = tabOf(ctx, id)
    if (tab) ctx.controller.moveTab(tab, int(index, 0, 10000))
  })
  handle('tabs:set-pinned', (ctx, id, pinned) => {
    const tab = tabOf(ctx, id)
    if (tab) ctx.controller.setPinned(tab, bool(pinned))
  })
  handle('tabs:set-muted', (ctx, id, muted) => tabOf(ctx, id)?.setMuted(bool(muted)))
  handle('tabs:duplicate', (ctx, id) => {
    const tab = tabOf(ctx, id)
    if (tab) ctx.controller.duplicate(tab)
  })
  handle('tabs:reload', (ctx, id) => tabOf(ctx, id)?.reload())
  handle('tabs:open-blocked-popup', (ctx, id) => tabOf(ctx, id)?.openLastBlockedPopup())

  handle('nav:go', ({ controller }, input, rawOptions) => {
    const o = rawOptions === undefined ? {} : obj(rawOptions)
    const options: NavigateOptions = {
      disposition: o.disposition === undefined ? 'current' : oneOf(o.disposition, NAV_DISPOSITIONS),
      ctrlEnter: o.ctrlEnter === undefined ? false : bool(o.ctrlEnter)
    }
    controller.goFromOmnibox(str(input, 32768), options)
  })
  handle('nav:proceed-unsafe', (ctx, id) => {
    const tab = tabOf(ctx, id)
    const error = tab?.state().error
    if (!tab || !error) return
    const host = new URL(error.url).hostname
    if (services.certificates.allowException(host)) tab.load(error.url)
  })

  handle('omnibox:suggest', ({ services: s }, text) =>
    suggest(str(text, 2048), { history: s.history, bookmarks: s.bookmarks, engine: s.settings.get().searchEngine })
  )

  // ─── Tab-modal prompts ─────────────────────────────────────────────────────

  handle('prompt:respond', ({ controller }, id, raw) => {
    const r = obj(raw)
    let response: PromptResponse
    switch (r.kind) {
      case 'dialog':
        response = {
          kind: 'dialog',
          accepted: bool(r.accepted),
          value: optStr(r.value, 1024 * 1024),
          suppress: r.suppress === undefined ? undefined : bool(r.suppress)
        }
        break
      case 'external':
        response = { kind: 'external', allow: bool(r.allow), remember: bool(r.remember) }
        break
      case 'permission':
        response = { kind: 'permission', decision: oneOf(r.decision, PERMISSION_DECISIONS) }
        break
      case 'downloads':
        response = { kind: 'downloads', decision: oneOf(r.decision, PERMISSION_DECISIONS) }
        break
      case 'leave':
        response = { kind: 'leave', leave: bool(r.leave) }
        break
      case 'unresponsive':
        response = { kind: 'unresponsive', exit: bool(r.exit) }
        break
      case 'display-capture':
        // Only a source the prompt offered is ever shared (checked where the answer is used).
        response = {
          kind: 'display-capture',
          sourceId: r.sourceId === null ? null : str(r.sourceId, 256),
          audio: bool(r.audio)
        }
        break
      default:
        throw new ValidationError('unknown prompt response')
    }
    controller.respondPrompt(str(id, 64), response)
  })

  // ─── Site info & permissions ───────────────────────────────────────────────

  handle('site:info', (ctx, id): SiteInfo | null => {
    const tab = tabOf(ctx, id)
    if (!tab) return null
    const state = tab.state()
    let host = ''
    try {
      host = new URL(state.url).hostname
    } catch {
      /* internal or opaque URL */
    }
    const origin = originOf(state.url) ?? ''
    const cert = state.url.startsWith('https:') && host ? services.certificates.get(host) : null
    return {
      url: state.url,
      host,
      origin,
      security: state.security,
      certificate: cert?.info ?? null,
      permissions: origin ? services.permissions.forOrigin(origin) : []
    }
  })
  handle('site:permissions', () => services.permissions.list())
  handle('site:reset-permission', (_ctx, origin, permission) =>
    services.permissions.reset(str(origin, 2048), oneOf(permission, PERMISSIONS))
  )
  handle('site:protocol-grants', () => services.protocolGrants.list())
  handle('site:revoke-grant', (_ctx, origin, scheme) =>
    services.protocolGrants.revoke(str(origin, 2048), str(scheme, 64))
  )

  // ─── Bookmarks ─────────────────────────────────────────────────────────────

  handle('bookmarks:add', (_ctx, raw) => {
    const b = obj(raw)
    return services.bookmarks.add({
      url: str(b.url, 32768),
      title: str(b.title, 1024),
      favicon: b.favicon === null ? null : str(b.favicon, 256 * 1024)
    })
  })
  handle('bookmarks:update', (_ctx, id, raw) => {
    const p = obj(raw)
    services.bookmarks.update(str(id, 64), { title: optStr(p.title, 1024), url: optStr(p.url, 32768) })
  })
  handle('bookmarks:remove', (_ctx, id) => services.bookmarks.remove(str(id, 64)))
  handle('bookmarks:move', (_ctx, id, index) => services.bookmarks.move(str(id, 64), int(index, 0, 100000)))
  handle('bookmarks:open', ({ controller }, id, disposition) => {
    const bookmark = services.bookmarks.get(str(id, 64))
    if (!bookmark) return
    const d = oneOf(disposition, OPEN_DISPOSITIONS)
    if (d === 'current') controller.navigateActive(bookmark.url, false, true)
    else controller.createTab({ url: bookmark.url, background: d === 'background-tab' })
  })

  // ─── Downloads / history ───────────────────────────────────────────────────

  // Each window acts on its own session's list: a private window's downloads stay in that window.
  handle('downloads:action', ({ controller }, id, action) =>
    services.downloads.action(str(id, 64), oneOf(action, DOWNLOAD_ACTIONS), controller.partition)
  )
  handle('downloads:clear', ({ controller }) => services.downloads.clearFinished(controller.partition))

  handle('history:query', (_ctx, raw) => {
    const q = obj(raw)
    return services.history.query({
      text: optStr(q.text, 1024),
      before: q.before === undefined ? undefined : num(q.before, 0),
      limit: q.limit === undefined ? 100 : int(q.limit, 1, 500)
    })
  })
  handle('history:remove', (_ctx, ids) => services.history.remove(arr(ids, (v) => str(v, 64), 5000)))
  handle('history:top-sites', (_ctx, limit) => services.history.topSites(int(limit, 1, 24)))

  // ─── New Tab shortcuts ─────────────────────────────────────────────────────

  const shortcutUrl = (raw: unknown): string => {
    const url = normalizeWebAddress(str(raw, 2048))
    if (!url) throw new ValidationError('not a web address')
    return url
  }
  handle('shortcuts:list', () => services.shortcuts.list())
  handle('shortcuts:add', (_ctx, raw) => {
    const s = obj(raw)
    return services.shortcuts.add(str(s.title, 200), shortcutUrl(s.url))
  })
  handle('shortcuts:remove', (_ctx, id) => services.shortcuts.remove(str(id, 300)))
  handle('shortcuts:restore', (_ctx, raw, index) => {
    const s = obj(raw)
    return services.shortcuts.restore(
      { id: str(s.id, 300), title: str(s.title, 200), url: shortcutUrl(s.url), custom: bool(s.custom) },
      int(index, 0, 100)
    )
  })

  // ─── Settings ──────────────────────────────────────────────────────────────

  handle('settings:update', (_ctx, patch) =>
    services.settings.update(obj(patch) as Partial<Record<keyof BrowserSettings, unknown>>)
  )
  /** What each "Clear browsing data" option would remove, shown before anything is deleted. */
  handle('settings:data-summary', async (): Promise<ClearDataSummary> => {
    const browsing = host.browsingSession()
    const [cacheBytes, cookies] = browsing
      ? await Promise.all([browsing.getCacheSize(), browsing.cookies.get({})])
      : [0, []]
    return {
      historyEntries: services.history.size,
      downloadEntries: services.downloads.list().filter((d) => d.status !== 'progressing' && d.status !== 'paused')
        .length,
      cacheBytes,
      cookieCount: cookies.length
    }
  })
  handle('settings:clear-data', async (_ctx, kinds) => {
    const list = arr(kinds, (v) => oneOf(v, CLEAR_KINDS), 4)
    const browsing = host.browsingSession()
    if (list.includes('history')) services.history.clear()
    if (list.includes('downloads')) services.downloads.clearFinished()
    if (list.includes('cache') && browsing) {
      await browsing.clearCache()
      await browsing.clearCodeCaches({ urls: [] })
    }
    if (list.includes('cookies') && browsing) {
      await browsing.clearData({ dataTypes: [...SITE_DATA_TYPES] })
      await browsing.clearStorageData({ storages: ['cachestorage'] })
      await browsing.clearAuthCache()
      // What the vault keeps of them goes too, straight away.
      services.siteStorage.clear()
      await services.cookies.save()
    }
  })

  // ─── Content blocking ──────────────────────────────────────────────────────

  handle('blocker:info', () => services.contentBlocker.info())
  handle('blocker:set-paused', (ctx, id, paused) => {
    const tab = tabOf(ctx, id)
    return tab ? ctx.controller.setBlockerPaused(tab, bool(paused)) : false
  })
  handle('blocker:update-lists', () => services.contentBlocker.updateNow())

  // ─── New Tab page background picture ──────────────────────────────────────

  handle('ntp:image', () => services.ntpImage.get())
  handle('ntp:image-from-file', async ({ controller }) => {
    const result = await services.ntpImage.chooseFile(controller.window)
    if (result?.ok) services.settings.update({ ntpBackground: 'image' })
    return result
  })
  handle('ntp:image-from-url', async (_ctx, url) => {
    const result = await services.ntpImage.fromUrl(str(url, 4096))
    if (result.ok) services.settings.update({ ntpBackground: 'image' })
    return result
  })
  handle('ntp:image-clear', () => {
    services.ntpImage.clear()
    if (services.settings.get().ntpBackground === 'image') services.settings.update({ ntpBackground: 'default' })
  })

  // ─── Storage ──────────────────────────────────────────────────────────────

  handle('storage:info', () => storageReport(host.profileLocation))
  /** Opens one of two known folders in the file manager; never a path chosen by the caller. */
  handle('storage:open', async (_ctx, which) => {
    const report = await storageReport(host.profileLocation)
    const target = oneOf(which, ['profile', 'other'] as const) === 'profile' ? report.path : report.otherProfile
    if (target) await shell.openPath(target)
  })

  // ─── Vault ─────────────────────────────────────────────────────────────────

  // ─── Updates ───────────────────────────────────────────────────────────────

  handle('updater:status', () => services.updater.status())
  handle('updater:check', () => services.updater.check())
  handle('updater:restart', () => services.updater.restartToUpdate(() => app.quit()))

  handle('vault:setup', async (_ctx, password) => {
    const result = await services.vault.setup(str(password, 1024))
    // A brand-new profile: the first-run welcome goes on to its last step (search engine).
    if (result.success) services.settings.update({ onboardingCompleted: false })
    return result
  })
  handle('vault:unlock', (_ctx, password) => services.vault.unlock(str(password, 1024)))
  handle('vault:lock', () => services.vault.lock())
  handle('vault:change-password', (_ctx, oldPassword, newPassword) =>
    services.vault.changePassword(str(oldPassword, 1024), str(newPassword, 1024))
  )
  handle('vault:wipe', async (_ctx, confirmation) => {
    // Only the owner may wipe: a passer-by at the lock screen must not be able to destroy the vault.
    if (!services.vault.isOpen()) return { success: false, error: 'Unlock Aqua to reset it.' }
    const text = str(confirmation, 64)
    if (text !== WIPE_CONFIRMATION) return { success: false, error: `Type ${WIPE_CONFIRMATION} to confirm.` }
    // The files are deleted at relaunch; clear what Chromium can release right now as well.
    const browsing = host.browsingSession()
    if (browsing) await Promise.allSettled([browsing.clearData(), browsing.clearCache()])
    return services.vault.wipe(text)
  })

  // ─── Find in page ──────────────────────────────────────────────────────────

  on('find:query', (ctx, id, text) => {
    const tab = tabOf(ctx, id)
    if (tab) ctx.controller.findQuery(tab, str(text, 1024))
  })
  on('find:step', (ctx, id, forward) => {
    const tab = tabOf(ctx, id)
    if (tab) ctx.controller.findStep(tab, bool(forward))
  })
  on('find:close', (ctx, id) => {
    const tab = tabOf(ctx, id)
    if (tab) ctx.controller.closeFind(tab)
  })

  // ─── Tab preload ───────────────────────────────────────────────────────────

  /**
   * What a frame sets up before any of its scripts run: page settings, the
   * saved localStorage of first-party frames, element hiding and scriptlets.
   * Everything is derived from the browser's own view of the frame (origin,
   * URL, window), never from what the page says. Tabs only.
   */
  function pageStart(controller: BrowserWindowController, frame: WebFrameMain, top: WebFrameMain): PageStart {
    const origin = webOriginOf(frame.origin)
    const topOrigin = webOriginOf(top.origin)
    const persistStorage =
      !controller.isPrivate && origin !== null && topOrigin !== null && persistsStorage(origin, topOrigin)
    return {
      stripTrackingParams: services.settings.get().stripTrackingParams,
      persistStorage,
      storage: persistStorage && origin ? services.siteStorage.restore(origin) : null,
      cosmetics: services.contentBlocker.pageStart(frame.url, top.url, controller.partition)
    }
  }

  ipcMain.on(PAGE_START_CHANNEL, (event) => {
    let start: PageStart | null = null
    try {
      const hit = host.tabForWebContents(event.sender)
      const frame = event.senderFrame
      if (hit && frame) start = pageStart(hit.controller, frame, event.sender.mainFrame)
    } catch (err) {
      console.warn(`[ipc] ${PAGE_START_CHANNEL}:`, String(err))
    }
    // Always answered: the frame is waiting.
    event.returnValue = start
  })

  /** A first-party frame's localStorage, to be kept in the vault. Checked against the frame's real origin. */
  ipcMain.on(PAGE_STORAGE_CHANNEL, (event, raw) => {
    try {
      const hit = host.tabForWebContents(event.sender)
      const frame = event.senderFrame
      if (!hit || !frame || hit.controller.isPrivate) return
      const origin = webOriginOf(frame.origin)
      const topOrigin = webOriginOf(event.sender.mainFrame.origin)
      const r = obj(raw)
      if (!origin || !topOrigin || r.origin !== origin || !persistsStorage(origin, topOrigin)) return
      const items = sanitizeStorageItems(r.items)
      if (items) services.siteStorage.save(origin, items)
    } catch (err) {
      console.warn(`[ipc] ${PAGE_STORAGE_CHANNEL}:`, String(err))
    }
  })

  /** Generic element hiding for what just appeared in a frame's DOM. */
  ipcMain.handle(PAGE_COSMETICS_CHANNEL, (event, raw) => {
    const hit = host.tabForWebContents(event.sender)
    const frame = event.senderFrame
    if (!hit || !frame) return null
    return services.contentBlocker.domUpdate(frame.url, event.sender.mainFrame.url, hit.controller.partition, raw)
  })

  /**
   * alert() / confirm() / prompt() from web content. Synchronous for the page
   * (it waits, as with a native dialog); answered asynchronously here once the
   * user responds in Aqua's tab-modal dialog. Only frames of real tabs are
   * served, and every path answers - a page must never stay blocked.
   */
  ipcMain.on(JS_DIALOG_CHANNEL, (event, raw) => {
    let answered = false
    const reply = (value: unknown): void => {
      if (answered) return
      answered = true
      event.returnValue = value ?? null
    }
    try {
      const hit = host.tabForWebContents(event.sender)
      const frame = event.senderFrame
      if (!hit || !frame) return reply(null)
      const r = obj(raw)
      const request: JsDialogRequest = {
        kind: oneOf(r.kind, DIALOG_KINDS),
        message: str(r.message, 64 * 1024),
        defaultValue: str(r.defaultValue, 64 * 1024)
      }
      const top = event.sender.mainFrame
      const origin = frame.origin
      const embedded = frame !== top && origin !== top.origin
      hit.tab.runDialog(request, origin, embedded).then(reply, () => reply(null))
    } catch (err) {
      console.warn(`[ipc] ${JS_DIALOG_CHANNEL}:`, String(err))
      reply(null)
    }
  })
}
