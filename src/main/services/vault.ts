import { app } from 'electron'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { VaultResult, VaultStatus } from '../../shared/types'
import { SHARED_ROOT_ENTRIES } from '../lib/profiles'
import { Signal } from '../lib/signal'
import { DecryptionError, randomKey, seal, unseal } from '../storage/crypto'
import type { VaultDatabase } from '../storage/database'
import { defaultKdfParams, deriveKey, type KdfParams } from '../storage/kdf'
import { readLegacyVault, verifyLegacyPassword } from '../storage/legacy'

export const MIN_PASSWORD_LENGTH = 8
export const WIPE_MARKER = 'wipe.pending'
export const WIPE_CONFIRMATION = 'WIPE'
const WRAP_AAD = 'aqua/v1/data-key'

/** Stored in plaintext `meta`: everything needed to derive and unwrap the data key, nothing more. */
interface VaultHeader {
  version: 1
  kdf: KdfParams
  /** Data key sealed with the Argon2id key (AES-256-GCM, base64). */
  wrappedKey: string
  createdAt: number
  changedAt: number
}

interface Throttle {
  failures: number
  lockedUntil: number
}

/**
 * Zero-knowledge vault.
 *
 *   master password ──Argon2id──▶ key-encryption key ──unwraps──▶ data key ──▶ every record
 *
 * The data key is random and never leaves the process; only its wrapped form
 * is stored. Changing the password re-wraps it (no data is re-encrypted).
 * There is deliberately no recovery path: a forgotten password means the data
 * is unreadable, and the only way forward is a wipe.
 */
export class VaultService {
  readonly changed = new Signal<VaultStatus>()
  /** Fires once, the first time the data key becomes available in this process. */
  readonly opened = new Signal<void>()
  private isUnlocked = false
  private openedOnce = false
  private busy = false
  private ephemeral = false

  constructor(
    private readonly db: VaultDatabase,
    private readonly dir: string,
    private readonly migrate: () => void
  ) {}

  status(): VaultStatus {
    const header = this.header()
    const legacy = !header && readLegacyVault(this.dir) !== null
    return {
      state: this.isUnlocked ? 'unlocked' : header || legacy ? 'locked' : 'setup',
      legacyUpgrade: legacy
    }
  }

  isOpen(): boolean {
    return this.isUnlocked
  }

  /**
   * A guest session: the database is in memory, unlocked with a random key that is never stored
   * or derived from a password. There is nothing to lock, change or wipe; it ends with the process.
   */
  openEphemeral(): void {
    if (this.isUnlocked || this.db.file !== ':memory:') return
    const key = randomKey()
    this.ephemeral = true
    this.db.unlock(key)
    key.fill(0)
    this.open()
  }

  /** First run: create the vault. */
  async setup(password: string): Promise<VaultResult> {
    if (this.status().state !== 'setup') return { success: false, error: 'A vault already exists.' }
    const problem = passwordProblem(password)
    if (problem) return { success: false, error: problem }
    return this.exclusive(async () => {
      await this.create(password)
      this.open()
      return { success: true }
    })
  }

  async unlock(password: string): Promise<VaultResult> {
    const wait = Math.ceil((this.throttle().lockedUntil - Date.now()) / 1000)
    if (wait > 0) return { success: false, error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait }

    return this.exclusive(async () => {
      const header = this.header()
      let ok = false
      if (header) {
        const dataKey = await this.unwrap(header, password)
        if (dataKey) {
          ok = true
          if (!this.db.isUnlocked) this.db.unlock(dataKey)
          dataKey.fill(0)
        }
      } else {
        const legacy = readLegacyVault(this.dir)
        if (legacy && (await verifyLegacyPassword(legacy, password))) {
          ok = true
          // Upgrade: same password, new Argon2id vault, then import the plaintext files.
          await this.create(password)
        }
      }

      if (!ok) return this.fail()
      this.db.setMeta('throttle', { failures: 0, lockedUntil: 0 } satisfies Throttle)
      this.open()
      return { success: true }
    })
  }

  lock(): void {
    if (!this.isUnlocked || this.ephemeral) return
    this.isUnlocked = false
    // Pending writes are sealed, then the data key is zeroed; unlocking unwraps it again.
    this.db.lock()
    this.changed.emit(this.status())
  }

  async changePassword(current: string, next: string): Promise<VaultResult> {
    if (this.ephemeral) return { success: false, error: 'A guest session has no master password.' }
    const problem = passwordProblem(next)
    if (problem) return { success: false, error: problem }
    return this.exclusive(async () => {
      const header = this.header()
      if (!header) return { success: false, error: 'No vault to update.' }
      const dataKey = await this.unwrap(header, current)
      if (!dataKey) return { success: false, error: 'That isn’t your current password.' }
      const kdf = defaultKdfParams()
      const kek = await deriveKey(next, kdf)
      try {
        this.db.setMeta('vault', {
          ...header,
          kdf,
          wrappedKey: seal(kek, dataKey, WRAP_AAD).toString('base64'),
          changedAt: Date.now()
        } satisfies VaultHeader)
      } finally {
        kek.fill(0)
        dataKey.fill(0)
      }
      return { success: true }
    })
  }

  /**
   * Destroys every trace of the profile. The database is open in this process,
   * so deletion happens at the start of the next launch (see `performPendingWipe`).
   */
  wipe(confirmation: string): VaultResult {
    if (this.ephemeral) return { success: false, error: 'A guest session keeps nothing to wipe.' }
    if (confirmation !== WIPE_CONFIRMATION) return { success: false, error: `Type ${WIPE_CONFIRMATION} to confirm.` }
    writeFileSync(join(this.dir, WIPE_MARKER), new Date().toISOString())
    app.relaunch()
    app.exit(0)
    return { success: true }
  }

  private async create(password: string): Promise<void> {
    const kdf = defaultKdfParams()
    const kek = await deriveKey(password, kdf)
    const dataKey = randomKey()
    try {
      const now = Date.now()
      this.db.setMeta('vault', {
        version: 1,
        kdf,
        wrappedKey: seal(kek, dataKey, WRAP_AAD).toString('base64'),
        createdAt: now,
        changedAt: now
      } satisfies VaultHeader)
      this.db.unlock(dataKey)
    } finally {
      kek.fill(0)
      dataKey.fill(0)
    }
    this.migrate()
  }

  private open(): void {
    const first = !this.isUnlocked && !this.openedOnce
    this.isUnlocked = true
    this.changed.emit(this.status())
    if (first) {
      this.openedOnce = true
      this.opened.emit()
    }
  }

  private async unwrap(header: VaultHeader, password: string): Promise<Buffer | null> {
    const kek = await deriveKey(password, header.kdf)
    try {
      return unseal(kek, Buffer.from(header.wrappedKey, 'base64'), WRAP_AAD)
    } catch (err) {
      if (err instanceof DecryptionError) return null
      throw err
    } finally {
      kek.fill(0)
    }
  }

  /** Exponential back-off after three failures, persisted so restarting the app does not reset it. */
  private fail(): VaultResult {
    const t = this.throttle()
    t.failures++
    let result: VaultResult = { success: false, error: 'Wrong password.' }
    if (t.failures >= 3) {
      const seconds = Math.min(300, 2 ** (t.failures - 3) * 5)
      t.lockedUntil = Date.now() + seconds * 1000
      result = { success: false, error: `Wrong password. Try again in ${seconds}s.`, retryAfter: seconds }
    }
    this.db.setMeta('throttle', t)
    return result
  }

  private throttle(): Throttle {
    const t = this.db.getMeta<Throttle>('throttle')
    return { failures: t?.failures ?? 0, lockedUntil: t?.lockedUntil ?? 0 }
  }

  private header(): VaultHeader | null {
    const header = this.db.getMeta<VaultHeader>('vault')
    return header && header.version === 1 && typeof header.wrappedKey === 'string' ? header : null
  }

  /** One key derivation at a time: double-submits must not race each other. */
  private async exclusive(task: () => Promise<VaultResult>): Promise<VaultResult> {
    if (this.busy) return { success: false, error: 'Please wait…' }
    this.busy = true
    try {
      return await task()
    } finally {
      this.busy = false
    }
  }
}

/**
 * Completes a wipe requested in the previous run: deletes every file of the
 * profile - the encrypted database, Chromium's cookies, caches and site
 * storage, extension state. Must run before anything opens the profile, and
 * only in the instance that holds the single-instance lock.
 *
 * Returns true if a wipe was performed.
 */
export function performPendingWipe(dir: string): boolean {
  const marker = join(dir, WIPE_MARKER)
  if (!existsSync(marker)) return false
  const target = resolve(dir)
  // Never empty a drive root or the home folder, whatever userData points at.
  if (dirname(target) === target || target === resolve(homedir())) {
    console.error(`[vault] refusing to wipe ${target}`)
    return false
  }
  for (const entry of readdirSync(target)) {
    // The default profile's folder also holds the other profiles: wiping it leaves them alone.
    if (entry === WIPE_MARKER || SHARED_ROOT_ENTRIES.has(entry)) continue
    try {
      rmSync(join(target, entry), { recursive: true, force: true, maxRetries: 3 })
    } catch (err) {
      // The single-instance lock file is held open by this very process.
      console.warn(`[vault] could not delete ${entry}:`, (err as Error).message)
    }
  }
  rmSync(marker, { force: true })
  return true
}

export function passwordProblem(password: string): string | null {
  if (password.trim().length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  return null
}
