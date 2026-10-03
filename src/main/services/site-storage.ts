import { createHmac } from 'crypto'
import type { VaultDatabase } from '../storage/database'

/** How long after an origin's first restore other documents starting with it still get the saved items. */
const RESTORE_WINDOW_MS = 3000

interface StoredOrigin {
  origin: string
  items: Record<string, string>
  savedAt: number
}

/**
 * localStorage of first-party frames in the regular browsing session.
 *
 * The session is in memory, so Chromium never writes site storage to disk.
 * The tab preload restores an origin's saved items before the first page of
 * that origin runs any script, and sends snapshots back as they change; they
 * are sealed into the vault, one row per origin. Row ids are keyed hashes of
 * the origin, so the database does not even reveal which sites have data.
 */
export class SiteStorageService {
  /** Origins whose live data a page has reported in this run: the session holds it from then on. */
  private readonly live = new Set<string>()
  /** When each origin was first restored in this run. */
  private readonly restoredAt = new Map<string, number>()
  private idKey: Buffer | null = null

  constructor(private readonly db: VaultDatabase) {
    // Derived from the data key, so it goes with it (re-derived on first use after unlocking).
    db.locking.on(() => {
      this.idKey?.fill(0)
      this.idKey = null
    })
  }

  /**
   * Saved items for a document of `origin` that is starting, or null. Offered
   * only around the first restore of this run (documents starting together -
   * a page and its same-origin frames - all get them; the preload applies them
   * only to an empty storage), never once the origin's live data is known.
   */
  restore(origin: string): Record<string, string> | null {
    if (!this.db.isUnlocked || this.live.has(origin)) return null
    const first = this.restoredAt.get(origin)
    if (first === undefined) this.restoredAt.set(origin, Date.now())
    else if (Date.now() - first > RESTORE_WINDOW_MS) return null
    const row = this.db.readSiteStorage(this.rowId(origin)) as StoredOrigin | null
    // The origin is sealed with the row: a row can't be moved to another origin's id.
    if (!row || row.origin !== origin || typeof row.items !== 'object' || row.items === null) return null
    return row.items
  }

  save(origin: string, items: Record<string, string>): void {
    if (!this.db.isUnlocked) return
    this.live.add(origin)
    const id = this.rowId(origin)
    if (Object.keys(items).length === 0) this.db.deleteSiteStorage(id)
    else this.db.writeSiteStorage(id, { origin, items, savedAt: Date.now() } satisfies StoredOrigin)
  }

  clear(): void {
    if (!this.db.isUnlocked) return
    // With the rows gone there is nothing left to restore; what open pages write from now on is new data.
    this.db.clearSiteStorage()
  }

  private rowId(origin: string): string {
    this.idKey ??= this.db.deriveKey('site-storage-ids')
    return createHmac('sha256', this.idKey).update(origin).digest('hex')
  }
}
