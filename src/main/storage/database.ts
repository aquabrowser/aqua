import { hkdfSync } from 'crypto'
import { existsSync, renameSync, rmSync } from 'fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { Signal } from '../lib/signal'
import { DecryptionError, KEY_BYTES, sealJson, unsealJson } from './crypto'

const SCHEMA_VERSION = 1

/**
 * The profile database: a single SQLite file in which every user record is
 * sealed with AES-256-GCM under the vault's data key.
 *
 *   meta       plaintext - vault header (KDF params, wrapped key) and UI hints
 *              needed before unlock (theme, window geometry). Nothing personal.
 *   settings   one encrypted row per setting
 *   documents  encrypted JSON documents (bookmarks, session, downloads, …)
 *   history    one encrypted row per visit (append-heavy, so row-level writes)
 *   site_storage  one encrypted row per origin: its localStorage (see SiteStorageService);
 *              row ids are keyed hashes, so not even the list of origins is readable
 *
 * Until `unlock()` receives the data key nothing can be read or written;
 * documents keep their defaults in memory and persist once unlocked.
 */
export class VaultDatabase {
  /** Fires once the data key is available and every document has loaded. */
  readonly unlocked = new Signal<void>()
  /** Fires just before the data key is wiped (lock, close): write what is pending, drop keys derived from it. */
  readonly locking = new Signal<void>()
  /** Fires when the key is back after a lock; documents kept their in-memory values meanwhile. */
  readonly reopened = new Signal<void>()
  private readonly db: DatabaseSync
  private key: Buffer | null = null
  /** Set by the first unlock, which loads the documents; later unlocks only bring the key back. */
  private loaded = false
  private readonly documents = new Map<string, EncryptedDocument<unknown>>()
  private readonly statements = new Map<string, StatementSync>()

  constructor(readonly file: string) {
    this.db = VaultDatabase.open(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS site_storage (id TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
  }

  /** Opens the file, quarantining it if SQLite reports it as corrupt. */
  private static open(file: string): DatabaseSync {
    try {
      const db = new DatabaseSync(file)
      db.exec('PRAGMA quick_check')
      return db
    } catch (err) {
      if (!existsSync(file)) throw err
      const quarantine = `${file}.corrupt-${Date.now()}`
      console.error(`[db] ${file} is unreadable, moved to ${quarantine}:`, err)
      renameSync(file, quarantine)
      for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
      return new DatabaseSync(file)
    }
  }

  get isUnlocked(): boolean {
    return this.key !== null
  }

  // ─── Plaintext metadata ───────────────────────────────────────────────────

  getMeta<T>(key: string): T | null {
    const row = this.statement('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value) as T
    } catch {
      return null
    }
  }

  setMeta(key: string, value: unknown): void {
    this.statement(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, JSON.stringify(value))
  }

  // ─── Key lifecycle ────────────────────────────────────────────────────────

  unlock(key: Buffer): void {
    this.key = Buffer.from(key)
    if (this.loaded) {
      // Back from a lock: memory is newer than the file, so nothing is reloaded; what changed meanwhile is written now.
      this.flush()
      this.reopened.emit()
      return
    }
    this.loaded = true
    for (const doc of this.documents.values()) doc.load()
    this.unlocked.emit()
  }

  /**
   * Writes what is pending, then zeroes the data key. The connection stays open:
   * the lock screen still reads the plaintext header. Changes made while locked
   * stay in memory and are written at the next unlock.
   */
  lock(): void {
    if (!this.key) return
    try {
      this.locking.emit()
      this.flush()
    } finally {
      // Whatever the writes did, the key goes (this also runs after an error nothing caught).
      this.key.fill(0)
      this.key = null
    }
  }

  /**
   * A key for a purpose other than sealing rows (e.g. hashing row ids),
   * derived from the data key so that key itself never leaves this class.
   * Different labels give unrelated keys.
   */
  deriveKey(label: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.requireKey(), Buffer.alloc(32), `aqua/v1/${label}`, KEY_BYTES))
  }

  // ─── Documents ────────────────────────────────────────────────────────────

  document<T>(name: string, options: DocumentOptions<T>): EncryptedDocument<T> {
    if (this.documents.has(name)) throw new Error(`document ${name} already registered`)
    const doc = new EncryptedDocument<T>(this, name, options)
    this.documents.set(name, doc as EncryptedDocument<unknown>)
    if (this.key) doc.load()
    return doc
  }

  readDocument(name: string): unknown | null {
    const row = this.statement('SELECT value FROM documents WHERE name = ?').get(name) as
      { value: Uint8Array } | undefined
    return row ? this.open(row.value, `documents/${name}`) : null
  }

  writeDocument(name: string, value: unknown): void {
    const blob = sealJson(this.requireKey(), value, `aqua/v1/documents/${name}`)
    this.statement(
      'INSERT INTO documents (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(name, blob, Date.now())
  }

  // ─── Settings table ───────────────────────────────────────────────────────

  readSettings(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const row of this.statement('SELECT key, value FROM settings').all() as Array<{
      key: string
      value: Uint8Array
    }>) {
      const value = this.open(row.value, `settings/${row.key}`)
      if (value !== null) out[row.key] = value
    }
    return out
  }

  writeSettings(entries: Record<string, unknown>): void {
    const key = this.requireKey()
    const upsert = this.statement(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    this.transaction(() => {
      for (const [name, value] of Object.entries(entries)) {
        upsert.run(name, sealJson(key, value, `aqua/v1/settings/${name}`))
      }
    })
  }

  // ─── History table ────────────────────────────────────────────────────────

  readHistory<T>(): T[] {
    const out: T[] = []
    for (const row of this.statement('SELECT id, value FROM history').all() as Array<{
      id: string
      value: Uint8Array
    }>) {
      const value = this.open(row.value, `history/${row.id}`)
      if (value !== null) out.push(value as T)
    }
    return out
  }

  writeHistory(puts: Array<{ id: string; value: unknown }>, deletes: string[]): void {
    if (puts.length === 0 && deletes.length === 0) return
    const key = this.requireKey()
    const upsert = this.statement(
      'INSERT INTO history (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value'
    )
    const remove = this.statement('DELETE FROM history WHERE id = ?')
    this.transaction(() => {
      for (const id of deletes) remove.run(id)
      for (const { id, value } of puts) upsert.run(id, sealJson(key, value, `aqua/v1/history/${id}`))
    })
  }

  clearHistory(): void {
    this.requireKey()
    this.db.exec('DELETE FROM history')
  }

  // ─── Site storage table ───────────────────────────────────────────────────

  readSiteStorage(id: string): unknown | null {
    const row = this.statement('SELECT value FROM site_storage WHERE id = ?').get(id) as
      { value: Uint8Array } | undefined
    return row ? this.open(row.value, `site_storage/${id}`) : null
  }

  writeSiteStorage(id: string, value: unknown): void {
    const blob = sealJson(this.requireKey(), value, `aqua/v1/site_storage/${id}`)
    this.statement(
      'INSERT INTO site_storage (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value'
    ).run(id, blob)
  }

  deleteSiteStorage(id: string): void {
    this.requireKey()
    this.statement('DELETE FROM site_storage WHERE id = ?').run(id)
  }

  clearSiteStorage(): void {
    this.requireKey()
    this.db.exec('DELETE FROM site_storage')
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Copies the WAL into the database file and truncates it, so replaced rows don't stay readable there. */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  flush(): void {
    for (const doc of this.documents.values()) doc.flush()
  }

  close(): void {
    if (!this.db.isOpen) return
    try {
      this.lock()
    } catch (err) {
      console.error('[db] final flush failed:', err)
    }
    this.key?.fill(0)
    this.key = null
    this.statements.clear()
    this.db.close()
  }

  /** Deletes the database and its WAL/SHM side files (vault wipe). */
  static deleteFiles(file: string): void {
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${file}${suffix}`, { force: true })
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private open(blob: Uint8Array, slot: string): unknown | null {
    try {
      return unsealJson(this.requireKey(), blob, `aqua/v1/${slot}`)
    } catch (err) {
      if (err instanceof DecryptionError) {
        // Tampered or foreign row: skip it rather than failing the whole profile.
        console.error(`[db] ${slot} failed authentication and was skipped`)
        return null
      }
      throw err
    }
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('vault is locked')
    return this.key
  }

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      this.statements.set(sql, stmt)
    }
    return stmt
  }
}

export interface DocumentOptions<T> {
  defaults: () => T
  /** Normalises untrusted stored JSON into a valid `T` (schema migrations live here). */
  sanitize: (raw: unknown) => T
  /** Coalesce bursts of changes into one write. */
  debounceMs?: number
}

/**
 * One encrypted JSON document with the same shape as a plain JSON store:
 * in-memory value, debounced persistence, explicit flush. Before the vault is
 * unlocked it holds defaults and defers writes.
 */
export class EncryptedDocument<T> {
  private data: T
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  private loadedOnce = false
  readonly loaded = new Signal<T>()

  constructor(
    private readonly db: VaultDatabase,
    readonly name: string,
    private readonly options: DocumentOptions<T>
  ) {
    this.data = options.defaults()
  }

  get value(): T {
    return this.data
  }

  get isLoaded(): boolean {
    return this.loadedOnce
  }

  set(next: T): void {
    this.data = next
    this.dirty = true
    if (!this.db.isUnlocked || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.options.debounceMs ?? 300)
  }

  update(mutator: (current: T) => T): void {
    this.set(mutator(this.data))
  }

  /** Replaces the value with untrusted JSON, normalised by the document's sanitizer. */
  importRaw(raw: unknown): void {
    this.set(this.options.sanitize(raw))
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty || !this.db.isUnlocked) return
    this.dirty = false
    try {
      this.db.writeDocument(this.name, this.data)
    } catch (err) {
      this.dirty = true
      console.error(`[db] failed to write ${this.name}:`, err)
    }
  }

  flushSync(): void {
    this.flush()
  }

  /** Called by the database when the data key becomes available. */
  load(): void {
    const raw = this.db.readDocument(this.name)
    if (raw !== null) {
      try {
        this.data = this.options.sanitize(raw)
      } catch (err) {
        console.error(`[db] ${this.name} could not be read, using defaults:`, err)
        this.data = this.options.defaults()
      }
    }
    this.loadedOnce = true
    this.flush()
    this.loaded.emit(this.data)
  }
}
