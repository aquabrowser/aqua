import { isNtpBackground, isNtpFont } from '../../shared/ntp'
import type {
  AutoLockTime,
  BrowserSettings,
  DarkStyle,
  FilterListGroup,
  NtpShortcuts,
  PermissionDefault,
  PermissionDefaults,
  SearchEngineId,
  StartupBehavior,
  ThemeMode,
  WebsiteAppearance
} from '../../shared/types'
import { Signal } from '../lib/signal'
import type { VaultDatabase } from '../storage/database'

export const THEMES: readonly ThemeMode[] = ['system', 'light', 'dark']
export const DARK_STYLES: readonly DarkStyle[] = ['classic', 'midnight', 'slate']
export const WEBSITE_APPEARANCES: readonly WebsiteAppearance[] = ['system', 'dark', 'light']
export const SEARCH_ENGINES: readonly SearchEngineId[] = ['duckduckgo', 'google', 'brave', 'bing', 'startpage']
export const AUTO_LOCK: readonly AutoLockTime[] = ['1m', '5m', '15m', '30m', '1h', 'never']
export const STARTUP: readonly StartupBehavior[] = ['newtab', 'continue', 'pages']
const NTP_SHORTCUTS: readonly NtpShortcuts[] = ['grid', 'hidden']
const PERMISSION_DEFAULTS: readonly PermissionDefault[] = ['ask', 'block']
const MAX_STARTUP_PAGES = 20
const MAX_PAUSED_SITES = 500
const LIST_GROUPS: readonly FilterListGroup[] = ['ads', 'privacy', 'cookies', 'annoyances']

export const DEFAULT_SETTINGS: BrowserSettings = {
  theme: 'system',
  darkStyle: 'classic',
  websiteAppearance: 'system',
  searchEngine: 'duckduckgo',
  showBookmarksBar: true,
  startupBehavior: 'newtab',
  startupPages: [],
  askWhereToSave: false,
  autoLockTimer: '15m',
  contentBlocking: true,
  blockerLists: { ads: true, privacy: true, cookies: false, annoyances: false },
  blockerPausedSites: [],
  stripTrackingParams: true,
  hideFromCapture: false,
  webrtcProxyOnly: false,
  ntpShowClock: true,
  ntpGreeting: false,
  ntpFont: 'default',
  ntpShortcuts: 'grid',
  ntpAutoShortcuts: true,
  ntpBackground: 'default',
  permissionDefaults: { camera: 'ask', microphone: 'ask', geolocation: 'ask', notifications: 'ask' },
  // True for profiles that predate onboarding; a new vault sets false (see ipc.ts, vault:setup).
  onboardingCompleted: true
}

/** Settings the lock screen needs before the vault is open; stored in plaintext meta. */
export interface UiHint {
  theme: ThemeMode
  darkStyle: DarkStyle
  /** So the window is hidden from screen capture from launch, lock screen included. */
  hideFromCapture?: boolean
}

const hintOf = (s: BrowserSettings): UiHint => ({
  theme: s.theme,
  darkStyle: s.darkStyle,
  hideFromCapture: s.hideFromCapture
})

type Validators = { [K in keyof BrowserSettings]: (value: unknown) => value is BrowserSettings[K] }

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const inList =
  <T extends string>(list: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (list as readonly string[]).includes(v)

function isStartupPages(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > MAX_STARTUP_PAGES) return false
  return v.every((url) => {
    if (typeof url !== 'string' || url.length > 2048) return false
    try {
      return ['http:', 'https:'].includes(new URL(url).protocol)
    } catch {
      return false
    }
  })
}

function isPermissionDefaults(v: unknown): v is PermissionDefaults {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  const keys = Object.keys(DEFAULT_SETTINGS.permissionDefaults)
  return Object.keys(o).length === keys.length && keys.every((k) => inList(PERMISSION_DEFAULTS)(o[k]))
}

function isListGroups(v: unknown): v is Record<FilterListGroup, boolean> {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return Object.keys(o).length === LIST_GROUPS.length && LIST_GROUPS.every((g) => isBool(o[g]))
}

/** Lower-case hostnames, no duplicates. */
function isHostList(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > MAX_PAUSED_SITES) return false
  return (
    new Set(v).size === v.length &&
    v.every((h) => typeof h === 'string' && h.length > 0 && h.length <= 253 && /^[a-z0-9.:[\]-]+$/.test(h))
  )
}

const VALIDATORS: Validators = {
  theme: inList(THEMES),
  darkStyle: inList(DARK_STYLES),
  websiteAppearance: inList(WEBSITE_APPEARANCES),
  searchEngine: inList(SEARCH_ENGINES),
  showBookmarksBar: isBool,
  startupBehavior: inList(STARTUP),
  startupPages: isStartupPages,
  askWhereToSave: isBool,
  autoLockTimer: inList(AUTO_LOCK),
  contentBlocking: isBool,
  blockerLists: isListGroups,
  blockerPausedSites: isHostList,
  stripTrackingParams: isBool,
  hideFromCapture: isBool,
  webrtcProxyOnly: isBool,
  ntpShowClock: isBool,
  ntpGreeting: isBool,
  ntpFont: isNtpFont,
  ntpShortcuts: inList(NTP_SHORTCUTS),
  ntpAutoShortcuts: isBool,
  ntpBackground: isNtpBackground,
  permissionDefaults: isPermissionDefaults,
  onboardingCompleted: isBool
}

/** Keeps valid keys and maps settings written by earlier Aqua versions. */
export function sanitizeSettings(raw: unknown): BrowserSettings {
  const result: BrowserSettings = structuredClone(DEFAULT_SETTINGS)
  if (typeof raw !== 'object' || raw === null) return result
  const input = raw as Record<string, unknown>

  if (input.themeAccent === 'oled') {
    result.darkStyle = 'midnight'
    result.theme = 'dark'
  }
  // "Pure black in dark mode" became the Midnight theme.
  if (input.oledBlack === true) result.darkStyle = 'midnight'
  if (typeof input.adBlockerEnabled === 'boolean') result.contentBlocking = input.adBlockerEnabled
  if (input.autoLockTimer === '2m') result.autoLockTimer = '1m'

  for (const key of Object.keys(VALIDATORS) as Array<keyof BrowserSettings>) {
    if (VALIDATORS[key](input[key])) (result as unknown as Record<string, unknown>)[key] = input[key]
  }
  return result
}

/**
 * The settings once the vault opens: what the vault stores wins over what was
 * known before (the theme hint). A vault from before dark styles existed keeps
 * its old "pure black" choice even when the hint doesn't mention it.
 */
export function mergeStoredSettings(current: BrowserSettings, stored: Record<string, unknown>): BrowserSettings {
  const base: Record<string, unknown> = { ...current }
  if ('oledBlack' in stored || 'themeAccent' in stored) delete base.darkStyle
  return sanitizeSettings({ ...base, ...stored })
}

/**
 * User preferences, one encrypted row per key in the `settings` table. Before
 * the vault opens, only the theme hint from plaintext metadata is known.
 */
export class SettingsService {
  readonly changed = new Signal<BrowserSettings>()
  private settings: BrowserSettings
  private readonly db: VaultDatabase

  constructor(db: VaultDatabase) {
    this.db = db
    const hint = db.getMeta<UiHint>('ui')
    this.settings = structuredClone(DEFAULT_SETTINGS)
    if (hint && VALIDATORS.theme(hint.theme)) this.settings.theme = hint.theme
    if (hint && VALIDATORS.darkStyle(hint.darkStyle)) this.settings.darkStyle = hint.darkStyle
    // A hint written before dark styles existed.
    else if (hint && (hint as { oledBlack?: unknown }).oledBlack === true) this.settings.darkStyle = 'midnight'
    if (hint && hint.hideFromCapture === true) this.settings.hideFromCapture = true
    db.unlocked.on(() => {
      this.settings = mergeStoredSettings(this.settings, db.readSettings())
      this.changed.emit(this.get())
    })
  }

  get(): BrowserSettings {
    return structuredClone(this.settings)
  }

  /** Applies only keys that pass validation; returns the resulting settings. */
  update(patch: Partial<Record<keyof BrowserSettings, unknown>>): BrowserSettings {
    const next = structuredClone(this.settings)
    const changed: Record<string, unknown> = {}
    for (const key of Object.keys(patch) as Array<keyof BrowserSettings>) {
      const validator = VALIDATORS[key]
      const value = patch[key]
      if (!validator || !validator(value)) continue
      if (JSON.stringify(next[key]) !== JSON.stringify(value)) {
        ;(next as unknown as Record<string, unknown>)[key] = structuredClone(value)
        changed[key] = value
      }
    }
    if (Object.keys(changed).length === 0) return this.get()
    this.settings = next
    if (this.db.isUnlocked) this.db.writeSettings(changed)
    if ('theme' in changed || 'darkStyle' in changed || 'hideFromCapture' in changed)
      this.db.setMeta('ui', hintOf(next))
    this.changed.emit(this.get())
    return this.get()
  }

  /** Imports settings from a pre-vault JSON file. */
  importLegacy(raw: unknown): void {
    const imported = sanitizeSettings(raw)
    this.settings = imported
    this.db.writeSettings(imported as unknown as Record<string, unknown>)
    this.db.setMeta('ui', hintOf(imported))
    this.changed.emit(this.get())
  }
}
