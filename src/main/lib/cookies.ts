import type { Cookie, CookiesSetDetails } from 'electron'

/**
 * A cookie as Aqua keeps it in the vault: everything needed to set it again
 * through `session.cookies.set`, nothing else.
 */
export interface StoredCookie {
  name: string
  value: string
  /** As Chromium reports it: a leading dot for domain cookies, the bare host for host-only ones. */
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: Cookie['sameSite']
  /** Seconds since the epoch; absent for session cookies. */
  expirationDate?: number
}

const SAME_SITE = new Set<Cookie['sameSite']>(['unspecified', 'no_restriction', 'lax', 'strict'])
/** A cookie jar far larger than any real profile's is not ours: refuse it rather than stall the unlock. */
export const MAX_COOKIES = 20_000
const MAX_FIELD = 16 * 1024

export function toStored(cookie: Cookie): StoredCookie | null {
  const domain = cookie.domain ?? ''
  if (!domain || !cookie.name) return null
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    hostOnly: cookie.hostOnly ?? !domain.startsWith('.'),
    path: cookie.path || '/',
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite,
    ...(cookie.session === false && cookie.expirationDate !== undefined
      ? { expirationDate: cookie.expirationDate }
      : {})
  }
}

/** What `session.cookies.set` needs to recreate the cookie exactly (host-only-ness, prefixes, SameSite). */
export function toSetDetails(cookie: StoredCookie): CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, '')
  return {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path.startsWith('/') ? cookie.path : '/'}`,
    name: cookie.name,
    value: cookie.value,
    // Without a domain Chromium creates a host-only cookie, which "__Host-" cookies must be.
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {})
  }
}

export function isExpired(cookie: StoredCookie, nowSeconds: number): boolean {
  return cookie.expirationDate !== undefined && cookie.expirationDate <= nowSeconds
}

/** Normalises the stored jar (read from the vault, so authenticated - but still checked field by field). */
export function sanitizeCookies(raw: unknown): StoredCookie[] {
  if (!Array.isArray(raw)) return []
  const out: StoredCookie[] = []
  for (const item of raw.slice(0, MAX_COOKIES)) {
    if (typeof item !== 'object' || item === null) continue
    const c = item as Record<string, unknown>
    const text = (v: unknown): string | null => (typeof v === 'string' && v.length <= MAX_FIELD ? v : null)
    const name = text(c.name)
    const value = text(c.value)
    const domain = text(c.domain)
    const path = text(c.path)
    if (!name || value === null || !domain || !path) continue
    const sameSite = SAME_SITE.has(c.sameSite as Cookie['sameSite'])
      ? (c.sameSite as Cookie['sameSite'])
      : 'unspecified'
    const expires = typeof c.expirationDate === 'number' && Number.isFinite(c.expirationDate) ? c.expirationDate : null
    out.push({
      name,
      value,
      domain,
      hostOnly: c.hostOnly === true,
      path,
      secure: c.secure === true,
      httpOnly: c.httpOnly === true,
      sameSite,
      ...(expires !== null ? { expirationDate: expires } : {})
    })
  }
  return out
}
