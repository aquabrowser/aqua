/**
 * URL helpers that are safe to use in every process (no Node / Electron deps).
 */

export const INTERNAL_SCHEME = 'aqua:'
export const NEW_TAB_URL = 'aqua://newtab'

export type InternalPage = 'newtab' | 'settings' | 'history' | 'downloads' | 'unknown'

export function isInternalUrl(url: string): boolean {
  return url.startsWith('aqua://')
}

export function internalPageOf(url: string): InternalPage | null {
  if (!isInternalUrl(url)) return null
  const host = url.slice('aqua://'.length).split(/[/?#]/, 1)[0].toLowerCase()
  switch (host) {
    case 'newtab':
    case 'settings':
    case 'history':
    case 'downloads':
      return host
    default:
      return 'unknown'
  }
}

/** Sub-path of an internal page, e.g. `aqua://settings/privacy` → `privacy`. */
export function internalSubpage(url: string): string {
  const rest = url.slice('aqua://'.length)
  const slash = rest.indexOf('/')
  if (slash === -1) return ''
  return rest.slice(slash + 1).split(/[?#]/, 1)[0]
}

export function safeParse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export function hostOf(url: string): string {
  const parsed = safeParse(url)
  return parsed ? parsed.hostname : ''
}

export interface DisplayUrl {
  /** Emphasised part (host). */
  host: string
  /** De-emphasised remainder (path, query, hash). */
  rest: string
  /** Scheme prefix that is kept visible (e.g. `http://`, `file://`), or ''. */
  scheme: string
}

/**
 * Chrome-style elided URL for the unfocused omnibox: drops `https://`, a
 * leading `www.` and a lone trailing slash; keeps any other scheme visible.
 */
export function toDisplayUrl(url: string): DisplayUrl {
  if (!url) return { host: '', rest: '', scheme: '' }
  if (isInternalUrl(url)) return { host: url, rest: '', scheme: '' }
  const parsed = safeParse(url)
  if (!parsed || !parsed.host) return { host: url, rest: '', scheme: '' }

  let host = parsed.host
  if (host.startsWith('www.') && host.split('.').length > 2) host = host.slice(4)

  let rest = decodeForDisplay(parsed.pathname + parsed.search + parsed.hash)
  if (rest === '/') rest = ''

  const scheme = parsed.protocol === 'https:' ? '' : `${parsed.protocol}//`
  return { host, rest, scheme }
}

/** Single-line display string (used for suggestion rows, history, tooltips). */
export function formatUrlForDisplay(url: string): string {
  const d = toDisplayUrl(url)
  return d.scheme + d.host + d.rest
}

function decodeForDisplay(value: string): string {
  try {
    // Keep reserved/space characters encoded so the string stays unambiguous.
    return decodeURI(value).replace(/\s/g, (ch) => encodeURIComponent(ch))
  } catch {
    return value
  }
}

/**
 * The site a URL belongs to, for de-duplicating shortcuts: the host without
 * `www.` / `m.` / `mobile.`, so youtube.com, www.youtube.com and
 * m.youtube.com count as one. Null for anything that is not http(s).
 */
export function siteKey(url: string): string | null {
  const parsed = safeParse(url)
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null
  return parsed.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '')
}

/**
 * The web address carried by a drag (a link or an image dragged from a page,
 * a URL dragged from another app), or null. Only http(s) addresses qualify:
 * a drop must never run `javascript:` or open local files.
 */
export function droppedUrl(uriList: string, text: string): string | null {
  // text/uri-list: one URI per line, comments start with "#" (RFC 2483).
  const fromList = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'))
  for (const candidate of [fromList, text.trim()]) {
    if (!candidate || /\s/.test(candidate)) continue
    const url = safeParse(candidate)
    if (url && (url.protocol === 'http:' || url.protocol === 'https:')) return url.href
  }
  return null
}

/** A web address as a person types it ("example.com", "https://…/path"), as a full URL - or null. */
export function normalizeWebAddress(input: string): string | null {
  const text = input.trim()
  if (!text || /\s/.test(text)) return null
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  const url = safeParse(candidate)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null
  return url.href
}
