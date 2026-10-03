import { net, protocol, session, type Session } from 'electron'
import { resolve, sep } from 'path'
import { pathToFileURL } from 'url'

export const UI_SCHEME = 'aqua-ui'
export const UI_HOST = 'app'
export const INTERNAL_SCHEME = 'aqua'
/** Neutered stand-ins for blocked scripts, images and frames (see ContentBlockerService). */
export const RESOURCE_SCHEME = 'aqua-resource'

/** Must run before `app.whenReady()`. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    // Internal pages (aqua://settings …). Standard + secure so they get a real
    // origin and never trigger mixed-content downgrades.
    { scheme: INTERNAL_SCHEME, privileges: { standard: true, secure: true } },
    // The production UI bundle, instead of file:// (Electron security checklist #18).
    { scheme: UI_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
    // Blocked requests are redirected here, like uBlock Origin's web-accessible resources: exempt
    // from the page's CSP (the page never asked for these URLs) and readable cross-origin.
    {
      scheme: RESOURCE_SCHEME,
      privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

const INTERNAL_TITLES: Record<string, string> = {
  newtab: 'New Tab',
  settings: 'Settings',
  history: 'History',
  downloads: 'Downloads'
}

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Favicons come from arbitrary sites; the UI session is cookie-less.
  "img-src 'self' data: https: http:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * `aqua://<page>` in the browsing session serves an inert placeholder document.
 * The real page is drawn by the browser UI in the content area while the tab's
 * web view is hidden; the placeholder exists so internal pages are genuine
 * history entries (Back from a site returns to the New Tab page, etc.).
 * Installed on every browsing session, private windows' included.
 */
export function installInternalProtocol(target: Session = session.defaultSession): void {
  target.protocol.handle(INTERNAL_SCHEME, (request) => {
    const page = new URL(request.url).hostname
    const title = INTERNAL_TITLES[page] ?? 'Aqua'
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      '<meta name="color-scheme" content="light dark">' +
      '<style>html{background:#fff}@media (prefers-color-scheme:dark){html{background:#1f2023}}</style>' +
      '</head><body></body></html>'
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'cache-control': 'no-store'
      }
    })
  })
}

/** Serves the built renderer from `rendererDir` as `aqua-ui://app/…` with a strict CSP. */
export function installUiProtocol(uiSession: Session, rendererDir: string): void {
  const root = resolve(rendererDir)
  uiSession.protocol.handle(UI_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== UI_HOST) return new Response('Not found', { status: 404 })
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const file = resolve(root, relative)
    if (file !== root && !file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 })

    const response = await net.fetch(pathToFileURL(file).href)
    const headers = new Headers(response.headers)
    headers.set('x-content-type-options', 'nosniff')
    if (file.endsWith('.html')) {
      headers.set('content-security-policy', UI_CSP)
      headers.set('content-type', 'text/html; charset=utf-8')
    }
    return new Response(response.body, { status: response.status, headers })
  })
}
