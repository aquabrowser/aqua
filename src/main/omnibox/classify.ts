/**
 * Omnibox input classification: decides whether text typed into the address
 * bar is a URL to load, an external-application URL, or a search query.
 *
 * Kept free of Electron and relative imports so it runs under `node --test`.
 */
import { pathToFileURL } from 'node:url'
import { parse as parseDomain } from 'tldts'

export type Classification =
  { type: 'url'; url: string } | { type: 'external'; url: string } | { type: 'search'; query: string }

/** Schemes the browser loads itself. */
const NAVIGABLE = new Set(['http:', 'https:', 'file:', 'aqua:', 'about:', 'data:', 'view-source:'])
/** Never navigable from the omnibox; the text is searched instead (as Chrome does for pasted `javascript:`). */
const FORBIDDEN = new Set([
  'javascript:',
  'vbscript:',
  'aqua-ui:',
  'devtools:',
  'chrome:',
  'chrome-extension:',
  'blob:'
])

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i

export interface ClassifyOptions {
  /** Ctrl+Enter: `example` → `https://www.example.com/`. */
  ctrlEnter?: boolean
  platform?: NodeJS.Platform
}

export function classifyInput(raw: string, options: ClassifyOptions = {}): Classification {
  const input = raw.trim()
  if (!input) return { type: 'search', query: '' }

  // Explicit search: "?query"
  if (input.startsWith('?')) return { type: 'search', query: input.slice(1).trim() }

  if (options.ctrlEnter && /^[a-z0-9-]+$/i.test(input)) {
    return { type: 'url', url: `https://www.${input.toLowerCase()}.com/` }
  }

  // Local paths: C:\dir\file, C:/dir, \\server\share
  if (/^[a-zA-Z]:[\\/]/.test(input) || /^\\\\[^\\]/.test(input)) {
    try {
      return { type: 'url', url: pathToFileURL(input).href }
    } catch {
      return { type: 'search', query: input }
    }
  }
  if ((options.platform ?? process.platform) !== 'win32' && /^\/[^\s/]/.test(input) && !/\s/.test(input)) {
    return { type: 'url', url: pathToFileURL(input).href }
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s.exec(input)
  if (schemeMatch) {
    const scheme = `${schemeMatch[1].toLowerCase()}:`
    const rest = schemeMatch[2]
    const looksLikeHostPort = /^\d{1,5}(?:[/?#]|$)/.test(rest)

    if (!looksLikeHostPort) {
      if (FORBIDDEN.has(scheme)) return { type: 'search', query: input }
      if (scheme === 'http:' || scheme === 'https:') {
        const url = tryUrl(rest.startsWith('//') ? input : `${scheme}//${rest}`)
        return url ? { type: 'url', url } : { type: 'search', query: input }
      }
      if (NAVIGABLE.has(scheme)) {
        const url = tryUrl(input)
        return url ? { type: 'url', url } : { type: 'search', query: input }
      }
      // "note: buy milk" is prose, not a URL.
      if (/\s/.test(input) || rest.length === 0) return { type: 'search', query: input }
      const url = tryUrl(input)
      return url ? { type: 'external', url } : { type: 'search', query: input }
    }
  }

  if (/\s/.test(input)) return { type: 'search', query: input }

  const hostPart = input.split(/[/?#]/, 1)[0]
  if (!hostPart || hostPart.includes('@')) return { type: 'search', query: input }

  const hasPath = input.length > hostPart.length
  const { host, port } = splitHostPort(hostPart)
  if (host === null) return { type: 'search', query: input }
  const lowerHost = host.toLowerCase()

  // Loopback and literal IPs are almost always local dev servers → http.
  if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost')) return urlOrSearch(`http://${input}`, input)
  if (IPV4.test(lowerHost) || lowerHost.startsWith('[')) return urlOrSearch(`http://${input}`, input)

  // Pure numbers like "3.14" parse as IPv4 shorthand under WHATWG rules: search them.
  if (/^[\d.]+$/.test(lowerHost)) return { type: 'search', query: input }

  const labels = lowerHost.split('.')
  const validLabels = labels.every((l) => LABEL.test(l) || /^xn--/.test(l)) || !/^[\x00-\x7f]*$/.test(lowerHost)

  if (labels.length >= 2 && validLabels) {
    const ascii = toAsciiHost(lowerHost)
    const info = ascii ? parseDomain(ascii) : null
    if (info && info.isIcann && info.domain) return urlOrSearch(`https://${input}`, input)
  }

  // Unknown TLD / single label, but an explicit port or path signals an intranet URL.
  if (validLabels && (port !== null || (hasPath && input.charAt(hostPart.length) === '/'))) {
    return urlOrSearch(`http://${input}`, input)
  }

  return { type: 'search', query: input }
}

function splitHostPort(hostPart: string): { host: string | null; port: string | null } {
  if (hostPart.startsWith('[')) {
    const end = hostPart.indexOf(']')
    if (end === -1) return { host: null, port: null }
    const after = hostPart.slice(end + 1)
    if (after && !/^:\d{1,5}$/.test(after)) return { host: null, port: null }
    return { host: hostPart.slice(0, end + 1), port: after ? after.slice(1) : null }
  }
  const colon = hostPart.lastIndexOf(':')
  if (colon === -1) return { host: hostPart, port: null }
  const port = hostPart.slice(colon + 1)
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return { host: null, port: null }
  return { host: hostPart.slice(0, colon), port }
}

function toAsciiHost(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return null
  }
}

function tryUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) return null
    return url.href
  } catch {
    return null
  }
}

function urlOrSearch(candidate: string, input: string): Classification {
  const url = tryUrl(candidate)
  return url ? { type: 'url', url } : { type: 'search', query: input }
}
