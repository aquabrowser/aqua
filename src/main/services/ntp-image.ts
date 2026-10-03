import { dialog, session, type BrowserWindow } from 'electron'
import { readFile, stat } from 'fs/promises'
import type { ImageResult } from '../../shared/types'
import { MAX_BACKGROUND_BYTES, sniffImage, toDataUrl } from '../lib/image'
import { Signal } from '../lib/signal'
import type { EncryptedDocument, VaultDatabase } from '../storage/database'

interface ImageFile {
  version: 1
  /** The picture as a data: URL, or null. */
  dataUrl: string | null
}

const DOWNLOAD_TIMEOUT_MS = 20_000
/** An in-memory session used only for these downloads (not a partition any page uses). */
const DOWNLOAD_PARTITION = 'aqua-picture-download'
const TOO_BIG = `That picture is larger than ${MAX_BACKGROUND_BYTES / 1024 / 1024} MB.`
const NOT_AN_IMAGE = 'That isn’t a PNG, JPEG, WebP or GIF picture.'

/**
 * The New Tab page's own background picture. It is copied into the vault
 * (encrypted like everything else) when it is chosen: a picture from a web
 * address is downloaded once, so opening a New Tab page never contacts that
 * server and works offline.
 */
export class NtpImageService {
  readonly changed = new Signal<void>()
  private readonly doc: EncryptedDocument<ImageFile>

  constructor(db: VaultDatabase) {
    this.doc = db.document<ImageFile>('ntp-image', {
      defaults: () => ({ version: 1, dataUrl: null }),
      sanitize: (raw) => {
        const url = (raw as Partial<ImageFile> | null)?.dataUrl
        const valid = typeof url === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(url)
        return { version: 1, dataUrl: valid ? url : null }
      },
      debounceMs: 0
    })
  }

  get(): string | null {
    return this.doc.value.dataUrl
  }

  /** Asks for a picture on this computer. */
  async chooseFile(window: BrowserWindow): Promise<ImageResult | null> {
    const choice = await dialog.showOpenDialog(window, {
      title: 'Choose a background picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    const file = choice.filePaths[0]
    if (choice.canceled || !file) return null
    try {
      if ((await stat(file)).size > MAX_BACKGROUND_BYTES) return { ok: false, error: TOO_BIG }
      return this.store(await readFile(file))
    } catch {
      return { ok: false, error: 'That file couldn’t be read.' }
    }
  }

  /**
   * Downloads a picture from the web, once. Chromium's network stack takes the
   * same route as browsing (system proxy or VPN included), from a session of
   * its own: no browsing cookies are sent and nothing is kept on disk.
   */
  async fromUrl(address: string): Promise<ImageResult> {
    let url: URL
    try {
      url = new URL(address)
    } catch {
      return { ok: false, error: 'That isn’t a web address.' }
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return { ok: false, error: 'Use an http or https address.' }
    try {
      const response = await session.fromPartition(DOWNLOAD_PARTITION, { cache: false }).fetch(url.href, {
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      })
      if (!response.ok || !response.body) return { ok: false, error: `The server returned error ${response.status}.` }
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_BACKGROUND_BYTES) return { ok: false, error: TOO_BIG }
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength
        if (size > MAX_BACKGROUND_BYTES) return { ok: false, error: TOO_BIG }
        chunks.push(chunk)
      }
      return this.store(Buffer.concat(chunks))
    } catch {
      return { ok: false, error: 'The picture couldn’t be downloaded.' }
    }
  }

  clear(): void {
    if (!this.doc.value.dataUrl) return
    this.doc.set({ version: 1, dataUrl: null })
    this.doc.flush()
    this.changed.emit()
  }

  private store(bytes: Uint8Array): ImageResult {
    const mime = sniffImage(bytes)
    if (!mime) return { ok: false, error: NOT_AN_IMAGE }
    this.doc.set({ version: 1, dataUrl: toDataUrl(bytes, mime) })
    this.doc.flush()
    this.changed.emit()
    return { ok: true }
  }
}
