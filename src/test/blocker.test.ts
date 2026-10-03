import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { FiltersEngine, Request } from '@ghostery/adblocker'
import { DEFAULT_GROUPS, FILTER_LISTS, listsFor, looksLikeFilterList } from '../main/blocker/catalog.ts'
import { blockerEnv, ENGINE_CONFIG } from '../main/blocker/engine.ts'

const BUNDLED = join(import.meta.dirname, '..', '..', 'resources', 'filters')
type Env = Parameters<FiltersEngine['updateEnv']>[0]

test('the catalog is well formed', () => {
  const ids = FILTER_LISTS.map((l) => l.id)
  assert.equal(new Set(ids).size, ids.length, 'unique ids')
  for (const list of FILTER_LISTS) {
    assert.ok(list.urls.length > 0, list.id)
    for (const url of list.urls) assert.match(url, /^https:\/\//, `${list.id} downloads over https`)
  }
  // uBlock Origin's defaults: its own lists, EasyList, EasyPrivacy, Peter Lowe's, the malware list.
  assert.deepEqual(
    listsFor(DEFAULT_GROUPS).map((l) => l.id),
    [
      'ublock-filters',
      'ublock-badware',
      'ublock-quick-fixes',
      'ublock-unbreak',
      'easylist',
      'plowe-0',
      'urlhaus-1',
      'ublock-privacy',
      'easyprivacy'
    ]
  )
})

test('an error page is not taken for a filter list', () => {
  assert.equal(looksLikeFilterList('<!DOCTYPE html><html><body>Rate limited</body></html>'.padEnd(200)), false)
  assert.equal(looksLikeFilterList(''), false)
  assert.equal(looksLikeFilterList('[Adblock Plus 2.0]\n! Title: EasyList\n||ads.example^\n'.repeat(3)), true)
})

test('every list and the scriptlet resources ship with Aqua', () => {
  for (const list of FILTER_LISTS) assert.ok(existsSync(join(BUNDLED, `${list.id}.txt`)), list.id)
  assert.ok(existsSync(join(BUNDLED, 'resources.json')))
})

let engine: FiltersEngine
before(() => {
  const text = listsFor(DEFAULT_GROUPS)
    .map((l) => readFileSync(join(BUNDLED, `${l.id}.txt`), 'utf-8'))
    .join('\n')
  const built = FiltersEngine.parse(text, ENGINE_CONFIG)
  built.updateResources(readFileSync(join(BUNDLED, 'resources.json'), 'utf-8'), 'test')
  // As the browser does it: serialized in the worker, deserialized in the main process.
  engine = FiltersEngine.deserialize(built.serialize())
  engine.updateEnv(blockerEnv() as Env)
})

const request = (url: string, sourceUrl: string, type: string) =>
  Request.fromRawDetails({ url, sourceUrl, type: type as 'script' })

test('ad and tracker requests are blocked; a site’s own resources are not', () => {
  const blocked = [
    'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
    'https://www.google-analytics.com/analytics.js',
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://ads.pubmatic.com/AdServer/js/pwt.js'
  ]
  for (const url of blocked) {
    const result = engine.match(request(url, 'https://news.example/', 'script'))
    assert.ok(result.match || result.redirect, url)
  }
  for (const url of ['https://news.example/app.js', 'https://cdn.jsdelivr.net/npm/react@18/umd/react.min.js']) {
    const result = engine.match(request(url, 'https://news.example/', 'script'))
    assert.ok(!result.match && !result.redirect, url)
  }
})

test('scripts pages depend on are neutered rather than cut off', () => {
  const result = engine.match(
    request('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'https://blog.example/', 'script')
  )
  assert.ok(result.redirect, 'redirected to a no-op')
  assert.match(result.redirect.dataUrl, /^data:application\/javascript/)
})

test('cosmetic filtering: site rules, scriptlets and generic rules for what is in the DOM', () => {
  const youtube = engine.getCosmeticsFilters({
    url: 'https://www.youtube.com/watch?v=1',
    hostname: 'www.youtube.com',
    domain: 'youtube.com',
    getBaseRules: true,
    getInjectionRules: true,
    getExtendedRules: false,
    getRulesFromHostname: true,
    getRulesFromDOM: false
  })
  assert.ok(youtube.scripts.length > 0, 'uBO scriptlets for YouTube')

  const generic = engine.getCosmeticsFilters({
    url: 'https://blog.example/',
    hostname: 'blog.example',
    domain: 'blog.example',
    classes: ['adsbygoogle-box'],
    ids: [],
    hrefs: [],
    getBaseRules: false,
    getInjectionRules: false,
    getExtendedRules: false,
    getRulesFromHostname: false,
    getRulesFromDOM: true
  })
  assert.match(generic.styles, /adsbygoogle-box/)
  assert.match(generic.styles, /display: none !important/)
})
