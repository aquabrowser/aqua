/**
 * Preload for web content in tabs (sandboxed, context-isolated, every frame).
 *
 * Before any page script runs, one synchronous request to the browser
 * (PAGE_START_CHANNEL) returns what this frame needs:
 *  - its saved localStorage, put back into the in-memory session (first-party
 *    frames of regular windows; see SiteStorageService);
 *  - element-hiding CSS and scriptlets from the filter lists.
 *
 * Isolated world (this file's own scope):
 *  - strips tracking parameters from links as they are followed;
 *  - reports ids, classes and links that appear in the DOM, for generic
 *    element hiding;
 *  - sends localStorage snapshots back as they change.
 *
 * Page world (injected with `executeInMainWorld`, before any page script):
 *  - scriptlets (uBlock Origin's, from the filter lists);
 *  - `alert()` / `confirm()` / `prompt()` open Aqua's tab-modal dialogs;
 *  - clipboard protection: no background reads or writes, no copy hijacking;
 *  - passkeys (WebAuthn) only after the user has interacted with the page.
 *
 * Replaced functions behave like the originals (same names, arities, return
 * values and error types) and the page gains no new capability: the isolated
 * side exposes nothing but one fixed, validated dialog request.
 */
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import {
  JS_DIALOG_CHANNEL,
  PAGE_COSMETICS_CHANNEL,
  PAGE_START_CHANNEL,
  PAGE_STORAGE_CHANNEL,
  type JsDialogRequest,
  type PageDomFeatures,
  type PageStart,
  type PageStorageSnapshot
} from '../shared/ipc'
import { stripTrackingParams } from '../shared/tracking'
import { installPageProtections } from './page-protections'

/** Longest message forwarded to the browser; Chrome elides long dialogs the same way. */
const MAX_MESSAGE = 16 * 1024
/** localStorage is compared with the last snapshot this often (and on hide / unload). */
const STORAGE_CHECK_MS = 5000
/** DOM reports: batch size the browser accepts, and when to stop watching a runaway page. */
const FEATURE_BATCH = 1000
const MAX_KNOWN_FEATURES = 50_000

function ask(kind: JsDialogRequest['kind'], message: string, defaultValue: string): unknown {
  const request: JsDialogRequest = {
    kind,
    message: message.slice(0, MAX_MESSAGE),
    defaultValue: defaultValue.slice(0, MAX_MESSAGE)
  }
  // Blocks this frame until the user answers, exactly like a native dialog.
  return ipcRenderer.sendSync(JS_DIALOG_CHANNEL, request)
}

function requestStart(): PageStart | null {
  try {
    return (ipcRenderer.sendSync(PAGE_START_CHANNEL) as PageStart | null) ?? null
  } catch {
    return null
  }
}

const start = requestStart()

// ─── Site storage ────────────────────────────────────────────────────────────

function readStorage(): { items: Record<string, string>; json: string } | null {
  try {
    const items: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key !== null) items[key] = localStorage.getItem(key) ?? ''
    }
    return { items, json: JSON.stringify(items) }
  } catch {
    // Storage disabled or unavailable for this document.
    return null
  }
}

/**
 * Restores the saved items - only into an empty storage: if a page of this
 * origin already holds data in this run, that data is newer.
 */
function restoreStorage(items: Record<string, string>): void {
  try {
    if (localStorage.length > 0) return
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value)
  } catch {
    // Quota or access error: the page starts without its saved data.
  }
}

/** Sends a snapshot whenever the storage differs from the last one sent (or restored). */
function keepStorage(): void {
  let last = readStorage()?.json ?? ''
  const check = (): void => {
    const now = readStorage()
    if (!now || now.json === last) return
    last = now.json
    const snapshot: PageStorageSnapshot = { origin: location.origin, items: now.items }
    ipcRenderer.send(PAGE_STORAGE_CHANNEL, snapshot)
  }
  setInterval(check, STORAGE_CHECK_MS)
  window.addEventListener('pagehide', check)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') check()
  })
}

if (start?.persistStorage) {
  if (start.storage) restoreStorage(start.storage)
  keepStorage()
}

// ─── Content blocking ────────────────────────────────────────────────────────

function insertStyles(styles: string): void {
  try {
    // User origin, as uBlock Origin injects them: page styles cannot override the hiding.
    webFrame.insertCSS(styles, { cssOrigin: 'user' })
  } catch {
    // The frame went away.
  }
}

function runScriptlets(scripts: string[]): void {
  for (const script of scripts) {
    try {
      // Synchronous and exempt from the page's CSP, like an extension's content script injection.
      contextBridge.executeInMainWorld({ func: new Function(script) as () => void })
    } catch (err) {
      console.warn('[aqua] a scriptlet failed to run:', err)
    }
  }
}

/**
 * Generic element hiding depends on what is in the DOM: ids, classes and
 * links are reported once the document is parsed and then as they appear,
 * each one only once per document.
 */
function watchDom(observe: boolean): void {
  const known = { ids: new Set<string>(), classes: new Set<string>(), hrefs: new Set<string>() }
  let knownCount = 0

  const collect = (roots: Element[]): PageDomFeatures => {
    const found: PageDomFeatures = { ids: [], classes: [], hrefs: [] }
    const add = (kind: keyof PageDomFeatures, value: string | null): void => {
      if (!value || known[kind].has(value)) return
      known[kind].add(value)
      knownCount++
      found[kind].push(value)
    }
    for (const root of roots) {
      if (!root.isConnected) continue
      for (const el of [root, ...Array.from(root.querySelectorAll('[id],[class],[href]'))]) {
        add('ids', el.getAttribute('id'))
        for (const name of Array.from(el.classList)) add('classes', name)
        add('hrefs', el.getAttribute('href'))
      }
    }
    return found
  }

  const report = (features: PageDomFeatures): void => {
    for (let i = 0; ; i += FEATURE_BATCH) {
      const batch: PageDomFeatures = {
        ids: features.ids.slice(i, i + FEATURE_BATCH),
        classes: features.classes.slice(i, i + FEATURE_BATCH),
        hrefs: features.hrefs.slice(i, i + FEATURE_BATCH)
      }
      if (batch.ids.length + batch.classes.length + batch.hrefs.length === 0) return
      ipcRenderer.invoke(PAGE_COSMETICS_CHANNEL, batch).then(
        (styles: unknown) => {
          if (typeof styles === 'string' && styles) insertStyles(styles)
        },
        () => undefined
      )
    }
  }

  const begin = (): void => {
    const root = document.documentElement
    if (!root) return
    report(collect([root]))
    if (!observe) return

    let pending: Element[] = []
    let delay = 0
    let maxWait = 0
    const flush = (): void => {
      window.clearTimeout(delay)
      window.clearTimeout(maxWait)
      delay = maxWait = 0
      const roots = pending
      pending = []
      report(collect(roots))
      // A page that keeps inventing names (random class names) is not followed forever.
      if (knownCount > MAX_KNOWN_FEATURES) observer.disconnect()
    }
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          if (mutation.target instanceof Element) pending.push(mutation.target)
        } else {
          for (const node of Array.from(mutation.addedNodes)) if (node instanceof Element) pending.push(node)
        }
      }
      if (pending.length > 512) return flush()
      window.clearTimeout(delay)
      delay = window.setTimeout(flush, 25)
      if (!maxWait) maxWait = window.setTimeout(flush, 1000)
    })
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['id', 'class', 'href'],
      childList: true,
      subtree: true
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin, { once: true })
  else begin()
}

if (start?.cosmetics) {
  if (start.cosmetics.styles) insertStyles(start.cosmetics.styles)
  runScriptlets(start.cosmetics.scripts)
  watchDom(start.cosmetics.observe)
}

// ─── Tracking parameters on links ────────────────────────────────────────────

/**
 * Cleans a link's address just before the browser acts on it - click,
 * middle-click, or the context menu's "Open link in new tab". Rewriting the
 * element (rather than re-issuing the navigation) keeps everything else about
 * the navigation intact: target, referrer policy, `download`, opener rules.
 */
function cleanLink(event: Event): void {
  if (!start?.stripTrackingParams || !(event.target instanceof Element)) return
  const link = event.target.closest('a[href], area[href]')
  if (!(link instanceof HTMLAnchorElement) && !(link instanceof HTMLAreaElement)) return
  const cleaned = stripTrackingParams(link.href)
  if (cleaned) link.href = cleaned
}
for (const type of ['click', 'auxclick', 'contextmenu'] as const) window.addEventListener(type, cleanLink, true)

// ─── Page world ──────────────────────────────────────────────────────────────

try {
  contextBridge.executeInMainWorld({
    func: installPageProtections,
    args: [
      (kind: string, message: string, defaultValue: string) =>
        kind === 'alert' || kind === 'confirm' || kind === 'prompt'
          ? ask(kind, String(message), String(defaultValue))
          : null
    ]
  })
} catch (err) {
  // Leaves the built-in behaviour in place; the page keeps working.
  console.warn('[aqua] page protections unavailable:', err)
}
