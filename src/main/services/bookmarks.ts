import type { Bookmark } from '../../shared/types'
import type { EncryptedDocument, VaultDatabase } from '../storage/database'
import { Signal, uid } from '../lib/signal'

interface BookmarksFile {
  version: 1
  bar: Bookmark[]
}

const MAX_BOOKMARKS = 5000

function sanitize(raw: unknown): BookmarksFile {
  const list = Array.isArray((raw as { bar?: unknown })?.bar) ? (raw as { bar: unknown[] }).bar : []
  const bar: Bookmark[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const b = item as Record<string, unknown>
    if (typeof b.url !== 'string' || !b.url) continue
    bar.push({
      id: typeof b.id === 'string' ? b.id : uid('b'),
      url: b.url,
      title: typeof b.title === 'string' ? b.title : b.url,
      favicon: typeof b.favicon === 'string' ? b.favicon : null,
      createdAt: typeof b.createdAt === 'number' ? b.createdAt : Date.now()
    })
  }
  return { version: 1, bar: bar.slice(0, MAX_BOOKMARKS) }
}

export class BookmarksService {
  readonly changed = new Signal<Bookmark[]>()
  private readonly store: EncryptedDocument<BookmarksFile>

  constructor(db: VaultDatabase) {
    this.store = db.document('bookmarks', {
      defaults: () => ({ version: 1, bar: [] }),
      sanitize,
      debounceMs: 250
    })
    this.store.loaded.on(() => this.changed.emit(this.list()))
  }

  /** Imports bookmarks from a pre-vault JSON file. */
  importLegacy(raw: unknown): void {
    this.commit(sanitize(raw).bar)
  }

  list(): Bookmark[] {
    return this.store.value.bar.map((b) => ({ ...b }))
  }

  get(id: string): Bookmark | undefined {
    return this.store.value.bar.find((b) => b.id === id)
  }

  findByUrl(url: string): Bookmark | undefined {
    return this.store.value.bar.find((b) => b.url === url)
  }

  /** Star semantics: bookmarking an already-bookmarked URL returns the existing entry. */
  add(input: { url: string; title: string; favicon: string | null }): Bookmark {
    const existing = this.findByUrl(input.url)
    if (existing) return { ...existing }
    if (this.store.value.bar.length >= MAX_BOOKMARKS) throw new Error('Bookmark limit reached')
    const bookmark: Bookmark = {
      id: uid('b'),
      url: input.url,
      title: input.title.trim() || input.url,
      favicon: input.favicon,
      createdAt: Date.now()
    }
    this.commit([...this.store.value.bar, bookmark])
    return { ...bookmark }
  }

  update(id: string, patch: { title?: string; url?: string }): void {
    this.commit(
      this.store.value.bar.map((b) =>
        b.id === id ? { ...b, title: patch.title?.trim() || b.title, url: patch.url?.trim() || b.url } : b
      )
    )
  }

  remove(id: string): void {
    this.commit(this.store.value.bar.filter((b) => b.id !== id))
  }

  move(id: string, index: number): void {
    const bar = [...this.store.value.bar]
    const from = bar.findIndex((b) => b.id === id)
    if (from === -1) return
    const [item] = bar.splice(from, 1)
    bar.splice(Math.max(0, Math.min(index, bar.length)), 0, item)
    this.commit(bar)
  }

  /** Backfills a favicon for bookmarks of a page once the page reports one. */
  updateFavicon(url: string, favicon: string): void {
    let changed = false
    const bar = this.store.value.bar.map((b) => {
      if (b.url !== url || b.favicon === favicon) return b
      changed = true
      return { ...b, favicon }
    })
    if (changed) this.commit(bar)
  }

  flushSync(): void {
    this.store.flushSync()
  }

  private commit(bar: Bookmark[]): void {
    this.store.set({ version: 1, bar })
    this.changed.emit(this.list())
  }
}
