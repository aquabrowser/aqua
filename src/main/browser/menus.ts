import { DEFAULT_PROFILE_ID } from '../lib/profiles'
import {
  clipboard,
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import { SEARCH_ENGINES, searchUrl } from '../../shared/search'
import type { ContextMenuRequest } from '../../shared/types'
import { isSavableUrl, isWebUrl } from '../../shared/url'
import type { Tab } from './tab'
import type { BrowserWindowController } from './window-controller'

const isMac = process.platform === 'darwin'
const SEPARATOR: MenuItemConstructorOptions = { type: 'separator' }

/** Menu labels: escape Windows mnemonics and keep them to a readable width. */
function label(text: string, max = 56): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const cut = clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
  return isMac ? cut : cut.replace(/&/g, '&&')
}

function compact(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const item of items) {
    if (item.type === 'separator' && (out.length === 0 || out[out.length - 1].type === 'separator')) continue
    out.push(item)
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop()
  return out
}

/**
 * Spelling suggestions. There is no "Add to dictionary": browsing sessions are
 * in memory, and a persistent dictionary would be a plaintext file of words
 * typed into pages.
 */
function spellingItems(wc: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  if (!params.misspelledWord) return []
  const items: MenuItemConstructorOptions[] = params.dictionarySuggestions.slice(0, 5).map((word) => ({
    label: label(word),
    click: () => wc.replaceMisspelling(word)
  }))
  if (items.length === 0) items.push({ label: 'No spelling suggestions', enabled: false })
  items.push(SEPARATOR)
  return items
}

function editItems(wc: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const f = params.editFlags
  return [
    {
      label: 'Undo',
      accelerator: 'CmdOrCtrl+Z',
      registerAccelerator: false,
      enabled: f.canUndo,
      click: () => wc.undo()
    },
    {
      label: 'Redo',
      accelerator: 'CmdOrCtrl+Shift+Z',
      registerAccelerator: false,
      enabled: f.canRedo,
      click: () => wc.redo()
    },
    SEPARATOR,
    { label: 'Cut', accelerator: 'CmdOrCtrl+X', registerAccelerator: false, enabled: f.canCut, click: () => wc.cut() },
    {
      label: 'Copy',
      accelerator: 'CmdOrCtrl+C',
      registerAccelerator: false,
      enabled: f.canCopy,
      click: () => wc.copy()
    },
    {
      label: 'Paste',
      accelerator: 'CmdOrCtrl+V',
      registerAccelerator: false,
      enabled: f.canPaste,
      click: () => wc.paste()
    },
    {
      label: 'Paste as plain text',
      accelerator: 'CmdOrCtrl+Shift+V',
      registerAccelerator: false,
      enabled: f.canPaste,
      click: () => wc.pasteAndMatchStyle()
    },
    { label: 'Delete', enabled: f.canDelete, click: () => wc.delete() },
    SEPARATOR,
    {
      label: 'Select all',
      accelerator: 'CmdOrCtrl+A',
      registerAccelerator: false,
      enabled: f.canSelectAll,
      click: () => wc.selectAll()
    }
  ]
}

/** Context menu for web content inside a tab. */
export function showPageContextMenu(controller: BrowserWindowController, tab: Tab, params: ContextMenuParams): void {
  const wc = tab.webContents
  if (!wc) return
  const items: MenuItemConstructorOptions[] = []
  const engine = SEARCH_ENGINES[controller.services.settings.get().searchEngine]

  // Opening and saving are loads the browser makes itself, so they are limited to web addresses
  // (and saving to the page's own data): never file:, local or on a network share.
  if (params.linkURL && /^(https?|ftp|file|data|blob):/.test(params.linkURL)) {
    const link = params.linkURL
    if (isWebUrl(link)) {
      items.push(
        { label: 'Open link in new tab', click: () => controller.openFromTab(tab, link, true) },
        { label: 'Open link in new window', click: () => controller.openInNewWindow(link) },
        ...(controller.isPrivate
          ? []
          : [{ label: 'Open link in private window', click: () => controller.openInPrivateWindow(link) }]),
        SEPARATOR
      )
    }
    if (isSavableUrl(link)) items.push({ label: 'Save link as…', click: () => tab.saveAs(link) })
    items.push({ label: 'Copy link address', click: () => void clipboard.writeText(link) }, SEPARATOR)
  }

  if (params.mediaType === 'image' && params.srcURL) {
    const src = params.srcURL
    items.push(
      ...(isWebUrl(src)
        ? [{ label: 'Open image in new tab', click: () => controller.openFromTab(tab, src, true) }]
        : []),
      ...(isSavableUrl(src) ? [{ label: 'Save image as…', click: () => tab.saveAs(src) }] : []),
      { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', click: () => void clipboard.writeText(src) },
      SEPARATOR
    )
  } else if ((params.mediaType === 'video' || params.mediaType === 'audio') && isWebUrl(params.srcURL)) {
    const src = params.srcURL
    const noun = params.mediaType === 'video' ? 'video' : 'audio'
    items.push(
      { label: `Open ${noun} in new tab`, click: () => controller.openFromTab(tab, src, true) },
      { label: `Save ${noun} as…`, click: () => tab.saveAs(src) },
      { label: `Copy ${noun} address`, click: () => void clipboard.writeText(src) },
      SEPARATOR
    )
  }

  const selection = params.selectionText.trim()
  if (params.isEditable) {
    items.push(...spellingItems(wc, params), ...editItems(wc, params), SEPARATOR)
  } else if (selection) {
    const preview = selection.length > 28 ? `${selection.slice(0, 27)}…` : selection
    items.push(
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', registerAccelerator: false, click: () => wc.copy() },
      {
        label: label(`Search ${engine.name} for “${preview}”`),
        click: () => controller.openFromTab(tab, searchUrl(engine.id, selection), false)
      },
      SEPARATOR
    )
  }

  const plainPage = !params.linkURL && !selection && !params.isEditable && params.mediaType === 'none'
  if (plainPage) {
    const state = tab.state()
    items.push(
      {
        label: 'Back',
        accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
        registerAccelerator: false,
        enabled: state.canGoBack,
        click: () => tab.goBack()
      },
      {
        label: 'Forward',
        accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
        registerAccelerator: false,
        enabled: state.canGoForward,
        click: () => tab.goForward()
      },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', registerAccelerator: false, click: () => tab.reload() },
      SEPARATOR,
      { label: 'Print…', accelerator: 'CmdOrCtrl+P', registerAccelerator: false, click: () => wc.print() },
      {
        label: 'View page source',
        accelerator: 'CmdOrCtrl+U',
        registerAccelerator: false,
        click: () => controller.run('page.view-source')
      },
      SEPARATOR
    )
  }

  items.push(SEPARATOR)
  items.push({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) })
  Menu.buildFromTemplate(compact(items)).popup({ window: controller.window, frame: params.frame ?? undefined })
}

/** Cut/copy/paste menu for inputs in the browser UI and its overlays. */
export function showEditableContextMenu(window: BrowserWindow, wc: WebContents, params: ContextMenuParams): void {
  if (!params.isEditable && !params.selectionText) return
  const items = params.isEditable
    ? [...spellingItems(wc, params), ...editItems(wc, params)]
    : [{ label: 'Copy', click: () => wc.copy() }]
  Menu.buildFromTemplate(compact(items)).popup({ window })
}

export function showUiContextMenu(controller: BrowserWindowController, request: ContextMenuRequest): void {
  const window = controller.window
  switch (request.kind) {
    case 'tab': {
      const tab = controller.getTab(request.tabId)
      if (!tab) return
      const state = tab.state()
      const index = controller.allTabs().indexOf(tab)
      const menu: MenuItemConstructorOptions[] = [
        { label: 'New tab to the right', click: () => controller.createTab({ index: index + 1 }) },
        SEPARATOR,
        { label: 'Reload', click: () => tab.reload() },
        { label: 'Duplicate', click: () => controller.duplicate(tab) },
        { label: tab.pinned ? 'Unpin' : 'Pin', click: () => controller.setPinned(tab, !tab.pinned) },
        { label: state.muted ? 'Unmute tab' : 'Mute tab', click: () => tab.setMuted(!state.muted) },
        SEPARATOR,
        {
          label: 'Close',
          accelerator: 'CmdOrCtrl+W',
          registerAccelerator: false,
          click: () => controller.closeTab(tab)
        },
        { label: 'Close other tabs', click: () => controller.closeOtherTabs(tab) },
        {
          label: 'Close tabs to the right',
          enabled: index < controller.allTabs().length - 1,
          click: () => controller.closeTabsToRight(tab)
        },
        SEPARATOR,
        {
          label: 'Reopen closed tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          registerAccelerator: false,
          enabled: controller.canReopenClosedTab,
          click: () => controller.reopenClosedTab()
        }
      ]
      Menu.buildFromTemplate(menu).popup({ window })
      return
    }

    // The tab strip outside the tabs (its empty space and the new tab button).
    case 'tabstrip': {
      const menu: MenuItemConstructorOptions[] = [
        {
          label: 'New tab',
          accelerator: 'CmdOrCtrl+T',
          registerAccelerator: false,
          click: () => controller.newTab()
        },
        {
          label: 'Reopen closed tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          registerAccelerator: false,
          enabled: controller.canReopenClosedTab,
          click: () => controller.reopenClosedTab()
        },
        SEPARATOR,
        {
          label: 'New window',
          accelerator: 'CmdOrCtrl+N',
          registerAccelerator: false,
          click: () => controller.run('window.new')
        },
        {
          label: 'New private window',
          accelerator: 'CmdOrCtrl+Shift+N',
          registerAccelerator: false,
          click: () => controller.run('window.new-private')
        }
      ]
      Menu.buildFromTemplate(menu).popup({ window })
      return
    }

    // Switching profiles (lock screen, tab strip badge): each opens in its own window and process.
    case 'profiles': {
      const { profiles } = controller
      const menu: MenuItemConstructorOptions[] = profiles.list().map((p) => ({
        label: label(p.name),
        type: 'checkbox',
        checked: p.current,
        click: () =>
          p.current
            ? controller.window.focus()
            : profiles.open(p.id === DEFAULT_PROFILE_ID ? { kind: 'default' } : { kind: 'profile', id: p.id })
      }))
      if (menu.length > 0) menu.push(SEPARATOR)
      menu.push({ label: 'Open guest window', click: () => controller.run('window.new-guest') })
      if (!profiles.isGuest && controller.services.vault.isOpen()) {
        menu.push({ label: 'Manage profiles…', click: () => controller.run('open.profiles') })
      }
      Menu.buildFromTemplate(menu).popup({ window })
      return
    }

    case 'nav-history': {
      const tab = controller.activeTab
      if (!tab) return
      const entries = tab.navigationEntries()
      const active = tab.activeEntryIndex()
      const slice =
        request.direction === 'back'
          ? entries.slice(Math.max(0, active - 12), active).reverse()
          : entries.slice(active + 1, active + 13)
      if (slice.length === 0) return
      const items: MenuItemConstructorOptions[] = slice.map((e) => ({
        label: label(e.title || e.url),
        click: () => tab.goToIndex(e.index)
      }))
      items.push(SEPARATOR, { label: 'Show full history', click: () => controller.run('open.history') })
      Menu.buildFromTemplate(items).popup({ window, x: Math.round(request.x), y: Math.round(request.y) })
      return
    }

    case 'bookmark': {
      const bookmark = controller.services.bookmarks.get(request.bookmarkId)
      if (!bookmark) return
      const showBar = controller.services.settings.get().showBookmarksBar
      const items: MenuItemConstructorOptions[] = [
        { label: 'Open', click: () => controller.navigateActive(bookmark.url, false, true) },
        { label: 'Open in new tab', click: () => controller.createTab({ url: bookmark.url, background: true }) },
        { label: 'Open in new window', click: () => controller.openInNewWindow(bookmark.url) },
        SEPARATOR,
        { label: 'Copy link', click: () => void clipboard.writeText(bookmark.url) },
        { label: 'Delete', click: () => controller.services.bookmarks.remove(bookmark.id) },
        SEPARATOR,
        {
          label: 'Show bookmarks bar',
          type: 'checkbox',
          checked: showBar,
          click: () => controller.run('bookmarks.toggle-bar')
        }
      ]
      Menu.buildFromTemplate(items).popup({ window })
      return
    }

    case 'bookmarks-overflow': {
      const items: MenuItemConstructorOptions[] = []
      for (const id of request.bookmarkIds) {
        const b = controller.services.bookmarks.get(id)
        if (b)
          items.push({ label: label(b.title || b.url), click: () => controller.navigateActive(b.url, false, true) })
      }
      if (items.length)
        Menu.buildFromTemplate(items).popup({ window, x: Math.round(request.x), y: Math.round(request.y) })
      return
    }

    case 'omnibox':
      void showOmniboxMenu(controller, request)
      return
  }
}

async function showOmniboxMenu(
  controller: BrowserWindowController,
  request: Extract<ContextMenuRequest, { kind: 'omnibox' }>
): Promise<void> {
  const window = controller.window
  const wc = window.webContents
  const clip = (await clipboard.readText()).trim().slice(0, 4096)
  const items: MenuItemConstructorOptions[] = [
    { label: 'Undo', enabled: request.canUndo, click: () => wc.undo() },
    SEPARATOR,
    { label: 'Cut', enabled: request.hasSelection, click: () => wc.cut() },
    { label: 'Copy', enabled: request.hasSelection, click: () => wc.copy() },
    { label: 'Paste', enabled: clip.length > 0, click: () => wc.paste() },
    {
      label: clip && /^\S+$/.test(clip) && /[./:]/.test(clip) ? 'Paste and go' : 'Paste and search',
      enabled: clip.length > 0,
      click: () => controller.goFromOmnibox(clip)
    },
    SEPARATOR,
    { label: 'Select all', click: () => wc.selectAll() }
  ]
  if (!window.isDestroyed()) Menu.buildFromTemplate(items).popup({ window })
}
