/**
 * The complete IPC contract between the UI renderer and the main process.
 *
 *  - `InvokeMap`: request/response channels (`ipcRenderer.invoke` ↔ `ipcMain.handle`)
 *  - `SendMap`:   fire-and-forget channels (`ipcRenderer.send` ↔ `ipcMain.on`)
 *  - `EventMap`:  main → renderer pushes (`webContents.send` ↔ `ipcRenderer.on`)
 *
 * Both the preload bridge and the main-process registrars are typed against
 * these maps, so a renamed channel or a changed payload fails to compile on
 * both sides instead of failing silently at runtime.
 */
import type { ProfileColor } from './profiles'
import type {
  Bookmark,
  BrowserSettings,
  ClearDataKind,
  ClearDataSummary,
  CommandId,
  ContentBlockerInfo,
  ContextMenuRequest,
  CreateTabOptions,
  DownloadAction,
  DownloadEntry,
  FindState,
  HistoryEntry,
  HistoryQuery,
  ImageResult,
  NavigateOptions,
  OverlayPlacement,
  OverlayRole,
  PermissionKind,
  PromptResponse,
  ProtocolGrant,
  Shortcut,
  SiteInfo,
  SitePermission,
  StorageInfo,
  ProfileResult,
  ProfileSummary,
  SuggestResult,
  TopSite,
  UiBootstrap,
  UiCommand,
  UpdateStatus,
  VaultResult,
  VaultStatus,
  WindowState
} from './types'

export interface InvokeMap {
  'ui:bootstrap': () => UiBootstrap
  'ui:command': (command: CommandId, arg?: number) => void
  'ui:context-menu': (request: ContextMenuRequest) => void

  'tabs:create': (options?: CreateTabOptions) => string | null
  'tabs:activate': (tabId: string, focusContent: boolean) => void
  'tabs:close': (tabId: string) => void
  'tabs:move': (tabId: string, index: number) => void
  'tabs:set-pinned': (tabId: string, pinned: boolean) => void
  'tabs:set-muted': (tabId: string, muted: boolean) => void
  'tabs:duplicate': (tabId: string) => void
  'tabs:reload': (tabId: string) => void
  'tabs:open-blocked-popup': (tabId: string) => void

  'nav:go': (input: string, options?: NavigateOptions) => void
  'nav:proceed-unsafe': (tabId: string) => void

  'omnibox:suggest': (text: string) => SuggestResult

  'prompt:respond': (promptId: string, response: PromptResponse) => void

  'site:info': (tabId: string) => SiteInfo | null
  'site:permissions': () => SitePermission[]
  'site:reset-permission': (origin: string, permission: PermissionKind) => void
  'site:protocol-grants': () => ProtocolGrant[]
  'site:revoke-grant': (origin: string, scheme: string) => void

  'bookmarks:add': (bookmark: { url: string; title: string; favicon: string | null }) => Bookmark
  'bookmarks:update': (id: string, patch: { title?: string; url?: string }) => void
  'bookmarks:remove': (id: string) => void
  'bookmarks:move': (id: string, index: number) => void
  'bookmarks:open': (id: string, disposition: 'current' | 'new-tab' | 'background-tab') => void

  'downloads:action': (id: string, action: DownloadAction) => void
  'downloads:clear': () => void

  'history:query': (query: HistoryQuery) => HistoryEntry[]
  'history:remove': (ids: string[]) => void
  'history:top-sites': (limit: number) => TopSite[]

  'shortcuts:list': () => Shortcut[]
  'shortcuts:add': (shortcut: { title: string; url: string }) => Shortcut[]
  'shortcuts:remove': (id: string) => Shortcut[]
  'shortcuts:restore': (shortcut: Shortcut, index: number) => Shortcut[]

  'settings:update': (patch: Partial<BrowserSettings>) => BrowserSettings
  'settings:data-summary': () => ClearDataSummary
  'settings:clear-data': (kinds: ClearDataKind[]) => void

  'blocker:info': () => ContentBlockerInfo
  /** Pauses or resumes blocking on the tab's site (and reloads it); false where it does not apply. */
  'blocker:set-paused': (tabId: string, paused: boolean) => boolean
  'blocker:update-lists': () => void

  'ntp:image': () => string | null
  /** Opens a file picker; null when the user cancels it. */
  'ntp:image-from-file': () => ImageResult | null
  'ntp:image-from-url': (url: string) => ImageResult
  'ntp:image-clear': () => void

  'storage:info': () => StorageInfo
  'storage:open': (which: 'profile' | 'other') => void
  /** Every profile, for the switcher (none in a guest session). Works while locked. */
  'profiles:list': () => ProfileSummary[]
  /** Opens a profile in its own process, or brings its window forward. Works while locked. */
  'profiles:open': (id: string) => void
  /** A guest window. Works while locked: a guest needs no master password. */
  'profiles:open-guest': () => void
  'profile-admin:create': (profile: { name: string; color: ProfileColor }) => ProfileResult
  'profile-admin:update': (id: string, profile: { name: string; color: ProfileColor }) => ProfileResult
  'profile-admin:delete': (id: string) => ProfileResult

  'vault:setup': (password: string) => VaultResult
  'vault:unlock': (password: string) => VaultResult
  'vault:lock': () => void
  'vault:change-password': (oldPassword: string, newPassword: string) => VaultResult
  /** Erases the profile and relaunches. `confirmation` must be the literal text the user typed. */
  'vault:wipe': (confirmation: string) => VaultResult
  'updater:status': () => UpdateStatus
  /** Looks for a new version now (it downloads by itself when there is one). */
  'updater:check': () => void
  /** Quits (each page may still ask "Leave site?") and installs the downloaded update, then restarts. */
  'updater:restart': () => void
}

export interface SendMap {
  /** Top edge (CSS px == DIP) where web content starts; reported on every header resize. */
  'ui:content-top': (top: number) => void
  'ui:focus-content': () => void
  'ui:overlay-show': (role: OverlayRole, placement: OverlayPlacement, focus: boolean) => void
  'ui:overlay-hide': (role: OverlayRole) => void
  'find:query': (tabId: string, text: string) => void
  'find:step': (tabId: string, forward: boolean) => void
  'find:close': (tabId: string) => void
}

export interface EventMap {
  'window:state': (state: WindowState) => void
  'ui:command': (command: UiCommand) => void
  'find:state': (state: FindState | null) => void
  'settings:changed': (settings: BrowserSettings) => void
  'bookmarks:changed': (bookmarks: Bookmark[]) => void
  'downloads:changed': (entry: DownloadEntry) => void
  'downloads:reset': (entries: DownloadEntry[]) => void
  'vault:changed': (status: VaultStatus) => void
  'blocker:changed': (info: ContentBlockerInfo) => void
  'ntp:image-changed': () => void
  /** Every step of the updater: checking, downloading (with progress), downloaded, up to date, error. */
  'updater:status': (status: UpdateStatus) => void
}

export type InvokeChannel = keyof InvokeMap
export type SendChannel = keyof SendMap
export type EventChannel = keyof EventMap

/** Synchronous channel used by the tab preload for alert() / confirm() / prompt(). */
export const JS_DIALOG_CHANNEL = 'aqua:js-dialog'

export interface JsDialogRequest {
  kind: 'alert' | 'confirm' | 'prompt'
  message: string
  defaultValue: string
}

/**
 * Synchronous: the tab preload asks once per document, before any page script
 * runs, for what it must set up in that frame. Tabs only; null elsewhere.
 */
export const PAGE_START_CHANNEL = 'aqua:page-start'

export interface PageStart {
  stripTrackingParams: boolean
  /** Saved localStorage to put back (the first document of this origin in this run), or null. */
  storage: Record<string, string> | null
  /** Whether this frame's localStorage is kept: first-party frames in regular windows. */
  persistStorage: boolean
  /** Element hiding and scriptlets for this frame, or null where blocking does not apply. */
  cosmetics: { styles: string; scripts: string[]; observe: boolean } | null
}

/** Fire-and-forget: a frame's localStorage changed (see PageStart.persistStorage). */
export const PAGE_STORAGE_CHANNEL = 'aqua:page-storage'

export interface PageStorageSnapshot {
  /** The frame's own view of its origin; checked against the browser's before anything is saved. */
  origin: string
  items: Record<string, string>
}

/** Invoke: ids, classes and links that appeared in a frame → element-hiding CSS for them (or null). */
export const PAGE_COSMETICS_CHANNEL = 'aqua:page-cosmetics'

export interface PageDomFeatures {
  ids: string[]
  classes: string[]
  hrefs: string[]
}
