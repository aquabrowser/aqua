/**
 * Query parameters that exist only to attribute a visit to an ad, campaign or
 * click. An explicit list: nothing else is ever touched, so OAuth (`code`,
 * `state`, `redirect_uri`), session and callback parameters are always kept.
 */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  // Google Analytics campaign tags
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  // Ad-click identifiers
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'twclid',
  'ttclid',
  'yclid',
  'igshid',
  // E-mail marketing
  'mc_eid',
  'mc_cid',
  '_hsenc',
  '_hsmi'
])

function paramName(pair: string): string {
  const raw = pair.split('=', 1)[0]
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase()
  } catch {
    return raw.toLowerCase()
  }
}

/**
 * `url` without tracking parameters, or null when it has none (or is not an
 * http(s) URL). Only the matching `name=value` pairs are cut out of the raw
 * query string; everything else stays byte-for-byte identical, so signed URLs
 * and servers that care about encoding keep working. The fragment is kept.
 */
export function stripTrackingParams(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null
  const hashAt = url.indexOf('#')
  const base = hashAt === -1 ? url : url.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : url.slice(hashAt)
  const queryAt = base.indexOf('?')
  if (queryAt === -1) return null
  const pairs = base.slice(queryAt + 1).split('&')
  const kept = pairs.filter((pair) => !TRACKING_PARAMS.has(paramName(pair)))
  if (kept.length === pairs.length) return null
  const query = kept.filter((pair) => pair !== '').join('&')
  return `${base.slice(0, queryAt)}${query ? `?${query}` : ''}${hash}`
}
