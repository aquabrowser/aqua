import { join } from 'path'
import { VaultDatabase } from '../storage/database'
import { deleteLegacyFiles, hasLegacyData, readLegacyData } from '../storage/legacy'
import { BookmarksService } from './bookmarks'
import { CertificateService } from './certificates'
import { ContentBlockerService } from './content-blocker'
import { CookieJar } from './cookie-jar'
import { DownloadsService } from './downloads'
import { HistoryService } from './history'
import { NtpImageService } from './ntp-image'
import { PermissionService, type PromptHost } from './permissions'
import { ProtocolGrantsService } from './protocol-grants'
import { SessionService } from './session'
import { SettingsService } from './settings'
import { ShortcutsService } from './shortcuts'
import { SiteStorageService } from './site-storage'
import { UpdaterService, type UpdaterOptions } from './updater'
import { VaultService } from './vault'

export interface Services {
  db: VaultDatabase
  settings: SettingsService
  history: HistoryService
  bookmarks: BookmarksService
  downloads: DownloadsService
  vault: VaultService
  permissions: PermissionService
  protocolGrants: ProtocolGrantsService
  certificates: CertificateService
  contentBlocker: ContentBlockerService
  cookies: CookieJar
  siteStorage: SiteStorageService
  session: SessionService
  shortcuts: ShortcutsService
  ntpImage: NtpImageService
  updater: UpdaterService
}

export const DATABASE_FILE = 'aqua.db'
/** SQLite's name for a database that exists only in memory. */
const MEMORY_DATABASE = ':memory:'

export interface ServiceOptions {
  /** A guest session: the vault lives in memory only and nothing it holds is ever written. */
  ephemeral: boolean
  /** Where the filter lists are kept: the data root, shared by every profile (public data). */
  filtersRoot: string
}

export function createServices(
  dir: string,
  prompts: PromptHost,
  updater: UpdaterOptions,
  options: ServiceOptions = { ephemeral: false, filtersRoot: dir }
): Services {
  const db = new VaultDatabase(options.ephemeral ? MEMORY_DATABASE : join(dir, DATABASE_FILE))
  const settings = new SettingsService(db)
  const history = new HistoryService(db)
  const bookmarks = new BookmarksService(db)
  const downloads = new DownloadsService(db, settings)
  const session = new SessionService(db)
  const protocolGrants = new ProtocolGrantsService(db)
  // The vault needs `migrateLegacy`, which needs the other services; permissions
  // only ask the vault at request time, so it is resolved lazily.
  let vault: VaultService | null = null
  const permissions = new PermissionService(db, settings, prompts, () => vault?.isOpen() ?? false)

  /** Imports and then deletes the plaintext files of pre-vault Aqua versions. */
  const migrateLegacy = (): void => {
    if (!hasLegacyData(dir)) return
    const legacy = readLegacyData(dir)
    if (legacy['settings.json'] !== undefined) settings.importLegacy(legacy['settings.json'])
    if (legacy['history.json'] !== undefined) history.importLegacy(legacy['history.json'])
    if (legacy['bookmarks.json'] !== undefined) bookmarks.importLegacy(legacy['bookmarks.json'])
    if (legacy['downloads.json'] !== undefined) downloads.importLegacy(legacy['downloads.json'])
    if (legacy['session.json'] !== undefined) session.importLegacy(legacy['session.json'])
    if (legacy['permissions.json'] !== undefined) permissions.importLegacy(legacy['permissions.json'])
    db.flush()
    history.flush()
    deleteLegacyFiles(dir)
  }

  vault = new VaultService(db, dir, options.ephemeral ? () => undefined : migrateLegacy)
  return {
    db,
    settings,
    history,
    bookmarks,
    downloads,
    vault,
    permissions,
    protocolGrants,
    certificates: new CertificateService(),
    contentBlocker: new ContentBlockerService(settings, options.filtersRoot),
    cookies: new CookieJar(db),
    siteStorage: new SiteStorageService(db),
    session,
    shortcuts: new ShortcutsService(db, history, settings),
    ntpImage: new NtpImageService(db),
    updater: new UpdaterService(updater)
  }
}

/** Persist everything synchronously; used on quit. */
export function flushAll(services: Services): void {
  services.history.flushSync()
  services.bookmarks.flushSync()
  services.downloads.flushSync()
  services.permissions.flushSync()
  services.protocolGrants.flushSync()
  services.session.flushSync()
  services.shortcuts.flushSync()
  services.db.flush()
}
