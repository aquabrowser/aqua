/**
 * Domain types shared by the main process, the preload bridge and the UI
 * renderer. Everything that crosses the IPC boundary is declared here so both
 * sides are checked against the same contract.
 */

import type { NtpBackground, NtpFont } from './ntp'

export type Platform = 'win32' | 'darwin' | 'linux'

// ─── Settings ────────────────────────────────────────────────────────────────

export type ThemeMode = 'system' | 'light' | 'dark'
/** Classic dark greys, pure black (OLED), or cool blue-greys. */
export type DarkStyle = 'classic' | 'midnight' | 'slate'
/** `prefers-color-scheme` reported to websites (independent of Aqua's own theme). */
export type WebsiteAppearance = 'system' | 'dark' | 'light'
export type SearchEngineId = 'duckduckgo' | 'google' | 'brave' | 'bing' | 'startpage'
export type AutoLockTime = '1m' | '5m' | '15m' | '30m' | '1h' | 'never'
export type StartupBehavior = 'newtab' | 'continue' | 'pages'
export type PermissionDefault = 'ask' | 'block'
/** How the New Tab page shows shortcuts. */
export type NtpShortcuts = 'grid' | 'hidden'

/** Global defaults for capability prompts; per-site decisions override them. */
export interface PermissionDefaults {
  camera: PermissionDefault
  microphone: PermissionDefault
  geolocation: PermissionDefault
  notifications: PermissionDefault
}

export interface BrowserSettings {
  theme: ThemeMode
  /** Which dark theme applies whenever Aqua is dark. */
  darkStyle: DarkStyle
  websiteAppearance: WebsiteAppearance
  searchEngine: SearchEngineId
  showBookmarksBar: boolean
  startupBehavior: StartupBehavior
  /** Opened when `startupBehavior` is `pages`. */
  startupPages: string[]
  askWhereToSave: boolean
  autoLockTimer: AutoLockTime
  /** Block ads and trackers (Settings → Privacy). */
  contentBlocking: boolean
  /** Which filter list groups are in use. */
  blockerLists: Record<FilterListGroup, boolean>
  /** Hostnames where blocking is paused, in regular windows. */
  blockerPausedSites: string[]
  /** Remove utm_*, fbclid, gclid … from links before they are opened. */
  stripTrackingParams: boolean
  /**
   * WebRTC (calls) only through a proxy: never a direct UDP connection, so a call can't reveal the
   * real IP address around a proxy, but without one, calls can't connect. Off: calls use the default
   * network route only and never share local addresses.
   */
  webrtcProxyOnly: boolean
  /** New Tab page: the clock and date. */
  ntpShowClock: boolean
  /** "Good morning" above the clock. */
  ntpGreeting: boolean
  ntpFont: NtpFont
  ntpShortcuts: NtpShortcuts
  /** Fill tiles the user didn't add with the most visited sites. */
  ntpAutoShortcuts: boolean
  /** `default`, `solid:<id>`, `gradient:<id>` or `image` (see shared/ntp.ts). */
  ntpBackground: NtpBackground
  permissionDefaults: PermissionDefaults
  /**
   * The first-run welcome is done (search engine chosen). False only for a vault created since
   * onboarding exists, until its last step; profiles from before count as done.
   */
  onboardingCompleted: boolean
}

// ─── Tabs & windows ─────────────────────────────────────────────────────────

export type SecurityLevel =
  | 'internal' // aqua:// pages
  | 'secure' // https with a valid certificate
  | 'insecure' // plain http on a public host
  | 'cert-error' // https where the user bypassed a certificate error
  | 'file' // file://
  | 'neutral' // localhost, about:, data:, view-source: …

/** Coarse load milestones used to drive the progress bar. */
export type LoadStage = 'idle' | 'started' | 'committed' | 'dom-ready'

export interface TabError {
  code: number
  /** Chromium short name, e.g. `ERR_NAME_NOT_RESOLVED`. */
  name: string
  url: string
}

export interface TabState {
  id: string
  url: string
  title: string
  favicon: string | null
  pinned: boolean
  loading: boolean
  loadStage: LoadStage
  audible: boolean
  muted: boolean
  canGoBack: boolean
  canGoForward: boolean
  security: SecurityLevel
  error: TabError | null
  crashed: boolean
  zoomFactor: number
  /** Requests blocked on the current page (ads, trackers, malware). */
  blockedCount: number
  /** Blocking is paused for this site. */
  blockerPaused: boolean
  blockedPopups: number
  /** A dialog or prompt is waiting for this tab. */
  hasPrompt: boolean
  /** Restored tab whose page has not been loaded yet. */
  discarded: boolean
}

export interface WindowState {
  windowId: number
  tabs: TabState[]
  activeTabId: string | null
  canReopenClosedTab: boolean
  htmlFullscreen: boolean
  focused: boolean
  maximized: boolean
  /** Pending dialogs / prompts for tabs in this window, oldest first. */
  prompts: PromptRequest[]
  /** A private window: nothing done in it is saved, and its session lives in memory only. */
  private: boolean
}

export interface CreateTabOptions {
  url?: string
  background?: boolean
  /** Insert position; clamped so unpinned tabs never land in the pinned group. */
  index?: number
}

export type Disposition = 'current' | 'new-tab' | 'background-tab' | 'new-window'

export interface NavigateOptions {
  disposition?: Disposition
  /** Ctrl+Enter: wrap a bare word as www.<word>.com */
  ctrlEnter?: boolean
}

// ─── Commands ───────────────────────────────────────────────────────────────

export type CommandId =
  | 'tab.new'
  | 'tab.close'
  | 'tab.reopen'
  | 'tab.next'
  | 'tab.prev'
  | 'tab.select'
  | 'tab.duplicate'
  | 'window.new'
  | 'window.new-private'
  | 'window.close'
  | 'window.fullscreen'
  | 'nav.back'
  | 'nav.forward'
  | 'nav.reload'
  | 'nav.reload-hard'
  | 'nav.stop'
  | 'omnibox.focus'
  | 'find.open'
  | 'find.next'
  | 'find.prev'
  | 'bookmark.page'
  | 'bookmarks.toggle-bar'
  | 'page.zoom-in'
  | 'page.zoom-out'
  | 'page.zoom-reset'
  | 'page.print'
  | 'page.view-source'
  | 'page.devtools'
  | 'open.history'
  | 'open.downloads'
  | 'open.settings'
  | 'vault.lock'
  | 'app.quit'

/** Commands the main process asks the UI renderer to perform. */
export type UiCommand =
  | { type: 'omnibox.focus' }
  | { type: 'popup.open'; popup: 'downloads' | 'bookmark' | 'app-menu' }
  /** The page took keyboard focus (a click into it): the address bar lets go of focus and selection. */
  | { type: 'page.focused' }
  /** The link (or other target) under the pointer in the active page; '' when there is none. */
  | { type: 'status'; url: string }

// ─── Omnibox ────────────────────────────────────────────────────────────────

export type SuggestionKind = 'url' | 'search' | 'history' | 'bookmark' | 'internal'

export interface Suggestion {
  kind: SuggestionKind
  /** Navigation target. */
  url: string
  /** Primary text: page title, or the query for searches. */
  title: string
  /** URL shown in the secondary column (display form). */
  displayUrl: string
  /** Text placed in the omnibox when the row is highlighted with the keyboard. */
  fill: string
  favicon?: string | null
}

export interface SuggestResult {
  input: string
  suggestions: Suggestion[]
  /**
   * Text to append to `input` for inline autocompletion (Chrome-style), or null.
   * Applies to the first suggestion.
   */
  inlineCompletion: string | null
}

// ─── Overlays ───────────────────────────────────────────────────────────────

/** Bottom → top: tab views, find bar, link status, tab-modal prompts, popups. */
export type OverlayRole = 'findbar' | 'status' | 'modal' | 'popup'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type OverlayPlacement =
  | { type: 'rect'; rect: Rect }
  /** Pinned to the top-right corner of the web content area; follows resizes. */
  | { type: 'content-top-right'; width: number; height: number; right: number; top: number }
  /** Covers the whole web content area (tab-modal dialogs); follows resizes. */
  | { type: 'content' }
  /** A rect relative to the web content area's top-left corner; follows resizes. */
  | { type: 'content-anchored'; left: number; top: number; width: number; height: number }
  /**
   * The bottom-left corner of the web content area (the link status bubble).
   * Moves to the bottom-right corner while the pointer is over that spot.
   */
  | { type: 'content-bottom-left'; width: number; height: number }

// ─── Find in page ───────────────────────────────────────────────────────────

export interface FindState {
  tabId: string
  open: boolean
  text: string
  matches: number
  activeMatch: number
  /** Increments whenever the bar should (re)focus and select its input. */
  focusToken: number
}

// ─── Bookmarks / history / downloads ───────────────────────────────────────

export interface Bookmark {
  id: string
  url: string
  title: string
  favicon: string | null
  createdAt: number
}

export interface HistoryEntry {
  id: string
  url: string
  title: string
  favicon: string | null
  visitedAt: number
}

export interface HistoryQuery {
  text?: string
  /** Return entries strictly older than this timestamp (pagination cursor). */
  before?: number
  limit?: number
}

export interface TopSite {
  url: string
  title: string
  favicon: string | null
}

/** A New Tab page tile: one the user added, or one suggested from history / defaults. */
export interface Shortcut extends TopSite {
  /** Stable key: the custom shortcut's id, or `site:<site key>` for a suggestion. */
  id: string
  custom: boolean
}

export type DownloadStatus = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadEntry {
  id: string
  url: string
  filename: string
  savePath: string
  mimeType: string
  totalBytes: number
  receivedBytes: number
  status: DownloadStatus
  /** Bytes per second, smoothed. 0 when not transferring. */
  speed: number
  startedAt: number
  endedAt: number | null
  canResume: boolean
  /** Completed file was moved or deleted on disk. */
  fileMissing: boolean
}

export type DownloadAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'open' | 'show' | 'remove'

// ─── Site info / security ──────────────────────────────────────────────────

export interface CertificateInfo {
  subject: string
  subjectOrg: string
  issuer: string
  issuerOrg: string
  validFrom: number
  validTo: number
  fingerprint: string
  serialNumber: string
}

export type PermissionKind = 'camera' | 'microphone' | 'geolocation' | 'notifications' | 'midi' | 'clipboard-read'

export type PermissionDecision = 'allow' | 'block'

export interface SitePermission {
  origin: string
  permission: PermissionKind
  decision: PermissionDecision
}

export interface SiteInfo {
  url: string
  host: string
  origin: string
  security: SecurityLevel
  certificate: CertificateInfo | null
  permissions: SitePermission[]
}

/** A site that may launch an external application without asking. */
export interface ProtocolGrant {
  origin: string
  scheme: string
}

// ─── Prompts (tab-modal dialogs) ────────────────────────────────────────────

export type PromptRequest =
  | {
      id: string
      tabId: string
      kind: 'alert' | 'confirm' | 'prompt'
      /** Origin of the frame that opened the dialog. */
      origin: string
      /** Opened by a cross-origin iframe rather than the page itself. */
      embedded: boolean
      message: string
      defaultValue: string
      /** Offer "Don't let this page create more dialogs" (second dialog onwards). */
      offerSuppress: boolean
    }
  | {
      id: string
      tabId: string
      kind: 'external'
      /** Requesting origin, or '' when the user typed the URL. */
      origin: string
      url: string
      scheme: string
      /** Registered handler, or '' when none is: the OS then offers to choose an app. */
      appName: string
      /** The handler's icon (data: URL), when the OS provides one. */
      appIcon: string | null
      /** "Always allow" may be offered: a known app, a web origin, and not a private window. */
      canRemember: boolean
    }
  | {
      id: string
      tabId: string
      kind: 'permission'
      origin: string
      permissions: PermissionKind[]
    }
  | {
      id: string
      tabId: string
      /** The page started another download without being asked to (see DownloadGate). */
      kind: 'downloads'
      origin: string
      /** Name of the file that is waiting. */
      filename: string
    }
  | {
      id: string
      tabId: string
      /** `getDisplayMedia()`: the user picks what to share, or nothing. */
      kind: 'display-capture'
      origin: string
      /** The page asked for audio too (system audio can be shared with a whole screen). */
      audio: boolean
      sources: CaptureSource[]
    }
  | {
      id: string
      tabId: string
      /** The page asks to confirm leaving it (beforeunload) - for a close or a navigation Aqua started. */
      kind: 'leave'
      origin: string
    }
  | {
      id: string
      tabId: string
      /** The page stopped responding: wait, or end it. Withdrawn when it recovers. */
      kind: 'unresponsive'
      title: string
    }

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** Preview (JPEG data: URL), or '' when the system gave none. */
  thumbnail: string
  /** The window's application icon (PNG data: URL), when there is one. */
  icon: string | null
}

export type PromptResponse =
  | { kind: 'dialog'; accepted: boolean; value?: string; suppress?: boolean }
  | { kind: 'external'; allow: boolean; remember: boolean }
  | { kind: 'permission'; decision: 'allow' | 'block' | 'dismiss' }
  | { kind: 'downloads'; decision: 'allow' | 'block' | 'dismiss' }
  | { kind: 'display-capture'; sourceId: string | null; audio: boolean }
  | { kind: 'leave'; leave: boolean }
  | { kind: 'unresponsive'; exit: boolean }

// ─── Content blocking ───────────────────────────────────────────────────────

export type FilterListGroup = 'ads' | 'privacy' | 'cookies' | 'annoyances'

export interface ContentBlockerInfo {
  /** Settings → Privacy → "Block ads and trackers". */
  enabled: boolean
  /** `loading`: the lists are being compiled; `error`: no usable list was found. */
  status: 'loading' | 'ready' | 'error'
  filterCount: number
  listCount: number
  /** When the lists in use were downloaded (ms since the epoch); the bundled copies' date until the first update. */
  updatedAt: number | null
  updating: boolean
  /** Why the last update failed; null once one succeeds. */
  updateError: string | null
}

// ─── Vault ─────────────────────────────────────────────────────────────────

export type VaultState = 'setup' | 'locked' | 'unlocked'

export interface VaultStatus {
  state: VaultState
  /** A pre-Argon2id vault exists; the next unlock upgrades and migrates it. */
  legacyUpgrade: boolean
}

export interface VaultResult {
  success: boolean
  error?: string
  /** Seconds the user must wait before another attempt (rate limiting). */
  retryAfter?: number
}

export type ClearDataKind = 'history' | 'downloads' | 'cache' | 'cookies'

/** What each "clear data" option would delete, shown before anything is removed. */
export interface ClearDataSummary {
  historyEntries: number
  downloadEntries: number
  cacheBytes: number
  cookieCount: number
}

/**
 * Where the updater is (main/services/updater.ts). `disabled`: this copy doesn't update itself
 * (portable copies and development builds). Error details stay in the main process.
 */
export type UpdateStatus =
  | { state: 'disabled'; reason: 'portable' | 'development' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; checkedAt: number }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error' }

export interface AppVersions {
  app: string
  electron: string
  chrome: string
  node: string
  v8: string
}

export interface UiBootstrap {
  platform: Platform
  state: WindowState
  settings: BrowserSettings
  bookmarks: Bookmark[]
  downloads: DownloadEntry[]
  vault: VaultStatus
  contentBlocker: ContentBlockerInfo
  versions: AppVersions
}

export type ContextMenuRequest =
  | { kind: 'tab'; tabId: string }
  | { kind: 'tabstrip' }
  | { kind: 'bookmark'; bookmarkId: string }
  | { kind: 'bookmarks-overflow'; bookmarkIds: string[]; x: number; y: number }
  | { kind: 'nav-history'; direction: 'back' | 'forward'; x: number; y: number }
  | { kind: 'omnibox'; hasSelection: boolean; canUndo: boolean }

// ─── Storage ────────────────────────────────────────────────────────────────

/** Settings → Storage: where the profile is and what is in it. */
export interface StorageInfo {
  /** The profile folder in use. */
  path: string
  mode: 'portable' | 'installed' | 'custom'
  /** For portable copies: the self-extracting single file, or the unpacked folder. */
  portableKind: 'single-file' | 'folder' | null
  /** The encrypted vault (aqua.db and its journal files). */
  vaultBytes: number
  /** Filter list updates (public data). */
  filterBytes: number
  /** Everything else in the folder: Chromium's own state (GPU shader caches and the like). */
  otherBytes: number
  /** Where the single-file build's launcher unpacked the program for this run (program files only). */
  programDir: string | null
  /** A profile of an installed Aqua on this computer that this copy does not use, if there is one. */
  otherProfile: string | null
}

export type ImageResult = { ok: true } | { ok: false; error: string }
