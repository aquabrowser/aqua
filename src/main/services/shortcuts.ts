import type { Shortcut, TopSite } from '../../shared/types'
import { siteKey } from '../../shared/url'
import { uid } from '../lib/signal'
import type { EncryptedDocument, VaultDatabase } from '../storage/database'
import type { HistoryService } from './history'
import type { SettingsService } from './settings'

/** Tiles on the New Tab page (Chrome shows ten). */
export const MAX_SHORTCUTS = 10
const MAX_HIDDEN = 500
const MAX_TITLE = 100

/** Suggestions for a fresh profile, until history offers better ones. */
const DEFAULT_SITES: readonly TopSite[] = [
  { url: 'https://github.com/', title: 'GitHub', favicon: 'https://github.com/favicon.ico' },
  { url: 'https://www.youtube.com/', title: 'YouTube', favicon: 'https://www.youtube.com/favicon.ico' },
  {
    url: 'https://en.wikipedia.org/',
    title: 'Wikipedia',
    favicon: 'https://en.wikipedia.org/static/favicon/wikipedia.ico'
  },
  { url: 'https://news.ycombinator.com/', title: 'Hacker News', favicon: 'https://news.ycombinator.com/favicon.ico' }
]

interface CustomShortcut {
  id: string
  title: string
  url: string
}

interface ShortcutsFile {
  version: 1
  /** Added by the user, in order. */
  custom: CustomShortcut[]
  /** Site keys of suggestions the user removed. */
  hidden: string[]
}

function sanitize(raw: unknown): ShortcutsFile {
  const r = raw as Partial<ShortcutsFile> | null
  const custom = Array.isArray(r?.custom)
    ? r.custom
        .filter(
          (c): c is CustomShortcut =>
            !!c && typeof c.id === 'string' && typeof c.title === 'string' && typeof c.url === 'string'
        )
        .filter((c) => siteKey(c.url) !== null)
        .slice(0, MAX_SHORTCUTS)
    : []
  const hidden = Array.isArray(r?.hidden) ? r.hidden.filter((h): h is string => typeof h === 'string') : []
  return { version: 1, custom, hidden: hidden.slice(-MAX_HIDDEN) }
}

/**
 * New Tab page shortcuts. The user's own tiles come first; the rest are
 * filled from the most visited sites and a few defaults - unless that is
 * turned off (Settings → New Tab page), and then only the user's own show. Every site appears
 * at most once, however many of its pages are in history. Stored in the
 * encrypted vault like the rest of the profile.
 */
export class ShortcutsService {
  private readonly store: EncryptedDocument<ShortcutsFile>

  constructor(
    db: VaultDatabase,
    private readonly history: HistoryService,
    private readonly settings: SettingsService
  ) {
    this.store = db.document('shortcuts', {
      defaults: () => ({ version: 1, custom: [], hidden: [] }),
      sanitize
    })
  }

  list(): Shortcut[] {
    const { custom, hidden } = this.store.value
    const skipped = new Set(hidden)
    const seen = new Set<string>()
    const out: Shortcut[] = []

    for (const c of custom) {
      const key = siteKey(c.url)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const favicon = this.history.faviconFor(c.url) ?? `${new URL(c.url).origin}/favicon.ico`
      out.push({ id: c.id, url: c.url, title: c.title, favicon, custom: true })
    }
    const suggestions = this.settings.get().ntpAutoShortcuts
      ? [...this.history.topSites(MAX_SHORTCUTS * 3), ...DEFAULT_SITES]
      : []
    for (const site of suggestions) {
      if (out.length >= MAX_SHORTCUTS) break
      const key = siteKey(site.url)
      if (!key || seen.has(key) || skipped.has(key)) continue
      seen.add(key)
      out.push({ id: `site:${key}`, url: site.url, title: site.title, favicon: site.favicon, custom: false })
    }
    return out.slice(0, MAX_SHORTCUTS)
  }

  /** Adds a tile, or renames the user's existing tile for the same site. `url` must be a normalised http(s) URL. */
  add(title: string, url: string): Shortcut[] {
    const key = siteKey(url)
    if (!key) return this.list()
    const name = title.trim().slice(0, MAX_TITLE) || key
    this.store.update((file) => {
      const existing = file.custom.find((c) => siteKey(c.url) === key)
      const custom = existing
        ? file.custom.map((c) => (c === existing ? { ...c, title: name, url } : c))
        : [...file.custom, { id: uid('sc'), title: name, url }].slice(-MAX_SHORTCUTS)
      return { ...file, custom, hidden: file.hidden.filter((h) => h !== key) }
    })
    return this.list()
  }

  remove(id: string): Shortcut[] {
    this.store.update((file) => {
      if (id.startsWith('site:')) {
        const key = id.slice('site:'.length)
        return file.hidden.includes(key) ? file : { ...file, hidden: [...file.hidden, key].slice(-MAX_HIDDEN) }
      }
      return { ...file, custom: file.custom.filter((c) => c.id !== id) }
    })
    return this.list()
  }

  /** Undoes `remove`: puts a custom tile back at its position, or shows a suggestion again. */
  restore(shortcut: Pick<Shortcut, 'id' | 'title' | 'url' | 'custom'>, index: number): Shortcut[] {
    const key = siteKey(shortcut.url)
    if (!key) return this.list()
    this.store.update((file) => {
      if (!shortcut.custom) return { ...file, hidden: file.hidden.filter((h) => h !== key) }
      if (file.custom.some((c) => c.id === shortcut.id || siteKey(c.url) === key)) return file
      const custom = [...file.custom]
      custom.splice(Math.max(0, Math.min(index, custom.length)), 0, {
        id: shortcut.id,
        title: shortcut.title.slice(0, MAX_TITLE),
        url: shortcut.url
      })
      return { ...file, custom: custom.slice(0, MAX_SHORTCUTS) }
    })
    return this.list()
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
