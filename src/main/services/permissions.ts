import {
  desktopCapturer,
  webContents as allWebContents,
  type DesktopCapturerSource,
  type DisplayMediaRequestHandlerHandlerRequest,
  type PermissionCheckHandlerHandlerDetails,
  type PermissionRequest,
  type Session,
  type Streams,
  type WebContents
} from 'electron'
import type {
  CaptureSource,
  PermissionDecision,
  PermissionDefaults,
  PermissionKind,
  PromptRequest,
  PromptResponse,
  SitePermission
} from '../../shared/types'
import type { EncryptedDocument, VaultDatabase } from '../storage/database'
import type { SettingsService } from './settings'

type DecisionMap = Record<string, Partial<Record<PermissionKind, PermissionDecision>>>

/** Asks the user in the tab that made the request; resolves `null` if there is no such tab any more. */
export interface PromptHost {
  ask(webContents: WebContents, request: PromptPayload): Promise<PromptResponse | null>
}

export type PromptPayload = DistributiveOmit<PromptRequest, 'id' | 'tabId'>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Granted silently: low-risk and required for ordinary web apps. */
const AUTO_ALLOW = new Set([
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
  'keyboardLock',
  'speaker-selection'
])

/** How long a dismissed permission request stays quiet before the page may ask again. */
const DISMISS_EMBARGO_MS = 30_000
/** Screen sharing picker: preview size, and at most this many screens and windows offered. */
const CAPTURE_THUMBNAIL = { width: 320, height: 180 }
const MAX_CAPTURE_SOURCES = 40

const KINDS: readonly PermissionKind[] = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'midi',
  'clipboard-read'
]

/** Which of our permission kinds an Electron permission request needs. */
function kindsFor(permission: string, mediaTypes: readonly string[] | undefined): PermissionKind[] {
  switch (permission) {
    case 'media': {
      const kinds: PermissionKind[] = []
      if (mediaTypes?.includes('video')) kinds.push('camera')
      if (mediaTypes?.includes('audio')) kinds.push('microphone')
      return kinds
    }
    case 'geolocation':
      return ['geolocation']
    case 'notifications':
      return ['notifications']
    case 'midi':
    case 'midiSysex':
      return ['midi']
    case 'clipboard-read':
      return ['clipboard-read']
    default:
      return []
  }
}

export function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.origin === 'null' ? null : parsed.origin
  } catch {
    return null
  }
}

/**
 * Capability permissions. Every request is resolved in this order:
 *   1. a saved per-site decision,
 *   2. the global default (Settings → Site permissions) when it is "block",
 *   3. otherwise the user is asked in an Aqua prompt anchored to the tab.
 * Unknown / unsupported permissions (USB, serial, HID, …) are always denied.
 */
export class PermissionService {
  private readonly store: EncryptedDocument<DecisionMap>
  /** Concurrent identical requests share one prompt instead of stacking. */
  private readonly inFlight = new Map<string, Promise<PromptResponse | null>>()
  /** A request the user dismissed is not asked again right away (per page, origin and kinds). */
  private readonly dismissed = new Map<string, number>()

  constructor(
    db: VaultDatabase,
    private readonly settings: SettingsService,
    private readonly prompts: PromptHost,
    private readonly isOpen: () => boolean
  ) {
    this.store = db.document('site-permissions', {
      defaults: () => ({}),
      sanitize: (raw) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
        const out: DecisionMap = {}
        for (const [origin, decisions] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof decisions !== 'object' || decisions === null) continue
          const clean: Partial<Record<PermissionKind, PermissionDecision>> = {}
          for (const kind of KINDS) {
            const d = (decisions as Record<string, unknown>)[kind]
            if (d === 'allow' || d === 'block') clean[kind] = d
          }
          // Pre-vault files stored camera+microphone as a single "media" decision.
          const media = (decisions as Record<string, unknown>).media
          if (media === 'allow' || media === 'block') clean.camera = clean.microphone = media
          if (Object.keys(clean).length) out[origin] = clean
        }
        return out
      }
    })
  }

  /**
   * `private`: a private window's session. It inherits the sites you blocked,
   * but not the ones you allowed, and answers given there are kept in memory
   * for that window only - never written to the vault.
   */
  attach(session: Session, options: { private?: boolean } = {}): void {
    const memory: DecisionMap | null = options.private ? {} : null
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      void this.request(webContents, permission, details, memory).then(callback, () => callback(false))
    })
    session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
      this.check(permission, requestingOrigin, details, memory)
    )
    // getDisplayMedia(): Electron has no picker of its own. The callback is answered exactly once on
    // every path - an unanswered request would leave the page's promise pending forever.
    session.setDisplayMediaRequestHandler((request, callback) => {
      let answered = false
      const reply = (streams: Streams): void => {
        if (answered) return
        answered = true
        try {
          callback(streams)
        } catch (err) {
          // The frame went away before the answer (it navigated or its tab closed).
          console.warn('[permissions] screen sharing answer not delivered:', (err as Error).message)
        }
      }
      this.displayMedia(request).then(reply, (err) => {
        console.warn('[permissions] screen sharing failed:', err)
        reply({})
      })
    })
  }

  list(): SitePermission[] {
    const out: SitePermission[] = []
    for (const [origin, decisions] of Object.entries(this.store.value)) {
      for (const [permission, decision] of Object.entries(decisions)) {
        if (decision) out.push({ origin, permission: permission as PermissionKind, decision })
      }
    }
    return out.sort((a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission))
  }

  forOrigin(origin: string): SitePermission[] {
    return this.list().filter((p) => p.origin === origin)
  }

  reset(origin: string, permission: PermissionKind): void {
    this.store.update((map) => {
      const next = { ...map }
      const entry = { ...(next[origin] ?? {}) }
      delete entry[permission]
      if (Object.keys(entry).length) next[origin] = entry
      else delete next[origin]
      return next
    })
  }

  importLegacy(raw: unknown): void {
    this.store.importRaw(raw)
  }

  flushSync(): void {
    this.store.flushSync()
  }

  /** The saved decision that applies: a private window's own answers, else the vault's (blocks only there). */
  private saved(origin: string, kind: PermissionKind, memory: DecisionMap | null): PermissionDecision | undefined {
    const stored = this.store.value[origin]?.[kind]
    if (!memory) return stored
    return memory[origin]?.[kind] ?? (stored === 'block' ? 'block' : undefined)
  }

  private effective(origin: string, kind: PermissionKind, memory: DecisionMap | null): 'allow' | 'block' | 'ask' {
    const saved = this.saved(origin, kind, memory)
    if (saved) return saved
    const defaults = this.settings.get().permissionDefaults
    if (kind in defaults && defaults[kind as keyof PermissionDefaults] === 'block') return 'block'
    return 'ask'
  }

  private async request(
    webContents: WebContents,
    permission: string,
    details: PermissionRequest,
    memory: DecisionMap | null
  ): Promise<boolean> {
    if (AUTO_ALLOW.has(permission)) return true
    // Screen sharing asks here first - as "media" with no camera or microphone in it (Electron
    // 44), or "display-capture". Let it through to the picker (see displayMedia), where the user
    // chooses, or refuses, every time: nothing is shared without that choice.
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes
    if (permission === 'display-capture' || (permission === 'media' && mediaTypes?.length === 0))
      return this.isOpen() && !webContents.isDestroyed()
    // The clipboard is only ever readable by the page the user is looking at (and the
    // tab preload also demands a click or keypress for each read).
    if (permission === 'clipboard-read' && !webContents.isFocused()) return false
    const kinds = kindsFor(permission, (details as { mediaTypes?: string[] }).mediaTypes)
    const origin = originOf(details.requestingUrl)
    if (kinds.length === 0 || !origin || !this.isOpen() || webContents.isDestroyed()) return false

    const states = kinds.map((k) => this.effective(origin, k, memory))
    if (states.includes('block')) return false
    const pending = kinds.filter((_, i) => states[i] === 'ask')
    if (pending.length === 0) return true

    const key = `${webContents.id}|${origin}|${pending.join(',')}`
    const dismissedAt = this.dismissed.get(key)
    if (dismissedAt !== undefined) {
      if (Date.now() - dismissedAt < DISMISS_EMBARGO_MS) return false
      this.dismissed.delete(key)
    }
    let answer = this.inFlight.get(key)
    if (!answer) {
      answer = this.prompts.ask(webContents, { kind: 'permission', origin, permissions: pending })
      this.inFlight.set(key, answer)
      void answer.finally(() => this.inFlight.delete(key))
    }
    const response = await answer
    if (response?.kind === 'permission' && response.decision === 'dismiss') {
      this.dismissed.set(key, Date.now())
      if (this.dismissed.size > 200) this.dismissed.delete(this.dismissed.keys().next().value!)
    }
    if (!response || response.kind !== 'permission' || response.decision === 'dismiss') return false
    for (const kind of pending) {
      if (memory) memory[origin] = { ...memory[origin], [kind]: response.decision }
      else this.save(origin, kind, response.decision)
    }
    return response.decision === 'allow'
  }

  /** Tabs with a screen sharing picker open: one at a time, further requests are refused. */
  private readonly capturing = new Set<number>()

  /**
   * Screen sharing: the user picks a screen or window in the tab, every time -
   * the choice is never remembered, as in Chrome. Refused without a click or
   * keypress (Chromium demands one too) and while locked.
   */
  private async displayMedia(request: DisplayMediaRequestHandlerHandlerRequest): Promise<Streams> {
    const frame = request.frame
    const contents = frame ? allWebContents.fromFrame(frame) : undefined
    const origin = originOf(request.securityOrigin)
    if (!contents || contents.isDestroyed() || !origin || !this.isOpen()) return {}
    if (!request.videoRequested || !request.userGesture || this.capturing.has(contents.id)) return {}
    this.capturing.add(contents.id)
    const id = contents.id
    try {
      const sources = (
        await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: CAPTURE_THUMBNAIL,
          fetchWindowIcons: true
        })
      ).slice(0, MAX_CAPTURE_SOURCES)
      if (sources.length === 0 || contents.isDestroyed()) return {}
      const response = await this.prompts.ask(contents, {
        kind: 'display-capture',
        origin,
        audio: request.audioRequested,
        sources: sources.map(toCaptureSource)
      })
      if (response?.kind !== 'display-capture' || !response.sourceId) return {}
      // Only what was offered: the answer comes from the UI renderer.
      const source = sources.find((s) => s.id === response.sourceId)
      if (!source) return {}
      // System audio can come with a whole screen (Windows loopback capture), as Chrome offers it.
      const loopback =
        response.audio && request.audioRequested && source.id.startsWith('screen:') && process.platform === 'win32'
      return { video: { id: source.id, name: source.name }, ...(loopback ? { audio: 'loopback' as const } : {}) }
    } finally {
      this.capturing.delete(id)
    }
  }

  private check(
    permission: string,
    requestingOrigin: string,
    details: PermissionCheckHandlerHandlerDetails,
    memory: DecisionMap | null
  ): boolean {
    if (AUTO_ALLOW.has(permission)) return true
    const mediaType = (details as { mediaType?: string }).mediaType
    const kinds = kindsFor(permission, mediaType ? [mediaType] : ['video', 'audio'])
    const origin = originOf(requestingOrigin)
    if (kinds.length === 0 || !origin || !this.isOpen()) return false
    return kinds.every((k) => this.saved(origin, k, memory) === 'allow')
  }

  private save(origin: string, kind: PermissionKind, decision: PermissionDecision): void {
    this.store.update((map) => ({ ...map, [origin]: { ...(map[origin] ?? {}), [kind]: decision } }))
  }
}

function toCaptureSource(source: DesktopCapturerSource): CaptureSource {
  const thumbnail = source.thumbnail.isEmpty()
    ? ''
    : `data:image/jpeg;base64,${source.thumbnail.toJPEG(75).toString('base64')}`
  const icon = source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.resize({ width: 32 }).toDataURL() : null
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail,
    icon
  }
}
