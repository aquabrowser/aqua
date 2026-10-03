import type { ProtocolGrant } from '../../shared/types'
import type { EncryptedDocument, VaultDatabase } from '../storage/database'

type GrantMap = Record<string, string[]>

/**
 * Sites the user allowed to launch an external application without asking
 * ("Always allow example.com to open this application"), keyed by origin and
 * URL scheme.
 */
export class ProtocolGrantsService {
  private readonly store: EncryptedDocument<GrantMap>

  constructor(db: VaultDatabase) {
    this.store = db.document('protocol-grants', {
      defaults: () => ({}),
      sanitize: (raw) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
        const out: GrantMap = {}
        for (const [origin, schemes] of Object.entries(raw as Record<string, unknown>)) {
          if (!Array.isArray(schemes)) continue
          const clean = schemes.filter((s): s is string => typeof s === 'string' && /^[a-z][a-z0-9+.-]*$/.test(s))
          if (clean.length) out[origin] = [...new Set(clean)]
        }
        return out
      }
    })
  }

  isAllowed(origin: string, scheme: string): boolean {
    return this.store.value[origin]?.includes(scheme) ?? false
  }

  allow(origin: string, scheme: string): void {
    if (this.isAllowed(origin, scheme)) return
    this.store.update((map) => ({ ...map, [origin]: [...(map[origin] ?? []), scheme] }))
  }

  revoke(origin: string, scheme: string): void {
    this.store.update((map) => {
      const next = { ...map }
      const left = (next[origin] ?? []).filter((s) => s !== scheme)
      if (left.length) next[origin] = left
      else delete next[origin]
      return next
    })
  }

  list(): ProtocolGrant[] {
    return Object.entries(this.store.value)
      .flatMap(([origin, schemes]) => schemes.map((scheme) => ({ origin, scheme })))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.scheme.localeCompare(b.scheme))
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
