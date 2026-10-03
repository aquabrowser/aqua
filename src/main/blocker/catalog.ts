/**
 * The filter lists Aqua blocks with: uBlock Origin's own lists and the
 * third-party lists uBO enables by default, fetched from the same mirrors uBO
 * uses. They are grouped the way Settings presents them.
 *
 * Pure data: shared by the main process, the engine worker, the build script
 * (scripts/fetch-filters.mjs) and the tests.
 */

import type { FilterListGroup as ListGroup } from '../../shared/types'

export type { ListGroup }

export interface FilterList {
  id: string
  name: string
  group: ListGroup
  /** Tried in order; the first one that answers wins. */
  urls: string[]
}

const UASSETS = [
  'https://ublockorigin.github.io/uAssetsCDN',
  'https://ublockorigin.pages.dev',
  'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main'
]
const uassets = (path: string): string[] => UASSETS.map((base) => `${base}/${path}`)

export const FILTER_LISTS: readonly FilterList[] = [
  { id: 'ublock-filters', name: 'uBlock filters – Ads', group: 'ads', urls: uassets('filters/filters.min.txt') },
  {
    id: 'ublock-badware',
    name: 'uBlock filters – Badware risks',
    group: 'ads',
    urls: uassets('filters/badware.min.txt')
  },
  {
    id: 'ublock-quick-fixes',
    name: 'uBlock filters – Quick fixes',
    group: 'ads',
    urls: uassets('filters/quick-fixes.min.txt')
  },
  { id: 'ublock-unbreak', name: 'uBlock filters – Unbreak', group: 'ads', urls: uassets('filters/unbreak.min.txt') },
  { id: 'easylist', name: 'EasyList', group: 'ads', urls: uassets('thirdparties/easylist.txt') },
  {
    id: 'plowe-0',
    name: 'Peter Lowe’s Ad and tracking server list',
    group: 'ads',
    urls: ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext']
  },
  {
    id: 'urlhaus-1',
    name: 'Online Malicious URL Blocklist',
    group: 'ads',
    urls: [
      'https://curbengh.github.io/malware-filter/urlhaus-filter-ag-online.txt',
      'https://malware-filter.gitlab.io/urlhaus-filter/urlhaus-filter-ag-online.txt',
      'https://malware-filter.pages.dev/urlhaus-filter-ag-online.txt'
    ]
  },
  {
    id: 'ublock-privacy',
    name: 'uBlock filters – Privacy',
    group: 'privacy',
    urls: uassets('filters/privacy.min.txt')
  },
  { id: 'easyprivacy', name: 'EasyPrivacy', group: 'privacy', urls: uassets('thirdparties/easyprivacy.txt') },
  {
    id: 'ublock-cookies-easylist',
    name: 'uBlock filters – Cookie notices',
    group: 'cookies',
    urls: uassets('filters/annoyances-cookies.txt')
  },
  {
    id: 'fanboy-cookiemonster',
    name: 'EasyList – Cookie notices',
    group: 'cookies',
    urls: uassets('thirdparties/easylist-cookies.txt')
  },
  {
    id: 'ublock-annoyances',
    name: 'uBlock filters – Annoyances',
    group: 'annoyances',
    urls: uassets('filters/annoyances.min.txt')
  },
  {
    id: 'easylist-annoyances',
    name: 'EasyList – Annoyances',
    group: 'annoyances',
    urls: uassets('thirdparties/easylist-annoyances.txt')
  }
]

/**
 * uBlock Origin's scriptlets and redirect resources (`+js(…)`, `$redirect=`),
 * as converted for the engine by its maintainers.
 */
export const RESOURCES_URLS = [
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json',
  'https://cdn.jsdelivr.net/gh/ghostery/adblocker@master/packages/adblocker/assets/ublock-origin/resources.json'
]

export const DEFAULT_GROUPS: Readonly<Record<ListGroup, boolean>> = {
  ads: true,
  privacy: true,
  cookies: false,
  annoyances: false
}

export const LIST_GROUPS: readonly ListGroup[] = ['ads', 'privacy', 'cookies', 'annoyances']

export function listsFor(groups: Readonly<Record<ListGroup, boolean>>): FilterList[] {
  return FILTER_LISTS.filter((list) => groups[list.group])
}

/** A list download that is not a filter list (an error page, a captive portal) must not replace a good copy. */
export function looksLikeFilterList(text: string): boolean {
  if (text.length < 64) return false
  const head = text.slice(0, 2048).toLowerCase()
  if (head.includes('<html') || head.includes('<!doctype')) return false
  return true
}
