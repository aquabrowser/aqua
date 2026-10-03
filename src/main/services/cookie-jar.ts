import type { Session } from 'electron'
import { isExpired, sanitizeCookies, toSetDetails, toStored, type StoredCookie } from '../lib/cookies'
import type { EncryptedDocument, VaultDatabase } from '../storage/database'

/** A burst of cookie changes (a page load sets dozens) is saved once, shortly after it settles. */
const SAVE_DELAY_MS = 1500
/** …but a page that never stops setting cookies still gets saved this often. */
const SAVE_MAX_WAIT_MS = 10_000
const RESTORE_BATCH = 50

/**
 * Cookies of the regular browsing session. The session itself is in memory
 * (Chromium writes no cookie database); the jar lives only in the vault,
 * sealed like every other record, and is loaded back into the session when
 * Aqua is unlocked.
 */
export class CookieJar {
  private readonly doc: EncryptedDocument<StoredCookie[]>
  private session: Session | null = null
  private delayTimer: NodeJS.Timeout | null = null
  private maxWaitTimer: NodeJS.Timeout | null = null
  private saving: Promise<void> = Promise.resolve()

  constructor(db: VaultDatabase) {
    this.doc = db.document<StoredCookie[]>('cookies', {
      defaults: () => [],
      sanitize: sanitizeCookies,
      debounceMs: 0
    })
  }

  /** Puts the saved cookies into `session`, then keeps the jar in step with it. */
  async attach(session: Session): Promise<void> {
    this.session = session
    const now = Date.now() / 1000
    const cookies = this.doc.value.filter((c) => !isExpired(c, now))
    let failed = 0
    for (let i = 0; i < cookies.length; i += RESTORE_BATCH) {
      const results = await Promise.allSettled(
        cookies.slice(i, i + RESTORE_BATCH).map((c) => session.cookies.set(toSetDetails(c)))
      )
      failed += results.filter((r) => r.status === 'rejected').length
    }
    if (failed > 0) console.warn(`[cookies] ${failed} of ${cookies.length} saved cookies were refused by Chromium`)
    session.cookies.on('changed', () => this.schedule())
  }

  /** Adds cookies from elsewhere (an older profile) to the session; they are saved with the next change. */
  async adopt(cookies: StoredCookie[]): Promise<number> {
    const session = this.session
    if (!session) return 0
    const now = Date.now() / 1000
    let adopted = 0
    for (let i = 0; i < cookies.length; i += RESTORE_BATCH) {
      const results = await Promise.allSettled(
        cookies
          .slice(i, i + RESTORE_BATCH)
          .filter((c) => !isExpired(c, now))
          .map((c) => session.cookies.set(toSetDetails(c)))
      )
      adopted += results.filter((r) => r.status === 'fulfilled').length
    }
    return adopted
  }

  /** Writes the session's cookies to the vault now (quit, "Clear browsing data"). */
  save(): Promise<void> {
    this.clearTimers()
    this.saving = this.saving.then(() => this.snapshot()).catch((err) => console.error('[cookies] save failed:', err))
    return this.saving
  }

  private schedule(): void {
    if (this.delayTimer) clearTimeout(this.delayTimer)
    this.delayTimer = setTimeout(() => void this.save(), SAVE_DELAY_MS)
    this.maxWaitTimer ??= setTimeout(() => void this.save(), SAVE_MAX_WAIT_MS)
  }

  private clearTimers(): void {
    if (this.delayTimer) clearTimeout(this.delayTimer)
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer)
    this.delayTimer = null
    this.maxWaitTimer = null
  }

  private async snapshot(): Promise<void> {
    if (!this.session) return
    const cookies = (await this.session.cookies.get({})).map(toStored).filter((c) => c !== null)
    this.doc.set(cookies)
    this.doc.flush()
  }
}
