import { join } from 'path'
import { PROFILE_COLORS, type ProfileColor } from '../../shared/profiles'

/**
 * Profiles. Each one is a folder with its own encrypted vault (its own master password, history,
 * cookies, site data and settings) and runs in a process of its own: Electron's single-instance
 * lock belongs to the folder, so two profiles never share memory, keys or a browsing session.
 * The default profile is the data root itself, so existing installations keep their data in place.
 *
 *   <root>/                default profile (aqua.db …), and the filter lists every profile shares
 *   <root>/profiles.json   names and colours, readable before any unlock (the lock screen lists them)
 *   <root>/Profiles/<id>/  every other profile
 *   <root>/Guest/          Chromium's own working files of the guest session, emptied at every start
 *
 * A guest session is a process whose vault lives only in memory: nothing it sees is kept.
 */
export const DEFAULT_PROFILE_ID = 'default'
export const PROFILES_DIR = 'Profiles'
export const GUEST_DIR = 'Guest'
export const REGISTRY_FILE = 'profiles.json'
export const MAX_PROFILES = 20
export const MAX_PROFILE_NAME = 40

/** Command-line switches that pick what a process runs. */
export const GUEST_SWITCH = '--aqua-guest'
export const PROFILE_SWITCH = '--aqua-profile='

export { PROFILE_COLORS, type ProfileColor }

export interface ProfileEntry {
  id: string
  name: string
  color: ProfileColor
}

export interface ProfileRegistry {
  version: 1
  /** The default profile first, then the others in the order they were added. */
  profiles: ProfileEntry[]
}

export type ProcessRole = { kind: 'default' } | { kind: 'profile'; id: string } | { kind: 'guest' }

export const DEFAULT_ENTRY: ProfileEntry = { id: DEFAULT_PROFILE_ID, name: 'Personal', color: 'blue' }

/** Entries of the data root that belong to other profiles: wiping the default profile keeps them. */
export const SHARED_ROOT_ENTRIES: ReadonlySet<string> = new Set([PROFILES_DIR, GUEST_DIR, REGISTRY_FILE])

const PROFILE_ID = /^[a-z0-9]{12}$/

export function isProfileColor(value: unknown): value is ProfileColor {
  return typeof value === 'string' && (PROFILE_COLORS as readonly string[]).includes(value)
}

/** A profile name as shown: single spaces, no control characters, 1 to 40 characters. */
export function cleanProfileName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const name = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return name.length > 0 && [...name].length <= MAX_PROFILE_NAME ? name : null
}

/** The registry as stored, keeping only well-formed entries; the default profile always comes first. */
export function sanitizeRegistry(raw: unknown): ProfileRegistry {
  const list = (raw as { profiles?: unknown } | null)?.profiles
  let first = DEFAULT_ENTRY
  const others: ProfileEntry[] = []
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'object' || item === null) continue
    const { id, name: rawName, color: rawColor } = item as Record<string, unknown>
    const name = cleanProfileName(rawName)
    const color = isProfileColor(rawColor) ? rawColor : DEFAULT_ENTRY.color
    if (id === DEFAULT_PROFILE_ID) {
      if (name) first = { id, name, color }
      continue
    }
    if (typeof id !== 'string' || !PROFILE_ID.test(id) || !name || others.some((p) => p.id === id)) continue
    others.push({ id, name, color })
  }
  return { version: 1, profiles: [first, ...others.slice(0, MAX_PROFILES - 1)] }
}

/** What this process runs, from its command line: a guest session, a named profile, or the default profile. */
export function roleFromArgs(argv: readonly string[], registry: ProfileRegistry): ProcessRole {
  if (argv.includes(GUEST_SWITCH)) return { kind: 'guest' }
  const id = argv.find((arg) => arg.startsWith(PROFILE_SWITCH))?.slice(PROFILE_SWITCH.length)
  if (id && id !== DEFAULT_PROFILE_ID && registry.profiles.some((p) => p.id === id)) return { kind: 'profile', id }
  return { kind: 'default' }
}

/** The command-line switches that start `role`. */
export function roleArgs(role: ProcessRole): string[] {
  if (role.kind === 'guest') return [GUEST_SWITCH]
  if (role.kind === 'profile') return [`${PROFILE_SWITCH}${role.id}`]
  return []
}

/** The folder a role keeps its data in (Electron's userData). */
export function roleDir(root: string, role: ProcessRole): string {
  if (role.kind === 'guest') return join(root, GUEST_DIR)
  if (role.kind === 'profile') return join(root, PROFILES_DIR, role.id)
  return root
}

/** The registry entry a role runs as; a guest session has none. */
export function roleEntry(registry: ProfileRegistry, role: ProcessRole): ProfileEntry | null {
  if (role.kind === 'guest') return null
  const id = role.kind === 'profile' ? role.id : DEFAULT_PROFILE_ID
  return registry.profiles.find((p) => p.id === id) ?? null
}

/** A new profile id from random bytes (12 lowercase hex characters). */
export function profileIdFrom(bytes: Uint8Array): string {
  return Buffer.from(bytes.subarray(0, 6)).toString('hex')
}
