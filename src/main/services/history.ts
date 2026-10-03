import type { HistoryEntry, HistoryQuery, TopSite } from '../../shared/types'
import { siteKey } from '../../shared/url'
import { uid } from '../lib/signal'
import type { VaultDatabase } from '../storage/database'

interface StoredVisit extends HistoryEntry {
  /** The visit started from the omnibox (typed/pasted), which weighs more in ranking. */
  typed?: boolean
}

/** Aggregated per-URL row used for omnibox ranking and top sites. */
export interface UrlStats {
  url: string
  title: string
  favicon: string | null
  visits: number
  typed: number
  lastVisit: number
}

const MAX_VISITS = 5000
/** A current visit id (see uid). Ids from earlier versions embedded the visit time: `h-<ms in base36>-…`. */
const OPAQUE_ID = /^h-[0-9a-f]{32}$/
/** Reloads / same-URL redirects within this window update the last visit instead of adding one. */
const COALESCE_MS = 60_000

function sanitizeVisit(item: unknown): StoredVisit | null {
  if (typeof item !== 'object' || item === null) return null
  const v = item as Record<string, unknown>
  const url = typeof v.url === 'string' ? v.url : null
  const visitedAt = typeof v.visitedAt === 'number' ? v.visitedAt : typeof v.timestamp === 'number' ? v.timestamp : null
  if (!url || !visitedAt) return null
  return {
    id: typeof v.id === 'string' ? v.id : uid('h'),
    url,
    title: typeof v.title === 'string' ? v.title : url,
    favicon: typeof v.favicon === 'string' ? v.favicon : null,
    visitedAt,
    typed: v.typed === true ? true : undefined
  }
}

export function isRecordable(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://')
}

/**
 * Browsing history: one encrypted row per visit in the `history` table,
 * mirrored newest-first in memory. Writes are batched per event-loop turn.
 */
export class HistoryService {
  private visits: StoredVisit[] = []
  private statsCache: UrlStats[] | null = null
  private readonly pendingPuts = new Map<string, StoredVisit>()
  private readonly pendingDeletes = new Set<string>()
  private writeScheduled = false

  constructor(private readonly db: VaultDatabase) {
    db.unlocked.on(() => {
      const loaded = db
        .readHistory<unknown>()
        .map(sanitizeVisit)
        .filter((v): v is StoredVisit => v !== null)
      this.migrateIds(loaded)
      this.visits = loaded.sort((a, b) => b.visitedAt - a.visitedAt)
      this.trim()
      this.statsCache = null
    })
    // Pending visits are sealed before the key goes, and whatever piled up while locked once it is back.
    db.locking.on(() => this.flush())
    db.reopened.on(() => this.flush())
  }

  get size(): number {
    return this.visits.length
  }

  /** Records a committed main-frame navigation; returns the visit id. */
  addVisit(url: string, title: string, favicon: string | null, typed: boolean): string | null {
    if (!isRecordable(url) || !this.db.isUnlocked) return null
    const latest = this.visits[0]
    const now = Date.now()
    if (latest && latest.url === url && now - latest.visitedAt < COALESCE_MS) {
      latest.visitedAt = now
      if (title) latest.title = title
      if (favicon) latest.favicon = favicon
      if (typed) latest.typed = true
      this.save(latest)
      return latest.id
    }
    const visit: StoredVisit = {
      id: uid('h'),
      url,
      title: title || url,
      favicon,
      visitedAt: now,
      typed: typed || undefined
    }
    this.visits.unshift(visit)
    this.save(visit)
    this.trim()
    return visit.id
  }

  updateVisit(id: string, patch: { title?: string; favicon?: string | null }): void {
    const visit = this.visits.find((v) => v.id === id)
    if (!visit) return
    if (patch.title) visit.title = patch.title
    if (patch.favicon) visit.favicon = patch.favicon
    this.save(visit)
  }

  query({ text, before, limit = 100 }: HistoryQuery): HistoryEntry[] {
    const needle = text?.trim().toLowerCase() ?? ''
    const out: HistoryEntry[] = []
    for (const v of this.visits) {
      if (before !== undefined && v.visitedAt >= before) continue
      if (needle && !v.title.toLowerCase().includes(needle) && !v.url.toLowerCase().includes(needle)) continue
      out.push({ id: v.id, url: v.url, title: v.title, favicon: v.favicon, visitedAt: v.visitedAt })
      if (out.length >= limit) break
    }
    return out
  }

  remove(ids: string[]): void {
    const drop = new Set(ids)
    this.visits = this.visits.filter((v) => !drop.has(v.id))
    for (const id of drop) {
      this.pendingPuts.delete(id)
      this.pendingDeletes.add(id)
    }
    this.statsCache = null
    this.scheduleWrite()
  }

  clear(): void {
    this.visits = []
    this.pendingPuts.clear()
    this.pendingDeletes.clear()
    this.statsCache = null
    if (this.db.isUnlocked) this.db.clearHistory()
  }

  /** Imports visits from a pre-vault JSON file (v1 array or v2 `{ visits }`). */
  importLegacy(raw: unknown): void {
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { visits?: unknown })?.visits)
        ? (raw as { visits: unknown[] }).visits
        : []
    for (const visit of list.map(sanitizeVisit)) {
      if (!visit) continue
      this.visits.push(visit)
      this.pendingPuts.set(visit.id, visit)
    }
    this.visits.sort((a, b) => b.visitedAt - a.visitedAt)
    this.trim()
    this.statsCache = null
    this.flush()
  }

  /** Per-URL aggregates, cached until history changes. */
  stats(): UrlStats[] {
    if (this.statsCache) return this.statsCache
    const map = new Map<string, UrlStats>()
    // Visits are newest-first, so the first sighting carries the freshest title.
    for (const v of this.visits) {
      let row = map.get(v.url)
      if (!row) {
        row = { url: v.url, title: v.title, favicon: v.favicon, visits: 0, typed: 0, lastVisit: v.visitedAt }
        map.set(v.url, row)
      }
      row.visits++
      if (v.typed) row.typed++
      if (!row.favicon && v.favicon) row.favicon = v.favicon
    }
    this.statsCache = [...map.values()]
    return this.statsCache
  }

  topSites(limit: number): TopSite[] {
    const byOrigin = new Map<string, UrlStats & { score: number }>()
    const now = Date.now()
    for (const row of this.stats()) {
      let origin: string
      try {
        origin = new URL(row.url).origin
      } catch {
        continue
      }
      const ageDays = (now - row.lastVisit) / 86_400_000
      const score = row.visits * (ageDays < 7 ? 2 : ageDays < 30 ? 1 : 0.4)
      const existing = byOrigin.get(origin)
      // Prefer the shortest URL for an origin as the tile target (usually the home page).
      if (!existing) byOrigin.set(origin, { ...row, score })
      else {
        existing.score += score
        if (row.url.length < existing.url.length) {
          existing.url = row.url
          existing.title = row.title
        }
        if (!existing.favicon) existing.favicon = row.favicon
      }
    }
    return [...byOrigin.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ url, title, favicon }) => ({ url, title, favicon }))
  }

  /** The freshest favicon recorded for the site of `url`, if any. */
  faviconFor(url: string): string | null {
    const key = siteKey(url)
    if (!key) return null
    for (const row of this.stats()) if (row.favicon && siteKey(row.url) === key) return row.favicon
    return null
  }

  flush(): void {
    this.writeScheduled = false
    if (!this.db.isUnlocked) return
    const puts = [...this.pendingPuts.values()].map((v) => ({ id: v.id, value: v }))
    const deletes = [...this.pendingDeletes]
    this.pendingPuts.clear()
    this.pendingDeletes.clear()
    try {
      this.db.writeHistory(puts, deletes)
    } catch (err) {
      console.error('[history] write failed:', err)
    }
  }

  flushSync(): void {
    this.flush()
  }

  /**
   * Row ids are the one part of a visit stored in plaintext. Gives every visit
   * whose id is not opaque (it shows when the visit happened) a new one: the
   * visit is sealed again under the new id and the old row deleted, all in one
   * transaction. The WAL is emptied afterwards so the old ids don't linger there.
   */
  private migrateIds(visits: StoredVisit[]): void {
    const renamed: Array<{ visit: StoredVisit; oldId: string }> = []
    for (const visit of visits) {
      if (OPAQUE_ID.test(visit.id)) continue
      renamed.push({ visit, oldId: visit.id })
      visit.id = uid('h')
    }
    if (renamed.length === 0) return
    try {
      this.db.writeHistory(
        renamed.map(({ visit }) => ({ id: visit.id, value: visit })),
        renamed.map(({ oldId }) => oldId)
      )
      this.db.checkpoint()
      console.info(`[history] gave ${renamed.length} visits opaque ids`)
    } catch (err) {
      // The transaction rolled back: keep the ids the rows still have, or later writes would duplicate them.
      for (const { visit, oldId } of renamed) visit.id = oldId
      console.error('[history] id migration failed:', err)
    }
  }

  private save(visit: StoredVisit): void {
    this.statsCache = null
    this.pendingDeletes.delete(visit.id)
    this.pendingPuts.set(visit.id, visit)
    this.scheduleWrite()
  }

  private trim(): void {
    while (this.visits.length > MAX_VISITS) {
      const dropped = this.visits.pop()!
      this.pendingPuts.delete(dropped.id)
      this.pendingDeletes.add(dropped.id)
    }
    this.scheduleWrite()
  }

  private scheduleWrite(): void {
    if (this.writeScheduled) return
    this.writeScheduled = true
    setImmediate(() => this.flush())
  }
}
