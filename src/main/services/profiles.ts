import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProfileIdentity, ProfileResult, ProfileSummary } from '../../shared/types'
import {
  cleanProfileName,
  DEFAULT_PROFILE_ID,
  isProfileColor,
  MAX_PROFILES,
  PROFILES_DIR,
  profileIdFrom,
  REGISTRY_FILE,
  roleArgs,
  roleDir,
  roleEntry,
  sanitizeRegistry,
  type ProcessRole,
  type ProfileColor,
  type ProfileRegistry
} from '../lib/profiles'

/** Written by a running profile process into its folder: a profile that is open is never deleted. */
const RUNNING_FILE = 'aqua.pid'
/** A deleted profile's folder is renamed to this prefix first, then removed (again at the next start if need be). */
const DELETED_PREFIX = '.deleted-'

/**
 * The profiles of this Aqua (see lib/profiles.ts): the registry, profile folders, and starting a
 * profile or a guest session in a process of its own. The registry is read from disk every time,
 * since other profile processes may have changed it.
 */
export class ProfileService {
  constructor(
    /** The data root: the default profile's folder, which holds the registry and the other profiles. */
    readonly root: string,
    readonly role: ProcessRole
  ) {}

  get isGuest(): boolean {
    return this.role.kind === 'guest'
  }

  /** Who this process is, for the window title, the tab strip badge and the lock screen. */
  identity(): ProfileIdentity {
    const registry = this.registry()
    if (this.role.kind === 'guest') {
      return { kind: 'guest', id: null, name: 'Guest', color: 'gray', profileCount: 0 }
    }
    const entry = roleEntry(registry, this.role) ?? registry.profiles[0]
    return {
      kind: this.role.kind,
      id: entry.id,
      name: entry.name,
      color: entry.color,
      profileCount: registry.profiles.length
    }
  }

  /** Every profile, for the switcher. A guest session is independent of them and sees none. */
  list(): ProfileSummary[] {
    if (this.isGuest) return []
    const current = this.identity().id
    return this.registry().profiles.map((p) => ({ ...p, current: p.id === current }))
  }

  create(rawName: unknown, rawColor: unknown): ProfileResult {
    const name = cleanProfileName(rawName)
    if (!name) return { ok: false, error: 'Give the profile a name.' }
    const registry = this.registry()
    if (registry.profiles.length >= MAX_PROFILES)
      return { ok: false, error: `Aqua keeps up to ${MAX_PROFILES} profiles.` }
    let id = profileIdFrom(randomBytes(6))
    while (registry.profiles.some((p) => p.id === id)) id = profileIdFrom(randomBytes(6))
    const color: ProfileColor = isProfileColor(rawColor) ? rawColor : 'teal'
    mkdirSync(roleDir(this.root, { kind: 'profile', id }), { recursive: true })
    this.write({ ...registry, profiles: [...registry.profiles, { id, name, color }] })
    return { ok: true, id }
  }

  update(id: string, rawName: unknown, rawColor: unknown): ProfileResult {
    const name = cleanProfileName(rawName)
    if (!name) return { ok: false, error: 'Give the profile a name.' }
    const registry = this.registry()
    if (!registry.profiles.some((p) => p.id === id)) return { ok: false, error: 'That profile no longer exists.' }
    this.write({
      ...registry,
      profiles: registry.profiles.map((p) =>
        p.id === id ? { id, name, color: isProfileColor(rawColor) ? rawColor : p.color } : p
      )
    })
    return { ok: true, id }
  }

  /**
   * Deletes a profile and everything in it. Not the default profile (its data is the root: use
   * Wipe), not this one, and not one that is open in another window.
   */
  remove(id: string): ProfileResult {
    const registry = this.registry()
    if (id === DEFAULT_PROFILE_ID || id === this.identity().id)
      return { ok: false, error: 'This profile can’t be deleted here.' }
    if (!registry.profiles.some((p) => p.id === id)) return { ok: false, error: 'That profile no longer exists.' }
    const dir = roleDir(this.root, { kind: 'profile', id })
    if (isRunning(dir)) return { ok: false, error: 'That profile is open. Close its windows first.' }
    const doomed = join(this.root, PROFILES_DIR, `${DELETED_PREFIX}${id}-${Date.now()}`)
    if (existsSync(dir)) {
      try {
        // Windows refuses to rename a folder while any file in it is open: a last check that it's closed.
        renameSync(dir, doomed)
      } catch {
        return { ok: false, error: 'That profile is open. Close its windows first.' }
      }
    }
    this.write({ ...registry, profiles: registry.profiles.filter((p) => p.id !== id) })
    rmSync(doomed, { recursive: true, force: true, maxRetries: 3 })
    return { ok: true, id }
  }

  /** Opens a profile, or a guest session, in a process of its own (or brings its window forward if it runs). */
  open(role: ProcessRole): void {
    if (role.kind === 'profile' && !this.registry().profiles.some((p) => p.id === role.id)) return
    if (role.kind !== 'default') mkdirSync(roleDir(this.root, role), { recursive: true })
    // The single-file portable build runs from a copy its launcher unpacked: start the launcher, so
    // the new process gets a copy of its own (this one is deleted when this process quits).
    const launcher = process.env['PORTABLE_EXECUTABLE_FILE']
    const exe = launcher && existsSync(launcher) ? launcher : process.execPath
    const args = [...(app.isPackaged ? [] : [app.getAppPath()]), ...roleArgs(role)]
    // Development only: lets tests drive the new process too.
    const debugPort = app.isPackaged ? undefined : process.env['AQUA_CHILD_DEBUG_PORT']
    if (debugPort) args.push(`--remote-debugging-port=${debugPort}`)
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
    child.on('error', (err) => console.error('[profiles] could not start a profile:', err.message))
    child.unref()
  }

  /** Marks this profile as open (see `remove`), and finishes deletions an earlier run left half done. */
  markRunning(dir: string): void {
    try {
      writeFileSync(join(dir, RUNNING_FILE), String(process.pid))
    } catch {
      // A read-only drive: nothing can be deleted there anyway.
    }
    if (this.role.kind !== 'default') return
    try {
      const profiles = join(this.root, PROFILES_DIR)
      for (const name of readdirSync(profiles)) {
        if (name.startsWith(DELETED_PREFIX)) rmSync(join(profiles, name), { recursive: true, force: true })
      }
    } catch {
      // No other profiles yet.
    }
  }

  clearRunning(dir: string): void {
    rmSync(join(dir, RUNNING_FILE), { force: true })
  }

  registry(): ProfileRegistry {
    return readRegistry(this.root)
  }

  private write(registry: ProfileRegistry): void {
    const file = join(this.root, REGISTRY_FILE)
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(sanitizeRegistry(registry), null, 2))
    renameSync(temp, file)
  }
}

/** The registry in `root`; just the default profile when there is none (or it is unreadable). */
export function readRegistry(root: string): ProfileRegistry {
  try {
    return sanitizeRegistry(JSON.parse(readFileSync(join(root, REGISTRY_FILE), 'utf-8')))
  } catch {
    return sanitizeRegistry(null)
  }
}

/** Whether a profile folder belongs to a process that is still running. */
function isRunning(dir: string): boolean {
  let pid: number
  try {
    pid = Number(readFileSync(join(dir, RUNNING_FILE), 'utf-8'))
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists but belongs to someone else - still running.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Empties a folder this process is about to use (a guest session starts from nothing). */
export function emptyFolder(dir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    try {
      rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 2 })
    } catch {
      // Chromium's own lock file, held open by this process.
    }
  }
}
