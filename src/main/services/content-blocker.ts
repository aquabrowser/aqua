import {
  app,
  type OnBeforeRequestListenerDetails,
  type OnHeadersReceivedListenerDetails,
  type Session,
  type WebContents
} from 'electron'
import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { ENGINE_VERSION, FiltersEngine, Request } from '@ghostery/adblocker'
import { parse } from 'tldts'
import type { ContentBlockerInfo } from '../../shared/types'
import { listsFor, looksLikeFilterList, type FilterList } from '../blocker/catalog'
import { blockerEnv, ENGINE_CONFIG } from '../blocker/engine'
import { siteFixScripts } from '../blocker/site-fixes'
import { Signal } from '../lib/signal'
import { mark } from '../lib/startup-trace'
import { RESOURCE_SCHEME } from '../protocols'
import type { BuildJob, BuildResult } from '../workers/filters'
import type { SettingsService } from './settings'

/** uBlock Origin's default: lists are refreshed every four days. */
const UPDATE_INTERVAL_MS = 4 * 24 * 60 * 60_000
const UPDATE_CHECK_MS = 60 * 60_000
/** The first check waits until start-up (and the unlock) is well over. */
const FIRST_CHECK_MS = 2 * 60_000
const DOWNLOAD_TIMEOUT_MS = 60_000
/** Limits on what a page's DOM report may contain (see `domUpdate`). */
const MAX_FEATURES = 2000
const MAX_FEATURE_LENGTH = 512

export interface Cosmetics {
  /** Element-hiding CSS for the frame (user origin). */
  styles: string
  /** Scriptlets to run in the page world before any page script. */
  scripts: string[]
  /** Whether the page should report new ids/classes/links as the DOM changes. */
  observe: boolean
}

export interface DomFeatures {
  ids: string[]
  classes: string[]
  hrefs: string[]
}

/** A compiled engine kept between runs, and what it was compiled from. */
interface EngineCacheInfo {
  key: string
  networkFilters: number
  cosmeticFilters: number
}

interface UpdateState {
  /** Last successful download of the lists (ms). */
  updatedAt: number | null
}

/**
 * Ad, tracker and malware blocking for every browsing session - regular and
 * private windows alike - with uBlock Origin's filter lists, compiled by the
 * Ghostery adblocker engine and applied from the main process:
 *
 *   network   `session.webRequest` cancels or redirects matching requests.
 *             Redirects lead to uBO's neutered resources (a no-op
 *             adsbygoogle.js, a blank pixel…) so pages that expect them keep
 *             working. They are served from `aqua-resource://<secret>/`:
 *             Chromium refuses to redirect subresources to data: URLs, and
 *             the per-run secret host keeps pages from probing for them;
 *   cosmetic  the tab preload asks for each frame's element-hiding CSS and
 *             scriptlets before any page script runs (see preload/tab.ts);
 *   CSP       `$csp=` filters add directives to documents' headers.
 *
 * uBlock Origin itself can't do this: it is an extension, and Electron loads
 * extensions only into persistent sessions, which keep cookies and site data
 * on disk - exactly what Aqua's in-memory browsing session avoids.
 *
 * The lists ship with Aqua (resources/filters) and are refreshed from uBO's
 * mirrors every four days; the refreshed copies and their date are kept in
 * `<userData>/filters`. They are public data - nothing about browsing is.
 *
 * The scriptlets and redirect resources (resources.json) are code that runs in
 * every page, so they only ever come with Aqua itself and are never downloaded:
 * lists name a scriptlet, they can't supply one.
 */
export class ContentBlockerService {
  readonly changed = new Signal<ContentBlockerInfo>()
  private engine: FiltersEngine | null = null
  private status: ContentBlockerInfo['status'] = 'loading'
  private counts = { filters: 0, lists: 0 }
  private building = false
  private rebuildQueued = false
  private updating = false
  private updateError: string | null = null
  private readonly ready: Promise<void>
  private markReady: () => void = () => undefined
  /** Sites paused in a private window stay paused only in that window. */
  private readonly privatePauses = new Map<string, Set<string>>()
  private onBlocked: (webContentsId: number) => void = () => undefined
  /** Redirect resources handed out in this run, by file name. */
  private readonly resources = new Map<string, { body: Buffer; contentType: string }>()
  private readonly resourceHost = randomBytes(16).toString('hex')
  private lastGroups: string
  private started = false

  constructor(
    private readonly settings: SettingsService,
    private readonly userData: string
  ) {
    this.ready = new Promise((resolve) => (this.markReady = resolve))
    this.lastGroups = JSON.stringify(settings.get().blockerLists)
  }

  /**
   * Loads the engine and keeps the lists up to date. Called once the first
   * window is on screen: nothing needs it before the vault is unlocked, and a
   * slow computer should spend its first second drawing the window.
   */
  start(): void {
    if (this.started) return
    this.started = true
    // Versions before 1.1.2 downloaded resources.json; that copy is never used again.
    try {
      rmSync(join(this.cacheDir, 'resources.json'), { force: true })
    } catch {
      // A read-only drive: the copy stays, unused.
    }
    this.settings.changed.on((s) => {
      const groups = JSON.stringify(s.blockerLists)
      if (groups !== this.lastGroups) {
        this.lastGroups = groups
        void this.rebuild()
      }
      this.changed.emit(this.info())
    })
    void this.rebuild()
    setTimeout(() => {
      void this.updateIfDue()
      setInterval(() => void this.updateIfDue(), UPDATE_CHECK_MS).unref()
    }, FIRST_CHECK_MS).unref()
  }

  /** Resolves once the first engine is in place (or could not be built), or after `timeoutMs`. */
  whenReady(timeoutMs: number): Promise<void> {
    return Promise.race([this.ready, new Promise<void>((r) => setTimeout(r, timeoutMs))])
  }

  setBlockedListener(listener: (webContentsId: number) => void): void {
    this.onBlocked = listener
  }

  info(): ContentBlockerInfo {
    return {
      enabled: this.settings.get().contentBlocking,
      status: this.status,
      filterCount: this.counts.filters,
      listCount: this.counts.lists,
      updatedAt: this.readState().updatedAt ?? this.bundledDate(),
      updating: this.updating,
      updateError: this.updateError
    }
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  /** `partition`: a private window's, or null for the regular session. */
  attach(session: Session, partition: string | null): void {
    session.protocol.handle(RESOURCE_SCHEME, (request) => this.serveResource(request.url))
    session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, done) =>
      done(this.onBeforeRequest(d, partition))
    )
    session.webRequest.onHeadersReceived(
      { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] },
      (d, done) => done(this.onHeadersReceived(d, partition))
    )
  }

  forgetPartition(partition: string): void {
    this.privatePauses.delete(partition)
  }

  // ─── Per-site pause ────────────────────────────────────────────────────────

  isPaused(pageUrl: string, partition: string | null): boolean {
    const host = hostOf(pageUrl)
    if (!host) return false
    if (this.settings.get().blockerPausedSites.includes(host)) return true
    return partition !== null && (this.privatePauses.get(partition)?.has(host) ?? false)
  }

  /** Pauses or resumes blocking on the site of `pageUrl`; returns the host it applies to. */
  setPaused(pageUrl: string, paused: boolean, partition: string | null): string | null {
    const host = hostOf(pageUrl)
    if (!host) return null
    if (partition !== null) {
      const hosts = this.privatePauses.get(partition) ?? new Set<string>()
      if (paused) hosts.add(host)
      else hosts.delete(host)
      this.privatePauses.set(partition, hosts)
      // A site paused in the regular profile is resumed only from there.
      return host
    }
    const current = this.settings.get().blockerPausedSites.filter((h) => h !== host)
    this.settings.update({ blockerPausedSites: paused ? [...current, host].slice(-500) : current })
    return host
  }

  // ─── Network ───────────────────────────────────────────────────────────────

  private onBeforeRequest(
    details: OnBeforeRequestListenerDetails,
    partition: string | null
  ): { cancel?: boolean; redirectURL?: string } {
    const engine = this.engine
    // Documents are never blocked outright: a click on a link must lead somewhere.
    if (!engine || details.resourceType === 'mainFrame' || !this.settings.get().contentBlocking) return {}
    const top = topUrl(details)
    if (top && this.isPaused(top, partition)) return {}
    const request = Request.fromRawDetails({
      requestId: String(details.id),
      url: details.url,
      sourceUrl: sourceUrl(details, top),
      type: details.resourceType,
      tabId: details.webContentsId
    })
    const { match, redirect } = engine.match(request)
    if (!match && !redirect) return {}
    if (details.webContentsId !== undefined) this.onBlocked(details.webContentsId)
    if (!redirect) return { cancel: true }
    const location = this.resourceUrl(redirect.filename, redirect.dataUrl)
    return location ? { redirectURL: location } : { cancel: true }
  }

  /** Where a redirect resource is served, registering it on first use; null if it can't be decoded. */
  private resourceUrl(filename: string, dataUrl: string): string | null {
    if (!this.resources.has(filename)) {
      const decoded = decodeDataUrl(dataUrl)
      if (!decoded) return null
      this.resources.set(filename, decoded)
    }
    return `${RESOURCE_SCHEME}://${this.resourceHost}/${encodeURIComponent(filename)}`
  }

  private serveResource(url: string): Response {
    const parsed = new URL(url)
    const resource =
      parsed.hostname === this.resourceHost ? this.resources.get(decodeURIComponent(parsed.pathname.slice(1))) : null
    if (!resource) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(resource.body), {
      headers: {
        'content-type': resource.contentType,
        'access-control-allow-origin': '*',
        'cache-control': 'no-store'
      }
    })
  }

  private onHeadersReceived(
    details: OnHeadersReceivedListenerDetails,
    partition: string | null
  ): { responseHeaders?: Record<string, string[]> } {
    const engine = this.engine
    if (!engine || !this.settings.get().contentBlocking) return {}
    const top = details.resourceType === 'mainFrame' ? details.url : topUrl(details)
    if (top && this.isPaused(top, partition)) return {}
    const directives = engine.getCSPDirectives(
      Request.fromRawDetails({ url: details.url, sourceUrl: sourceUrl(details, top), type: details.resourceType })
    )
    if (!directives) return {}
    // Added as a separate header: browsers enforce every CSP header, so the page's own policy stays intact.
    const headers = { ...(details.responseHeaders ?? {}) }
    const existing = Object.keys(headers).find((name) => name.toLowerCase() === 'content-security-policy')
    const name = existing ?? 'Content-Security-Policy'
    headers[name] = [...(headers[name] ?? []), directives]
    return { responseHeaders: headers }
  }

  // ─── Cosmetic filtering (asked for by the tab preload) ─────────────────────

  /** Element hiding and scriptlets for a frame that is starting; null where nothing applies. */
  pageStart(frameUrl: string, pageUrl: string, partition: string | null): Cosmetics | null {
    const engine = this.engine
    if (!engine || !this.settings.get().contentBlocking || this.isPaused(pageUrl, partition)) return null
    const target = cosmeticTarget(frameUrl)
    if (!target) return null
    const { active, styles, scripts } = engine.getCosmeticsFilters({
      ...target,
      getBaseRules: true,
      getInjectionRules: true,
      getExtendedRules: false,
      getRulesFromHostname: true,
      getRulesFromDOM: false
    })
    if (active === false) return null
    // Even with nothing specific to this site, generic rules still apply to what the DOM contains.
    return {
      styles,
      scripts: [...scripts, ...siteFixScripts(target.hostname)],
      observe: engine.config.enableMutationObserver
    }
  }

  /** Generic element-hiding rules for ids, classes and links that just appeared in a frame. */
  domUpdate(frameUrl: string, pageUrl: string, partition: string | null, raw: unknown): string | null {
    const engine = this.engine
    if (!engine || !this.settings.get().contentBlocking || this.isPaused(pageUrl, partition)) return null
    const target = cosmeticTarget(frameUrl)
    const features = sanitizeFeatures(raw)
    if (!target || !features) return null
    const { active, styles } = engine.getCosmeticsFilters({
      ...target,
      ...features,
      getBaseRules: false,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromHostname: false,
      getRulesFromDOM: true
    })
    return active === false || !styles ? null : styles
  }

  // ─── Lists ─────────────────────────────────────────────────────────────────

  /** Downloads fresh copies of the lists in use now, whatever their age (Settings → "Update now"). */
  async updateNow(): Promise<void> {
    await this.update()
  }

  private async updateIfDue(): Promise<void> {
    const { updatedAt } = this.readState()
    const last = updatedAt ?? this.bundledDate() ?? 0
    if (Date.now() - last >= UPDATE_INTERVAL_MS) await this.update()
  }

  private async update(): Promise<void> {
    if (this.updating) return
    this.updating = true
    this.changed.emit(this.info())
    const lists = listsFor(this.settings.get().blockerLists)
    let downloaded = 0
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      for (const list of lists) {
        const text = await download(list.urls, looksLikeFilterList)
        if (text === null) continue
        writeAtomically(join(this.cacheDir, `${list.id}.txt`), text)
        downloaded++
      }
      if (downloaded > 0) this.writeState({ updatedAt: Date.now() })
      this.updateError =
        downloaded === lists.length
          ? null
          : downloaded === 0
            ? 'Couldn’t reach the filter list servers.'
            : `${lists.length - downloaded} of ${lists.length} lists couldn’t be downloaded.`
    } catch (err) {
      // A read-only drive (portable build) keeps blocking with the bundled lists.
      this.updateError = 'Couldn’t save the updated lists.'
      console.error('[blocker] update failed:', err)
    } finally {
      this.updating = false
    }
    if (downloaded > 0) await this.rebuild()
    else this.changed.emit(this.info())
  }

  /** Compiles the lists in use (the freshest copy of each) in a worker, then swaps the engine in. */
  private async rebuild(): Promise<void> {
    if (this.building) {
      this.rebuildQueued = true
      return
    }
    this.building = true
    try {
      do {
        this.rebuildQueued = false
        const lists = listsFor(this.settings.get().blockerLists)
        const files = lists.map((list) => this.listFile(list)).filter((file) => file !== null)
        const bundledResources = join(this.bundledDir, 'resources.json')
        const resources = existsSync(bundledResources) ? bundledResources : null
        if (files.length === 0) {
          this.engine = null
          this.status = lists.length === 0 ? 'ready' : 'error'
          this.counts = { filters: 0, lists: 0 }
          continue
        }
        const started = Date.now()
        const key = cacheKey([...files, resources])
        // The same lists as last time: load the engine compiled then (milliseconds instead of a second of CPU).
        const cached = await this.readCache(key)
        let compiled: { bytes: Uint8Array; networkFilters: number; cosmeticFilters: number }
        if (cached) {
          compiled = cached
        } else {
          const result = await build({ lists: files, resources })
          if (!result.ok) {
            console.error('[blocker] could not compile the filter lists:', result.error)
            if (!this.engine) this.status = 'error'
            continue
          }
          compiled = {
            bytes: result.engine,
            networkFilters: result.networkFilters,
            cosmeticFilters: result.cosmeticFilters
          }
          this.writeCache(
            { key, networkFilters: result.networkFilters, cosmeticFilters: result.cosmeticFilters },
            result.engine
          )
        }
        const engine = FiltersEngine.deserialize(compiled.bytes)
        engine.updateEnv(blockerEnv() as Parameters<FiltersEngine['updateEnv']>[0])
        this.engine = engine
        this.status = 'ready'
        this.counts = { filters: compiled.networkFilters + compiled.cosmeticFilters, lists: files.length }
        mark('filter engine ready')
        console.info(
          `[blocker] ${this.counts.filters} filters from ${files.length} lists in ${Date.now() - started} ms` +
            (cached ? ' (compiled earlier)' : '')
        )
      } while (this.rebuildQueued)
    } finally {
      this.building = false
      this.markReady()
      this.changed.emit(this.info())
    }
  }

  private async readCache(key: string): Promise<(EngineCacheInfo & { bytes: Uint8Array }) | null> {
    try {
      const info = JSON.parse(readFileSync(join(this.cacheDir, 'engine.json'), 'utf-8')) as EngineCacheInfo
      if (info.key !== key) return null
      return { ...info, bytes: await readFile(join(this.cacheDir, 'engine.bin')) }
    } catch {
      return null
    }
  }

  private writeCache(info: EngineCacheInfo, bytes: Uint8Array): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      writeAtomically(join(this.cacheDir, 'engine.bin'), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      writeAtomically(join(this.cacheDir, 'engine.json'), JSON.stringify(info))
    } catch (err) {
      // A read-only drive just compiles every time.
      console.warn('[blocker] could not keep the compiled engine:', (err as Error).message)
    }
  }

  private get bundledDir(): string {
    return app.isPackaged ? join(process.resourcesPath, 'filters') : join(app.getAppPath(), 'resources', 'filters')
  }

  private get cacheDir(): string {
    return join(this.userData, 'filters')
  }

  private listFile(list: FilterList): string | null {
    return this.freshest(`${list.id}.txt`)
  }

  /** The downloaded copy of a file if there is one, else the bundled one. */
  private freshest(name: string): string | null {
    for (const dir of [this.cacheDir, this.bundledDir]) {
      const file = join(dir, name)
      if (existsSync(file)) return file
    }
    return null
  }

  private bundledDate(): number | null {
    try {
      const manifest = JSON.parse(readFileSync(join(this.bundledDir, 'manifest.json'), 'utf-8')) as {
        fetchedAt?: string
      }
      const date = manifest.fetchedAt ? Date.parse(manifest.fetchedAt) : NaN
      return Number.isFinite(date) ? date : null
    } catch {
      return null
    }
  }

  private readState(): UpdateState {
    try {
      const raw = JSON.parse(readFileSync(join(this.cacheDir, 'state.json'), 'utf-8')) as Partial<UpdateState>
      return { updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null }
    } catch {
      return { updatedAt: null }
    }
  }

  private writeState(state: UpdateState): void {
    writeAtomically(join(this.cacheDir, 'state.json'), JSON.stringify(state))
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function build(job: BuildJob): Promise<BuildResult> {
  return new Promise((resolve) => {
    const worker = new Worker(join(__dirname, 'filters.js'))
    const finish = (result: BuildResult): void => {
      void worker.terminate()
      resolve(result)
    }
    worker.once('message', (result: BuildResult) => finish(result))
    worker.once('error', (err) => finish({ ok: false, error: err.message }))
    worker.postMessage(job)
  })
}

/** First mirror that answers with plausible content; null if none does. */
async function download(urls: readonly string[], check: (text: string) => boolean): Promise<string | null> {
  for (const url of urls) {
    try {
      // Node's own fetch: nothing goes through (or is cached by) a browsing session.
      const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
      if (!response.ok) continue
      const text = await response.text()
      if (check(text)) return text
    } catch {
      // Next mirror.
    }
  }
  return null
}

/** `data:<type>[;base64],<payload>` → bytes and content type. */
function decodeDataUrl(url: string): { body: Buffer; contentType: string } | null {
  const match = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url)
  if (!match) return null
  const contentType = match[1] || 'text/plain'
  try {
    const body = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf-8')
    return { body, contentType }
  } catch {
    return null
  }
}

/**
 * What a compiled engine depends on: the engine's own version and settings,
 * and each input file (by path, size and modification time).
 */
function cacheKey(files: Array<string | null>): string {
  const hash = createHash('sha256').update(`${ENGINE_VERSION}\n${JSON.stringify(ENGINE_CONFIG)}\n`)
  for (const file of files) {
    if (!file) continue
    try {
      const info = statSync(file)
      hash.update(`${file}\n${info.size}\n${info.mtimeMs}\n`)
    } catch {
      hash.update(`${file}\nmissing\n`)
    }
  }
  return hash.digest('hex')
}

function writeAtomically(file: string, content: string | Buffer): void {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, file)
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/** The address of the tab's page (what "pause on this site" applies to). */
function topUrl(details: { webContents?: WebContents }): string | null {
  const contents = details.webContents
  if (!contents || contents.isDestroyed()) return null
  return contents.getURL() || null
}

/** The document a request comes from, for `$third-party` and `$domain=` matching. */
function sourceUrl(details: { initiatorOrigin?: string; referrer: string }, top: string | null): string | undefined {
  const initiator = details.initiatorOrigin
  if (initiator && initiator !== 'null') return initiator
  return top ?? (details.referrer || undefined)
}

function cosmeticTarget(frameUrl: string): { url: string; hostname: string; domain: string } | null {
  if (!/^https?:/i.test(frameUrl)) return null
  const parsed = parse(frameUrl)
  if (!parsed.hostname) return null
  return { url: frameUrl, hostname: parsed.hostname, domain: parsed.domain ?? parsed.hostname }
}

function sanitizeFeatures(raw: unknown): DomFeatures | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const list = (v: unknown): string[] | null =>
    Array.isArray(v) && v.length <= MAX_FEATURES
      ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_FEATURE_LENGTH)
      : null
  const ids = list(r.ids)
  const classes = list(r.classes)
  const hrefs = list(r.hrefs)
  return ids && classes && hrefs ? { ids, classes, hrefs } : null
}
