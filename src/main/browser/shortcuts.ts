import type { Input } from 'electron'
import type { CommandId } from '../../shared/types'

export interface ResolvedShortcut {
  command: CommandId
  arg?: number
  /** Let the key event continue to the page as well (e.g. Esc still reaches the page). */
  passThrough?: boolean
}

const isMac = process.platform === 'darwin'

/** Commands that may fire repeatedly while the key is held down. */
const REPEATABLE = new Set<CommandId>([
  'tab.next',
  'tab.prev',
  'page.zoom-in',
  'page.zoom-out',
  'find.next',
  'find.prev'
])

/**
 * Normalises a key event to a layout-tolerant name: letters by their typed
 * character when it is Latin, otherwise by physical key (so shortcuts still
 * work on Cyrillic/Greek layouts); digits always by physical key.
 */
function keyName(input: Input): string {
  const code = input.code ?? ''
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return code.slice(6)
  const key = input.key
  if (key.length === 1) {
    const lower = key.toLowerCase()
    if (/^[a-z]$/.test(lower)) return lower
    if (/^Key[A-Z]$/.test(code) && !/^[\x20-\x7e]$/.test(key)) return code.slice(3).toLowerCase()
    return key
  }
  return key
}

export function resolveShortcut(input: Input): ResolvedShortcut | null {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return null
  const key = keyName(input)
  const mod = isMac ? input.meta : input.control
  const shift = input.shift
  const alt = input.alt
  const ctrl = input.control

  const result = match(key, mod, shift, alt, ctrl, input)
  if (!result) return null
  if (input.isAutoRepeat && !REPEATABLE.has(result.command)) return null
  return result
}

function match(
  key: string,
  mod: boolean,
  shift: boolean,
  alt: boolean,
  ctrl: boolean,
  input: Input
): ResolvedShortcut | null {
  // ─── Tabs ─────────────────────────────────────────────────────────────────
  if (ctrl && key === 'Tab') return { command: shift ? 'tab.prev' : 'tab.next' }
  if (mod && !alt && key === 'PageDown') return { command: 'tab.next' }
  if (mod && !alt && key === 'PageUp') return { command: 'tab.prev' }
  if (isMac && mod && alt && key === 'ArrowRight') return { command: 'tab.next' }
  if (isMac && mod && alt && key === 'ArrowLeft') return { command: 'tab.prev' }
  if (isMac && mod && shift && key === '}') return { command: 'tab.next' }
  if (isMac && mod && shift && key === '{') return { command: 'tab.prev' }
  if (mod && !shift && !alt && /^[1-9]$/.test(key)) {
    const n = Number(key)
    return { command: 'tab.select', arg: n === 9 ? -1 : n - 1 }
  }
  if (mod && !alt && key === 't') return { command: shift ? 'tab.reopen' : 'tab.new' }
  if (mod && !alt && key === 'w') return { command: shift ? 'window.close' : 'tab.close' }
  if (!isMac && ctrl && key === 'F4') return { command: 'tab.close' }
  if (mod && !alt && key === 'n') return { command: shift ? 'window.new-private' : 'window.new' }

  // ─── Navigation ──────────────────────────────────────────────────────────
  if (!isMac && alt && !mod && key === 'ArrowLeft') return { command: 'nav.back' }
  if (!isMac && alt && !mod && key === 'ArrowRight') return { command: 'nav.forward' }
  if (isMac && mod && !shift && key === '[') return { command: 'nav.back' }
  if (isMac && mod && !shift && key === ']') return { command: 'nav.forward' }
  if (key === 'BrowserBack') return { command: 'nav.back' }
  if (key === 'BrowserForward') return { command: 'nav.forward' }
  if ((mod && !alt && key === 'r') || key === 'F5' || key === 'BrowserRefresh') {
    const hard = shift || (key === 'F5' && (mod || shift))
    return { command: hard ? 'nav.reload-hard' : 'nav.reload' }
  }
  if (key === 'Escape' && !mod && !alt && !shift) return { command: 'nav.stop', passThrough: true }

  // ─── Omnibox / find ──────────────────────────────────────────────────────
  if ((mod && !shift && key === 'l') || (!isMac && alt && !mod && key === 'd') || key === 'F6') {
    return { command: 'omnibox.focus' }
  }
  if ((mod && !shift && !alt && key === 'k') || (mod && !shift && !alt && key === 'e'))
    return { command: 'omnibox.focus' }
  if (mod && !alt && !shift && key === 'f') return { command: 'find.open' }
  if (key === 'F3' && !mod) return { command: shift ? 'find.prev' : 'find.next' }
  if (mod && !alt && key === 'g') return { command: shift ? 'find.prev' : 'find.next' }

  // ─── Bookmarks / pages ───────────────────────────────────────────────────
  if (mod && !alt && !shift && key === 'd') return { command: 'bookmark.page' }
  if (mod && shift && !alt && key === 'b') return { command: 'bookmarks.toggle-bar' }
  if ((!isMac && mod && !shift && !alt && key === 'h') || (isMac && mod && !shift && key === 'y')) {
    return { command: 'open.history' }
  }
  if ((!isMac && mod && !shift && !alt && key === 'j') || (isMac && mod && shift && key === 'j')) {
    return { command: 'open.downloads' }
  }
  if (isMac && mod && key === ',') return { command: 'open.settings' }

  // ─── Zoom ────────────────────────────────────────────────────────────────
  if (mod && !alt && (key === '=' || key === '+' || input.code === 'NumpadAdd')) return { command: 'page.zoom-in' }
  if (mod && !alt && (key === '-' || key === '_' || input.code === 'NumpadSubtract'))
    return { command: 'page.zoom-out' }
  if (mod && !alt && !shift && (key === '0' || input.code === 'Numpad0')) return { command: 'page.zoom-reset' }

  // ─── Page tools ──────────────────────────────────────────────────────────
  if (mod && !alt && !shift && key === 'p') return { command: 'page.print' }
  if (mod && !alt && !shift && key === 'u') return { command: 'page.view-source' }
  if (key === 'F12' || (!isMac && ctrl && shift && key === 'i') || (isMac && mod && alt && key === 'i')) {
    return { command: 'page.devtools' }
  }
  if ((!isMac && key === 'F11') || (isMac && mod && ctrl && key === 'f')) return { command: 'window.fullscreen' }

  // ─── App ─────────────────────────────────────────────────────────────────
  if (mod && shift && !alt && key === 'l') return { command: 'vault.lock' }
  if (isMac && mod && key === 'q') return { command: 'app.quit' }

  return null
}
