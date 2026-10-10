import { app, shell, type DownloadItem, type Session, type WebContents } from 'electron'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import type { DownloadAction, DownloadEntry, DownloadStatus } from '../../shared/types'
import { opensElsewhere, safeFileName, ZONE_IDENTIFIER } from '../lib/download-safety'
import type { EncryptedDocument, VaultDatabase } from '../storage/database'
import { Signal, uid } from '../lib/signal'
import type { SettingsService } from './settings'

interface DownloadsFile {
  version: 1
  entries: DownloadEntry[]
}

interface LiveDownload {
  item: DownloadItem
  partition: string | null
  /** Where the file goes once complete, for a download that was held in staging (see `hold`). */
  finalPath: string | null
  lastBytes: number
  lastSample: number
  lastEmit: number
  emitTimer: NodeJS.Timeout | null
}

const MAX_ENTRIES = 200
const EMIT_INTERVAL_MS = 250
const SPEED_SAMPLE_MS = 500
const STATUSES: readonly DownloadStatus[] = ['progressing', 'paused', 'completed', 'cancelled', 'interrupted']

function sanitize(raw: unknown): DownloadsFile {
  const list = Array.isArray((raw as { entries?: unknown })?.entries) ? (raw as { entries: unknown[] }).entries : []
  const entries: DownloadEntry[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const d = item as Record<string, unknown>
    if (typeof d.id !== 'string' || typeof d.url !== 'string' || typeof d.savePath !== 'string') continue
    let status = STATUSES.includes(d.status as DownloadStatus) ? (d.status as DownloadStatus) : 'interrupted'
    // Anything still "live" in the file died with the previous process.
    if (status === 'progressing' || status === 'paused') status = 'interrupted'
    entries.push({
      id: d.id,
      url: d.url,
      filename: typeof d.filename === 'string' ? d.filename : basename(d.savePath),
      savePath: d.savePath,
      mimeType: typeof d.mimeType === 'string' ? d.mimeType : '',
      totalBytes: typeof d.totalBytes === 'number' ? d.totalBytes : 0,
      receivedBytes: typeof d.receivedBytes === 'number' ? d.receivedBytes : 0,
      status,
      speed: 0,
      startedAt: typeof d.startedAt === 'number' ? d.startedAt : Date.now(),
      endedAt: typeof d.endedAt === 'number' ? d.endedAt : null,
      canResume: false,
      fileMissing: status === 'completed' && !existsSync(d.savePath)
    })
  }
  return { version: 1, entries: entries.slice(0, MAX_ENTRIES) }
}

/**
 * Decides whether a download started by `source` may proceed: now (true /
 * false) or once the user has answered (the download waits, paused).
 */
export type DownloadGateHandler = (source: WebContents | null, filename: string) => boolean | Promise<boolean>

/**
 * Downloads, persisted in the vault. Downloads made in a private window are
 * listed only in that window, kept in memory, and forgotten when it closes
 * (the files themselves stay where they were saved). `partition` identifies
 * the private window; null means the regular profile.
 */
export class DownloadsService {
  readonly changed = new Signal<{ entry: DownloadEntry; partition: string | null }>()
  readonly reset = new Signal<{ entries: DownloadEntry[]; partition: string | null }>()
  readonly started = new Signal<{ entry: DownloadEntry; source: WebContents | null }>()
  /** Aggregate progress for taskbar badges: 0..1, or -1 when nothing is transferring. */
  readonly progress = new Signal<{ value: number; paused: boolean }>()
  /**
   * Emits a webContents id once it has no transfers left. Electron interrupts a
   * download when its initiating webContents is destroyed, so tabs that are
   * closed mid-download are kept alive (hidden) until this fires.
   */
  readonly sourceIdle = new Signal<number>()
  private readonly bySource = new Map<number, Set<string>>()

  private readonly store: EncryptedDocument<DownloadsFile>
  private readonly live = new Map<string, LiveDownload>()
  private readonly pendingRetries = new Map<string, string>()
  /** Session each partition downloads through (null key: the regular profile). */
  private readonly sessions = new Map<string | null, Session>()
  /** Private windows' downloads, newest first - never written to the vault. */
  private readonly ephemeral = new Map<string, DownloadEntry[]>()
  private gate: DownloadGateHandler = () => true
  /** Final paths promised to held downloads that are still transferring: reserved for them. */
  private readonly heldPaths = new Set<string>()
  /** Where downloads wait for consent: inside the profile, never in the Downloads folder. */
  private readonly stagingDir = join(app.getPath('userData'), 'held-downloads')

  constructor(
    db: VaultDatabase,
    private readonly settings: SettingsService
  ) {
    this.store = db.document('downloads', {
      defaults: () => ({ version: 1, entries: [] }),
      sanitize,
      debounceMs: 1000
    })
    this.store.loaded.on(() => this.emitReset(null))
    // Anything still staged is from a previous run: it was never allowed.
    rmSync(this.stagingDir, { recursive: true, force: true })
  }

  /** Imports the download list from a pre-vault JSON file. */
  importLegacy(raw: unknown): void {
    this.store.set(sanitize(raw))
    this.emitReset(null)
  }

  /** `partition`: the private window this session belongs to, or null for the regular profile. */
  attach(session: Session, partition: string | null = null): void {
    this.sessions.set(partition, session)
    if (partition !== null) this.ephemeral.set(partition, [])
    session.on('will-download', (event, item, source) => {
      // Aqua's own retries were allowed when they were first made.
      const verdict = this.pendingRetries.has(item.getURL()) ? true : this.gate(source ?? null, item.getFilename())
      if (verdict === false) {
        event.preventDefault()
        return
      }
      if (verdict === true) {
        this.onWillDownload(item, source, partition)
        return
      }
      this.hold(item, source, partition, verdict)
    })
  }

  setGate(gate: DownloadGateHandler): void {
    this.gate = gate
  }

  /**
   * A download waiting for the user's consent. Chromium keeps writing a
   * download whose data has already arrived, even when paused, so it goes to
   * a private staging folder in the profile rather than to Downloads (and never
   * through a save dialog - a page must not be able to open dialogs by the
   * dozen). Allowed: it moves to Downloads, now or when it finishes. Refused:
   * the staged copy is deleted.
   */
  private hold(item: DownloadItem, source: WebContents, partition: string | null, answer: Promise<boolean>): void {
    mkdirSync(this.stagingDir, { recursive: true })
    const staging = mkdtempSync(join(this.stagingDir, 'd-'))
    const name = this.safeName(item.getFilename())
    item.setSavePath(join(staging, name))
    item.pause()
    let finished: 'completed' | 'cancelled' | 'interrupted' | null = null
    item.once('done', (_e, state) => {
      finished = state
    })
    const discard = (): void => {
      if (!finished) item.cancel()
      // Chromium may still hold the file for a moment after cancelling.
      setTimeout(() => rmSync(staging, { recursive: true, force: true, maxRetries: 5 }), 500)
    }
    void answer.then(
      (allowed) => {
        if (!allowed || (finished !== null && finished !== 'completed')) return discard()
        const finalPath = this.uniquePath(app.getPath('downloads'), name)
        if (finished === 'completed') {
          const moved = moveFile(item.getSavePath(), finalPath)
          if (moved) markOfTheWeb(finalPath, item.getURL())
          this.recordFinished(item, partition, finalPath, moved)
          rmSync(staging, { recursive: true, force: true })
          return
        }
        this.heldPaths.add(finalPath)
        this.onWillDownload(item, source, partition, { finalPath })
        item.resume()
      },
      () => discard()
    )
  }

  /** A held download that completed while the user was deciding, now allowed: listed as done. */
  private recordFinished(item: DownloadItem, partition: string | null, finalPath: string, moved: boolean): void {
    const now = Date.now()
    const entry: DownloadEntry = {
      id: uid('d'),
      url: item.getURL(),
      filename: basename(finalPath),
      savePath: finalPath,
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes() || item.getReceivedBytes(),
      receivedBytes: item.getReceivedBytes(),
      status: moved ? 'completed' : 'interrupted',
      speed: 0,
      startedAt: now,
      endedAt: now,
      canResume: false,
      fileMissing: !moved
    }
    this.replace(partition, (entries) => [entry, ...entries].slice(0, MAX_ENTRIES))
    this.changed.emit({ entry: { ...entry }, partition })
  }

  /** A private window closed: cancel its transfers and forget its list. */
  discard(partition: string): void {
    for (const entry of this.ephemeral.get(partition) ?? []) this.live.get(entry.id)?.item.cancel()
    this.ephemeral.delete(partition)
    this.sessions.delete(partition)
    this.emitProgress()
  }

  list(partition: string | null = null): DownloadEntry[] {
    return this.entries(partition).map((e) => ({ ...e }))
  }

  hasActive(): boolean {
    return this.live.size > 0
  }

  activeForSource(webContentsId: number): number {
    return this.bySource.get(webContentsId)?.size ?? 0
  }

  /** Acts on a download of `partition` only: one window cannot touch another's list. */
  async action(id: string, action: DownloadAction, partition: string | null = null): Promise<void> {
    const entry = this.entries(partition).find((e) => e.id === id)
    if (!entry) return
    const live = this.live.get(id)
    switch (action) {
      case 'pause':
        if (live && !live.item.isPaused()) {
          live.item.pause()
          this.patch(entry, { status: 'paused', speed: 0 }, true)
        }
        break
      case 'resume':
        if (live && live.item.canResume()) {
          live.item.resume()
          live.lastSample = Date.now()
          live.lastBytes = live.item.getReceivedBytes()
          this.patch(entry, { status: 'progressing' }, true)
        } else {
          this.retry(entry, partition)
        }
        break
      case 'cancel':
        live?.item.cancel()
        break
      case 'retry':
        if (!live) this.retry(entry, partition)
        break
      case 'open': {
        if (entry.status !== 'completed') return
        if (opensElsewhere(entry.savePath)) {
          if (existsSync(entry.savePath)) shell.showItemInFolder(entry.savePath)
          else this.patch(entry, { fileMissing: true }, true)
          return
        }
        const error = await shell.openPath(entry.savePath)
        if (error) this.patch(entry, { fileMissing: !existsSync(entry.savePath) }, true)
        break
      }
      case 'show':
        if (existsSync(entry.savePath)) shell.showItemInFolder(entry.savePath)
        else void shell.openPath(app.getPath('downloads'))
        break
      case 'remove':
        live?.item.cancel()
        this.replace(partition, (entries) => entries.filter((e) => e.id !== id))
        this.emitReset(partition)
        break
    }
  }

  /** Removes every finished entry; transfers in flight stay listed. */
  clearFinished(partition: string | null = null): void {
    this.replace(partition, (entries) => entries.filter((e) => this.live.has(e.id)))
    this.emitReset(partition)
  }

  flushSync(): void {
    this.store.flushSync()
  }

  private entries(partition: string | null): DownloadEntry[] {
    return partition === null ? this.store.value.entries : (this.ephemeral.get(partition) ?? [])
  }

  private replace(partition: string | null, change: (entries: DownloadEntry[]) => DownloadEntry[]): void {
    if (partition === null) this.store.update((file) => ({ ...file, entries: change(file.entries) }))
    else if (this.ephemeral.has(partition)) this.ephemeral.set(partition, change(this.ephemeral.get(partition)!))
  }

  private emitReset(partition: string | null): void {
    this.reset.emit({ entries: this.list(partition), partition })
  }

  private onWillDownload(
    item: DownloadItem,
    source: WebContents,
    partition: string | null,
    options: { finalPath?: string } = {}
  ): void {
    const url = item.getURL()
    const retryOf = this.pendingRetries.get(url)
    if (retryOf) this.pendingRetries.delete(url)

    const dir = app.getPath('downloads')
    if (options.finalPath) {
      // Allowed after being held: it keeps downloading into staging and moves when complete.
    } else if (this.settings.get().askWhereToSave) {
      item.setSaveDialogOptions({ defaultPath: join(dir, item.getFilename()) })
    } else {
      item.setSavePath(this.uniquePath(dir, item.getFilename()))
    }

    const now = Date.now()
    const entry: DownloadEntry = {
      id: retryOf ?? uid('d'),
      url,
      filename: options.finalPath
        ? basename(options.finalPath)
        : item.getSavePath()
          ? basename(item.getSavePath())
          : item.getFilename(),
      savePath: options.finalPath ?? item.getSavePath(),
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      status: 'progressing',
      speed: 0,
      startedAt: now,
      endedAt: null,
      canResume: false,
      fileMissing: false
    }

    this.replace(partition, (entries) => [entry, ...entries.filter((e) => e.id !== entry.id)].slice(0, MAX_ENTRIES))
    const live: LiveDownload = {
      item,
      partition,
      finalPath: options.finalPath ?? null,
      lastBytes: 0,
      lastSample: now,
      lastEmit: 0,
      emitTimer: null
    }
    this.live.set(entry.id, live)
    const sourceId = source && !source.isDestroyed() ? source.id : null
    if (sourceId !== null) {
      const set = this.bySource.get(sourceId) ?? new Set<string>()
      set.add(entry.id)
      this.bySource.set(sourceId, set)
    }

    item.on('updated', (_e, state) => {
      const current = this.find(entry.id, partition)
      if (!current) return
      const received = item.getReceivedBytes()
      const t = Date.now()
      let speed = current.speed
      if (item.isPaused() || state === 'interrupted') {
        speed = 0
      } else if (t - live.lastSample >= SPEED_SAMPLE_MS) {
        const instant = ((received - live.lastBytes) * 1000) / (t - live.lastSample)
        speed = speed > 0 ? speed * 0.7 + instant * 0.3 : instant
        live.lastSample = t
        live.lastBytes = received
      }
      const status: DownloadStatus =
        state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'
      const savePath = live.finalPath ?? item.getSavePath()
      this.patch(
        current,
        {
          receivedBytes: received,
          totalBytes: item.getTotalBytes(),
          savePath,
          filename: savePath ? basename(savePath) : current.filename,
          status,
          speed,
          canResume: item.canResume()
        },
        status !== current.status
      )
    })

    item.once('done', (_e, state) => {
      const current = this.find(entry.id, partition)
      if (live.emitTimer) clearTimeout(live.emitTimer)
      this.live.delete(entry.id)
      if (sourceId !== null) {
        const set = this.bySource.get(sourceId)
        set?.delete(entry.id)
        if (set && set.size === 0) {
          this.bySource.delete(sourceId)
          this.sourceIdle.emit(sourceId)
        }
      }
      let savePath = item.getSavePath()
      if (live.finalPath) {
        this.heldPaths.delete(live.finalPath)
        const staged = savePath
        if (state === 'completed' && moveFile(staged, live.finalPath)) savePath = live.finalPath
        rmSync(dirname(staged), { recursive: true, force: true })
      }
      if (state === 'completed' && savePath) markOfTheWeb(savePath, item.getURL())
      if (!current) return
      this.patch(
        current,
        {
          status: state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted',
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes() || item.getReceivedBytes(),
          savePath,
          filename: savePath ? basename(savePath) : current.filename,
          speed: 0,
          endedAt: Date.now(),
          canResume: false
        },
        true
      )
      if (state === 'completed' && process.platform === 'darwin') app.dock?.downloadFinished(savePath)
    })

    this.changed.emit({ entry: { ...entry }, partition })
    this.started.emit({ entry: { ...entry }, source })
    this.emitProgress()
  }

  private retry(entry: DownloadEntry, partition: string | null): void {
    const session = this.sessions.get(partition)
    if (!session) return
    this.pendingRetries.set(entry.url, entry.id)
    session.downloadURL(entry.url)
  }

  private find(id: string, partition: string | null): DownloadEntry | undefined {
    return this.entries(partition).find((e) => e.id === id)
  }

  /** Mutates in place, persists (regular profile only), and emits - throttled unless `immediate`. */
  private patch(entry: DownloadEntry, patch: Partial<DownloadEntry>, immediate: boolean): void {
    Object.assign(entry, patch)
    const live = this.live.get(entry.id)
    const partition = live?.partition ?? this.partitionOf(entry.id)
    if (partition === null) this.store.set(this.store.value)
    const emit = (): void => {
      if (live) {
        live.lastEmit = Date.now()
        live.emitTimer = null
      }
      this.changed.emit({ entry: { ...entry }, partition })
      this.emitProgress()
    }
    if (immediate || !live) {
      if (live?.emitTimer) clearTimeout(live.emitTimer)
      emit()
      return
    }
    if (live.emitTimer) return
    const wait = Math.max(0, EMIT_INTERVAL_MS - (Date.now() - live.lastEmit))
    live.emitTimer = setTimeout(emit, wait)
  }

  private partitionOf(id: string): string | null {
    for (const [partition, entries] of this.ephemeral) if (entries.some((e) => e.id === id)) return partition
    return null
  }

  private emitProgress(): void {
    let total = 0
    let received = 0
    let anyUnknown = false
    let allPaused = this.live.size > 0
    for (const [id, live] of this.live) {
      const e = this.find(id, live.partition)
      if (!e) continue
      if (e.status !== 'paused') allPaused = false
      if (e.totalBytes > 0) {
        total += e.totalBytes
        received += e.receivedBytes
      } else anyUnknown = true
    }
    if (this.live.size === 0) this.progress.emit({ value: -1, paused: false })
    else this.progress.emit({ value: total > 0 && !anyUnknown ? received / total : 2, paused: allPaused })
  }

  private safeName(filename: string): string {
    return safeFileName(filename)
  }

  private uniquePath(dir: string, filename: string): string {
    const safe = this.safeName(filename)
    const ext = extname(safe)
    const stem = safe.slice(0, safe.length - ext.length)
    const taken = new Set([...this.live.values()].map((l) => l.item.getSavePath()).concat([...this.heldPaths]))
    let candidate = join(dir, safe)
    for (let n = 1; existsSync(candidate) || taken.has(candidate); n++) {
      candidate = join(dir, `${stem} (${n})${ext}`)
    }
    return candidate
  }
}

/** Marks a finished download as coming from the Internet (see ZONE_IDENTIFIER). Local file: copies stay unmarked. */
function markOfTheWeb(path: string, url: string): void {
  // Writing a stream of a missing file would create an empty one.
  if (process.platform !== 'win32' || /^file:/i.test(url) || !existsSync(path)) return
  try {
    writeFileSync(`${path}:Zone.Identifier`, ZONE_IDENTIFIER)
  } catch (err) {
    // FAT32 and exFAT drives have no alternate data streams.
    console.warn('[downloads] could not mark a download as from the Internet:', (err as Error).message)
  }
}

/** Moves a finished download into place (copying across drives, e.g. a profile on a USB stick). */
function moveFile(from: string, to: string): boolean {
  try {
    renameSync(from, to)
    return true
  } catch {
    try {
      copyFileSync(from, to)
      unlinkSync(from)
      return true
    } catch (err) {
      console.error('[downloads] could not move a download into place:', err)
      return false
    }
  }
}
