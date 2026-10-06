import { app } from 'electron'
import { existsSync } from 'fs'
import { lstat, readdir } from 'fs/promises'
import { dirname, join, relative, resolve } from 'path'
import type { StorageInfo } from '../../shared/types'
import type { ProfileLocation } from '../lib/profile-location'
import { SHARED_ROOT_ENTRIES } from '../lib/profiles'

const VAULT_FILES = new Set(['aqua.db', 'aqua.db-wal', 'aqua.db-shm', 'aqua.db-journal'])

/** Bytes of every file below `dir`, by the first path segment. Links are not followed. */
async function sizesByEntry(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const walk = async (path: string, top: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(path, entry.name)
      const key = top || entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(full, key)
      else {
        try {
          out.set(key, (out.get(key) ?? 0) + (await lstat(full)).size)
        } catch {
          // Gone or locked in the meantime.
        }
      }
    }
  }
  await walk(dir, '')
  return out
}

const same = (a: string, b: string): boolean => relative(resolve(a), resolve(b)) === ''

/**
 * What Settings → Storage shows: facts about this profile's folder, measured now. The filter lists
 * are shared by every profile and live in the data root (`root`); the default profile's folder is
 * the root itself, and the other profiles' folders in it are not counted as its own.
 */
export async function storageReport(location: ProfileLocation, root: string): Promise<StorageInfo> {
  const path = app.getPath('userData')
  const isRoot = same(path, root)
  const sizes = await sizesByEntry(path)
  let vaultBytes = 0
  let otherBytes = 0
  for (const [name, bytes] of sizes) {
    if (VAULT_FILES.has(name)) vaultBytes += bytes
    else if (name === 'filters' || (isRoot && SHARED_ROOT_ENTRIES.has(name))) continue
    else otherBytes += bytes
  }
  let filterBytes = 0
  for (const bytes of (await sizesByEntry(join(root, 'filters'))).values()) filterBytes += bytes
  // An installed Aqua's profile on this computer, when this copy keeps its data elsewhere.
  const installed = join(app.getPath('appData'), 'aqua-browser')
  const otherProfile =
    location.mode !== 'installed' && !same(installed, path) && existsSync(installed) ? installed : null
  return {
    path,
    mode: location.mode,
    portableKind: location.portableKind,
    vaultBytes,
    filterBytes,
    otherBytes,
    programDir: location.portableKind === 'single-file' ? dirname(app.getPath('exe')) : null,
    otherProfile
  }
}
