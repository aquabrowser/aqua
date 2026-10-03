import { randomFillSync } from 'crypto'
import { session } from 'electron'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'fs'
import { join } from 'path'
import { sanitizeCookies, toStored, type StoredCookie } from '../lib/cookies'
import { DecryptionError, unseal } from '../storage/crypto'
import type { VaultDatabase } from '../storage/database'
import type { CookieJar } from './cookie-jar'

/** Cookies sealed by the interim build that staged the profile in a temp folder. */
const SEALED_COOKIES = 'cookies.sealed'
const SEALED_COOKIES_AAD = 'aqua/v1/cookies'

/** Files and folders earlier Aqua versions left in the profile folder that nothing reads any more. */
const LEFTOVERS = [
  SEALED_COOKIES,
  `${SEALED_COOKIES}.tmp`,
  'profile.sealed',
  'profile.sealed.prev',
  'profile.sealed.tmp',
  // uBlock Origin's extension state (it ran as an extension until in-memory browsing).
  'Local Extension Settings',
  'Extension State',
  'Extension Rules',
  'Extension Scripts',
  'Extensions'
]

/**
 * Before in-memory browsing, pages ran in the default session, whose cookies
 * and site data are files in the profile folder (protected only by Windows'
 * per-user key). On unlock their cookies move into the vault, then everything
 * the default session stored is deleted - and it is deleted again at every
 * unlock, so nothing can linger there. Site storage other than cookies can't
 * be carried over: those sites start fresh once. The network files this can't
 * reach are removed at startup instead (removeDefaultSessionLeftovers).
 */
export async function migrateLegacyProfile(userData: string, db: VaultDatabase, cookies: CookieJar): Promise<void> {
  const legacy = session.defaultSession
  const found: StoredCookie[] = (await legacy.cookies.get({})).map(toStored).filter((c) => c !== null)
  // The interim build's jar is newer than the default session's, so it is applied last.
  found.push(...readSealedCookies(userData, db))
  if (found.length > 0) {
    const adopted = await cookies.adopt(found)
    await cookies.save()
    console.info(`[profile] moved ${adopted} cookies from an older profile into the vault`)
  }
  await Promise.allSettled([
    legacy.clearStorageData(),
    legacy.clearCache(),
    legacy.clearCodeCaches({ urls: [] }),
    legacy.clearAuthCache()
  ])
  for (const name of LEFTOVERS) {
    try {
      rmSync(join(userData, name), { recursive: true, force: true })
    } catch (err) {
      console.warn(`[profile] could not remove ${name}:`, (err as Error).message)
    }
  }
}

/**
 * What the default session keeps beyond the reach of clearStorageData()/clearData()
 * (Electron has no data type for them): hosts it connected to in plaintext
 * (Network Persistent State, DIPS) or hashed (TransportSecurity). The default
 * session refuses all web traffic now, so these hold only what earlier
 * versions recorded.
 */
const DEFAULT_SESSION_FILES = [
  join('Network', 'Network Persistent State'),
  join('Network', 'TransportSecurity'),
  'DIPS',
  'DIPS-journal',
  'DIPS-wal',
  'DIPS-shm'
]

/**
 * Overwrites each of DEFAULT_SESSION_FILES with random bytes, then deletes it.
 * Runs before the app is ready: once Chromium has read them it keeps them in
 * memory and writes them back. Overwriting comes first on purpose: if the
 * delete then fails, what stays on disk is random bytes, not host names. The
 * two failures are logged apart so audits can tell them apart. On SSDs the
 * overwrite is best effort (the drive may remap blocks).
 */
export function removeDefaultSessionLeftovers(userData: string): void {
  for (const name of DEFAULT_SESSION_FILES) {
    const file = join(userData, name)
    let size: number
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    try {
      overwriteWithRandom(file, size)
    } catch (err) {
      console.warn(
        `[profile] could not overwrite ${name}, left untouched (original content still readable) at ${file}:`,
        (err as Error).message
      )
      continue
    }
    try {
      rmSync(file)
      console.info(`[profile] removed ${name}`)
    } catch (err) {
      console.warn(
        `[profile] overwrote ${name} with random bytes but could not delete it; the file is still at ${file}:`,
        (err as Error).message
      )
    }
  }
}

function overwriteWithRandom(file: string, size: number): void {
  const fd = openSync(file, 'r+')
  try {
    const chunk = Buffer.alloc(64 * 1024)
    for (let offset = 0; offset < size; offset += chunk.length) {
      const length = Math.min(chunk.length, size - offset)
      randomFillSync(chunk, 0, length)
      writeSync(fd, chunk, 0, length, offset)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function readSealedCookies(userData: string, db: VaultDatabase): StoredCookie[] {
  const file = join(userData, SEALED_COOKIES)
  if (!existsSync(file)) return []
  const key = db.deriveKey('cookies')
  try {
    return sanitizeCookies(JSON.parse(unseal(key, readFileSync(file), SEALED_COOKIES_AAD).toString('utf-8')))
  } catch (err) {
    if (!(err instanceof DecryptionError) && !(err instanceof SyntaxError)) throw err
    return []
  } finally {
    key.fill(0)
  }
}
