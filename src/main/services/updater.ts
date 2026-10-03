import { Notification } from 'electron'
import type { AppUpdater, ProgressInfo, UpdateCheckResult, UpdateInfo } from 'electron-updater'
import type { UpdateStatus } from '../../shared/types'
import { Signal } from '../lib/signal'

/** The first check waits this long after start-up, so it never competes with the first window. */
const FIRST_CHECK_DELAY_MS = 15_000

export interface UpdaterOptions {
  /** Why this copy doesn't update itself, or null when it does (packaged and installed). */
  disabledReason: 'portable' | 'development' | null
  /** Development only: an `app-update.yml`-style file to test against (AQUA_UPDATE_CONFIG). */
  devConfigPath?: string
}

/**
 * Updates from GitHub Releases (electron-builder.json → publish), for installed copies only:
 * a portable copy is replaced by hand. electron-updater is loaded only then, after start-up.
 *
 * It requests through its own in-memory session (partition "electron-updater"), so neither the
 * default session's block on web traffic nor the browsing sessions are involved. The installer
 * is downloaded to %LOCALAPPDATA%\aqua-browser-updater.
 *
 * Installing happens as Aqua exits (installOnExit, called by index.ts): Aqua ends with
 * app.exit() after its final save, which skips the "quit" event electron-updater would wait for.
 *
 * Not checkForUpdatesAndNotify(): it chains onto the download without a catch, so a download that
 * fails (a dropped connection) would be an unhandled rejection, which locks the vault (index.ts,
 * installErrorGuards). The notice for a background download is shown here instead.
 */
export class UpdaterService {
  readonly changed = new Signal<UpdateStatus>()
  private current: UpdateStatus
  private updater: AppUpdater | null = null
  private loading: Promise<AppUpdater | null> | null = null
  /** "Restart to update": run Aqua again once the installer is done. */
  private restartAfterInstall = false
  /** The check started on its own (not from Settings): say so when its download is ready. */
  private notifyWhenDownloaded = false

  constructor(private readonly options: UpdaterOptions) {
    this.current = options.disabledReason ? { state: 'disabled', reason: options.disabledReason } : { state: 'idle' }
  }

  status(): UpdateStatus {
    return this.current
  }

  /** Called once the first window is on screen: checks after a pause, then notifies when downloaded. */
  start(): void {
    if (this.options.disabledReason) return
    setTimeout(() => {
      this.notifyWhenDownloaded = true
      void this.run((u) => u.checkForUpdates())
    }, FIRST_CHECK_DELAY_MS).unref()
  }

  /** "Check for updates" in Settings → About. */
  check(): void {
    const s = this.current.state
    if (s === 'disabled' || s === 'checking' || s === 'downloading' || s === 'downloaded') return
    // Asked for in Settings → About, which shows the progress itself.
    this.notifyWhenDownloaded = false
    void this.run((u) => u.checkForUpdates())
  }

  /** "Restart to update": quit as usual (pages may ask "Leave site?"); the update installs on exit. */
  restartToUpdate(quit: () => void): void {
    if (this.current.state !== 'downloaded') return
    this.restartAfterInstall = true
    quit()
  }

  /** The quit was cancelled (a page's "Leave site?" answered Stay): no restart is owed any more. */
  quitCancelled(): void {
    this.restartAfterInstall = false
  }

  /**
   * Aqua is exiting: start the downloaded update's installer, which waits for Aqua to be gone.
   * Silent, and Aqua starts again afterwards only if the user asked to restart.
   */
  installOnExit(): void {
    if (this.current.state !== 'downloaded' || !this.updater) return
    try {
      this.updater.quitAndInstall(true, this.restartAfterInstall)
    } catch (err) {
      console.error('[updater] install failed:', (err as Error).message)
    }
  }

  private set(next: UpdateStatus): void {
    this.current = next
    this.changed.emit(next)
  }

  private async run(action: (updater: AppUpdater) => Promise<UpdateCheckResult | null>): Promise<void> {
    const updater = await this.load()
    if (!updater) return
    try {
      const result = await action(updater)
      // The download goes on after the check. A failure is reported through 'error' as well, but
      // its promise must be handled here or it becomes an unhandled rejection.
      result?.downloadPromise?.catch(() => undefined)
    } catch {
      // Reported through the 'error' event (offline, GitHub unreachable, no release yet …).
    }
  }

  private notifyDownloaded(version: string): void {
    if (!this.notifyWhenDownloaded || !Notification.isSupported()) return
    new Notification({ title: 'Aqua update ready', body: `Version ${version} installs when Aqua restarts.` }).show()
  }

  private load(): Promise<AppUpdater | null> {
    this.loading ??= import('electron-updater')
      .then((mod) => {
        // A CommonJS module whose `autoUpdater` is a getter: a native import() only has it on `default`.
        const autoUpdater =
          mod.autoUpdater ?? (mod as unknown as { default: { autoUpdater: AppUpdater } }).default.autoUpdater
        autoUpdater.logger = null
        // Installs on exit are started by installOnExit (see the class comment).
        autoUpdater.autoInstallOnAppQuit = false
        if (this.options.devConfigPath) {
          autoUpdater.forceDevUpdateConfig = true
          autoUpdater.updateConfigPath = this.options.devConfigPath
        }
        autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
        autoUpdater.on('update-not-available', () => this.set({ state: 'up-to-date', checkedAt: Date.now() }))
        autoUpdater.on('update-available', (info: UpdateInfo) =>
          this.set({ state: 'downloading', version: info.version, percent: 0 })
        )
        autoUpdater.on('download-progress', (progress: ProgressInfo) => {
          const prev = this.current
          if (prev.state !== 'downloading') return
          const percent = Math.floor(progress.percent)
          // Whole percents only: progress fires many times a second.
          if (percent !== prev.percent) this.set({ ...prev, percent })
        })
        autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
          this.set({ state: 'downloaded', version: info.version })
          this.notifyDownloaded(info.version)
        })
        autoUpdater.on('error', (err: Error) => {
          console.warn('[updater]', err.message)
          // A failed check doesn't undo a finished download.
          if (this.current.state !== 'downloaded') this.set({ state: 'error' })
        })
        this.updater = autoUpdater
        return autoUpdater
      })
      .catch((err: Error) => {
        console.error('[updater] unavailable:', err.message)
        this.set({ state: 'error' })
        return null
      })
    return this.loading
  }
}
