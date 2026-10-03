import { parse } from 'tldts'

/** Chromium's localStorage quota is 10 MiB per origin (UTF-16); a snapshot above it cannot be genuine. */
export const MAX_STORAGE_CHARS = 5 * 1024 * 1024
const MAX_KEYS = 10_000

/**
 * The origin of an http(s) URL or origin string ("https://example.com:8443"),
 * or null for anything else (opaque origins, about:, data:, files).
 */
export function webOriginOf(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

/** Scheme and registrable domain ("https://example.co.uk"); the host itself for IPs and single-label hosts. */
export function siteOf(origin: string): string | null {
  const web = webOriginOf(origin)
  if (!web) return null
  const url = new URL(web)
  // Private suffixes count too (user.github.io is its own site), as in Chromium.
  const domain = parse(url.hostname, { allowPrivateDomains: true }).domain
  return `${url.protocol}//${domain ?? url.hostname}`
}

/**
 * Whether a frame's localStorage is kept across restarts: only first-party
 * storage, i.e. frames on the same site as the tab's top document. Embedded
 * third parties (ads, widgets, trackers) keep theirs for the session only.
 */
export function persistsStorage(frameOrigin: string, topOrigin: string): boolean {
  const frame = siteOf(frameOrigin)
  return frame !== null && frame === siteOf(topOrigin)
}

/** Validates a localStorage snapshot sent by a renderer; null if it is not a plausible one. */
export function sanitizeStorageItems(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_KEYS) return null
  const out: Record<string, string> = Object.create(null)
  let chars = 0
  for (const [key, value] of entries) {
    if (typeof value !== 'string') return null
    chars += key.length + value.length
    if (chars > MAX_STORAGE_CHARS) return null
    out[key] = value
  }
  return out
}
