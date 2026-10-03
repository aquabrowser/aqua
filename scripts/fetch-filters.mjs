/**
 * Downloads the filter lists and uBlock Origin's scriptlet resources into
 * resources/filters/, so that a fresh install blocks from its first page,
 * before (and without) any network update.
 *
 *   npm run fetch:filters
 *
 * The lists keep their own licences (uBlock filters: GPL-3.0; EasyList and
 * EasyPrivacy: GPL-3.0 / CC BY-SA 3.0; see each file's header).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FILTER_LISTS, RESOURCES_URLS, looksLikeFilterList } from '../src/main/blocker/catalog.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'resources', 'filters')

async function download(urls, check) {
  let lastError = null
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (!check(text)) throw new Error('unexpected content')
      return text
    } catch (err) {
      lastError = new Error(`${url}: ${err.message}`)
    }
  }
  throw lastError
}

async function main() {
  mkdirSync(target, { recursive: true })
  const manifest = { fetchedAt: new Date().toISOString(), lists: {} }
  for (const list of FILTER_LISTS) {
    const text = await download(list.urls, looksLikeFilterList)
    writeFileSync(join(target, `${list.id}.txt`), text)
    manifest.lists[list.id] = { bytes: text.length, sha256: createHash('sha256').update(text).digest('hex') }
    console.log(`${list.id.padEnd(24)} ${(text.length / 1024).toFixed(0).padStart(6)} KiB`)
  }
  const resources = await download(RESOURCES_URLS, (text) => {
    try {
      return typeof JSON.parse(text) === 'object'
    } catch {
      return false
    }
  })
  writeFileSync(join(target, 'resources.json'), resources)
  manifest.resources = { bytes: resources.length, sha256: createHash('sha256').update(resources).digest('hex') }
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`resources.json ${(resources.length / 1024).toFixed(0)} KiB → ${target}`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
