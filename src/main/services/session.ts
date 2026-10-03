import { screen, type Rectangle } from 'electron'
import type { EncryptedDocument, VaultDatabase } from '../storage/database'

export interface SessionEntry {
  url: string
  title: string
}

export interface SessionTab {
  url: string
  title: string
  favicon: string | null
  pinned: boolean
  muted: boolean
  entries: SessionEntry[]
  index: number
}

export interface SessionWindow {
  bounds: Rectangle | null
  maximized: boolean
  tabs: SessionTab[]
  activeIndex: number
}

interface SessionFile {
  version: 1
  windows: SessionWindow[]
  /** Geometry of the most recently closed window, reused for new windows. */
  lastBounds: Rectangle | null
  lastMaximized: boolean
}

function isRect(v: unknown): v is Rectangle {
  const r = v as Rectangle
  return !!r && [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n))
}

function sanitizeTab(raw: unknown): SessionTab | null {
  const t = raw as Partial<SessionTab>
  if (!t || typeof t.url !== 'string') return null
  const entries = Array.isArray(t.entries)
    ? t.entries
        .filter((e): e is SessionEntry => !!e && typeof e.url === 'string')
        .map((e) => ({ url: e.url, title: typeof e.title === 'string' ? e.title : '' }))
    : []
  return {
    url: t.url,
    title: typeof t.title === 'string' ? t.title : '',
    favicon: typeof t.favicon === 'string' ? t.favicon : null,
    pinned: t.pinned === true,
    muted: t.muted === true,
    entries,
    index:
      typeof t.index === 'number' && t.index >= 0 && t.index < entries.length
        ? t.index
        : Math.max(0, entries.length - 1)
  }
}

function sanitize(raw: unknown): SessionFile {
  const r = raw as Partial<SessionFile> | null
  const windows = Array.isArray(r?.windows)
    ? r.windows
        .map((w) => {
          const tabs = Array.isArray(w?.tabs) ? w.tabs.map(sanitizeTab).filter((t): t is SessionTab => t !== null) : []
          return {
            bounds: isRect(w?.bounds) ? w.bounds : null,
            maximized: w?.maximized === true,
            tabs,
            activeIndex:
              typeof w?.activeIndex === 'number'
                ? Math.min(Math.max(0, w.activeIndex), Math.max(0, tabs.length - 1))
                : 0
          }
        })
        .filter((w) => w.tabs.length > 0)
    : []
  return {
    version: 1,
    windows,
    lastBounds: isRect(r?.lastBounds) ? r.lastBounds : null,
    lastMaximized: r?.lastMaximized === true
  }
}

/** Keeps a window rectangle usable: on a connected display and at least partly visible. */
export function fitToDisplays(bounds: Rectangle | null): Rectangle | null {
  if (!bounds) return null
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  const width = Math.min(Math.max(bounds.width, 800), area.width)
  const height = Math.min(Math.max(bounds.height, 500), area.height)
  const visibleX = Math.min(bounds.x + width, area.x + area.width) - Math.max(bounds.x, area.x)
  const visibleY = Math.min(bounds.y + height, area.y + area.height) - Math.max(bounds.y, area.y)
  if (visibleX < 120 || visibleY < 60) {
    return {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height
    }
  }
  return { x: bounds.x, y: bounds.y, width, height }
}

interface GeometryHint {
  bounds: Rectangle | null
  maximized: boolean
}

/**
 * Open windows and tabs (encrypted document) plus the last window geometry,
 * which is kept as a plaintext hint so the first window - shown before the
 * vault is unlocked - opens where the user left it.
 */
export class SessionService {
  private readonly store: EncryptedDocument<SessionFile>

  constructor(private readonly db: VaultDatabase) {
    this.store = db.document('session', {
      defaults: () => ({ version: 1, windows: [], lastBounds: null, lastMaximized: false }),
      sanitize,
      debounceMs: 1000
    })
  }

  windows(): SessionWindow[] {
    return this.store.value.windows
  }

  lastGeometry(): { bounds: Rectangle | null; maximized: boolean } {
    const hint = this.db.getMeta<GeometryHint>('window')
    return { bounds: fitToDisplays(isRect(hint?.bounds) ? hint.bounds : null), maximized: hint?.maximized === true }
  }

  save(windows: SessionWindow[], last?: GeometryHint): void {
    this.store.set({ version: 1, windows, lastBounds: null, lastMaximized: false })
    const geometry = last ?? (windows[0] ? { bounds: windows[0].bounds, maximized: windows[0].maximized } : null)
    if (geometry) this.db.setMeta('window', geometry)
  }

  /** Imports a pre-vault session file. */
  importLegacy(raw: unknown): void {
    const file = sanitize(raw)
    this.store.set(file)
    if (file.lastBounds) this.db.setMeta('window', { bounds: file.lastBounds, maximized: file.lastMaximized })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
