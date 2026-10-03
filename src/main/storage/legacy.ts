import { scrypt, timingSafeEqual } from 'crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'

/**
 * Pre-vault Aqua stored everything as plaintext JSON next to a scrypt
 * password hash. On first unlock those files are imported into the encrypted
 * database and then deleted, so no plaintext history survives the upgrade.
 */
const DATA_FILES = [
  'settings.json',
  'history.json',
  'bookmarks.json',
  'downloads.json',
  'session.json',
  'permissions.json',
  'shields.json'
] as const
const VAULT_FILE = 'vault.json'

export type LegacyFile = (typeof DATA_FILES)[number]

interface LegacyVault {
  salt: string
  hash: string
  params?: { N: number; r: number; p: number }
}

export function readLegacyVault(dir: string): LegacyVault | null {
  const file = join(dir, VAULT_FILE)
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as LegacyVault
    return typeof data.salt === 'string' && typeof data.hash === 'string' ? data : null
  } catch {
    return null
  }
}

/** Verifies a password against the old scrypt hash (v1 trimmed passwords before hashing). */
export function verifyLegacyPassword(vault: LegacyVault, password: string): Promise<boolean> {
  const params = vault.params ?? { N: 16384, r: 8, p: 1 }
  return new Promise((resolve) => {
    scrypt(
      vault.params ? password : password.trim(),
      vault.salt,
      64,
      { ...params, maxmem: 64 * 1024 * 1024 },
      (err, key) => {
        if (err) return resolve(false)
        const expected = Buffer.from(vault.hash, 'hex')
        resolve(expected.length === key.length && timingSafeEqual(expected, key))
      }
    )
  })
}

export function hasLegacyData(dir: string): boolean {
  return DATA_FILES.some((name) => existsSync(join(dir, name))) || existsSync(join(dir, VAULT_FILE))
}

/** Reads each legacy file that exists (unparseable files are skipped). */
export function readLegacyData(dir: string): Partial<Record<LegacyFile, unknown>> {
  const out: Partial<Record<LegacyFile, unknown>> = {}
  for (const name of DATA_FILES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    try {
      out[name] = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    } catch (err) {
      console.warn(`[legacy] ${name} could not be parsed and was not imported:`, err)
    }
  }
  return out
}

/** Removes every plaintext file from earlier versions, including temp/quarantine copies. */
export function deleteLegacyFiles(dir: string): void {
  const names = new Set<string>([...DATA_FILES, VAULT_FILE])
  for (const entry of readdirSync(dir)) {
    const base = entry.replace(/\.(tmp|corrupt-\d+)$/, '')
    if (names.has(base)) rmSync(join(dir, entry), { force: true })
  }
  rmSync(join(dir, 'adblock'), { recursive: true, force: true })
}
