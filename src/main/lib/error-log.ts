import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'

/**
 * The local log of errors nothing else caught (see index.ts). Aqua keeps no browsing data on
 * disk outside the vault, so what goes in is scrubbed first: addresses become `<url>` (an error
 * message can name the page it came from) and the home folder becomes `~` (it holds the Windows
 * user name). Pure Node, so it can be unit tested.
 */

export const ERROR_LOG_DIR = 'logs'
export const ERROR_LOG_FILE = 'main.log'
/** At this size the log moves to main.old.log and starts over: two files at most. */
export const ERROR_LOG_MAX_BYTES = 512 * 1024

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>()[\]{}]+/gi

/**
 * Removes addresses (any `scheme://…`, file: included: a local page is browsing data too) and the
 * home folder from `text`. Main-process stack frames use plain paths (`C:\…`) and `node:` ids,
 * which stay readable.
 */
export function redactForLog(text: string, homeDir: string): string {
  let out = text.replace(URL_PATTERN, '<url>')
  if (homeDir) {
    for (const form of new Set([homeDir, homeDir.replace(/\\/g, '/')])) out = out.split(form).join('~')
  }
  return out
}

/** One log entry: when, what kind, and the error's stack (or its string form). */
export function formatErrorEntry(kind: string, error: unknown, at: Date, versions: string): string {
  const detail =
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : `Non-error value: ${String(error)}`
  return `[${at.toISOString()}] ${kind} (${versions})\n${detail}\n\n`
}

/** Appends `entry` (already redacted) to `<profile>/logs/main.log`. Never throws. */
export function appendErrorLog(profileDir: string, entry: string): string | null {
  try {
    const dir = join(profileDir, ERROR_LOG_DIR)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, ERROR_LOG_FILE)
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      // No log yet.
    }
    if (size + Buffer.byteLength(entry) > ERROR_LOG_MAX_BYTES) {
      const old = join(dir, 'main.old.log')
      rmSync(old, { force: true })
      renameSync(file, old)
    }
    appendFileSync(file, entry)
    return file
  } catch {
    return null
  }
}
