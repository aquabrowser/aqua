import { app, shell } from 'electron'

/**
 * Schemes that are never handed to the OS, whoever asks: they execute code,
 * open local files or search results, or have a history of exploitation
 * (e.g. ms-msdt "Follina", search-ms, ms-appinstaller). The Office schemes
 * (ms-word: …) open a document straight from a web server in the desktop app,
 * a known way to deliver macro and exploit documents.
 */
const BLOCKED_SCHEMES = new Set([
  'afp',
  'data',
  'disk',
  'disks',
  'file',
  'hcp',
  'ie.http',
  'its',
  'javascript',
  'mk',
  'ms-access',
  'ms-appinstaller',
  'ms-cxh',
  'ms-cxh-full',
  'ms-excel',
  'ms-help',
  'ms-infopath',
  'ms-its',
  'ms-msdt',
  'ms-officecmd',
  'ms-powerpoint',
  'ms-project',
  'ms-publisher',
  'ms-spd',
  'ms-visio',
  'ms-word',
  'res',
  'search',
  'search-ms',
  'shell',
  'vbscript',
  'view-source'
])

/** Windows' "How do you want to open this?" chooser, reported when no app is registered. */
const OS_CHOOSER = /[\\/]openwith\.exe$/i

export interface ExternalTarget {
  /** Lower-case scheme without the colon, e.g. `discord`. */
  scheme: string
  /** Friendly name of the registered handler, e.g. "Discord"; '' when the OS will ask which app to use. */
  appName: string
  /** The handler's icon as a data: URL. */
  appIcon: string | null
}

/** What would open `url`, or null when nothing may / can open it. */
export async function externalTarget(url: string): Promise<ExternalTarget | null> {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)
  if (!match || url.length > 8192) return null
  const scheme = match[1].toLowerCase()
  if (BLOCKED_SCHEMES.has(scheme)) return null
  let name = ''
  try {
    name = app.getApplicationNameForProtocol(url)
  } catch {
    return null
  }
  if (!name) return null

  let appIcon: string | null = null
  let chooser = false
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      const info = await app.getApplicationInfoForProtocol(url)
      chooser = OS_CHOOSER.test(info.path)
      if (!chooser && !info.icon.isEmpty()) appIcon = info.icon.toDataURL()
    } catch {
      // The name alone is enough to ask.
    }
  }
  // Windows reports executable paths for some handlers; show just the program name.
  const appName = chooser
    ? ''
    : name
        .replace(/^.*[\\/]/, '')
        .replace(/\.exe$/i, '')
        .trim()
  return { scheme, appName, appIcon }
}

export async function launchExternal(url: string): Promise<void> {
  try {
    await shell.openExternal(url, { activate: true })
  } catch (err) {
    console.warn('[external] launch failed:', err)
  }
}
