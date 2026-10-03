import type { OverlayRole } from '@shared/types'

/**
 * A transparent document stacked above the web content views.
 *
 * Native web views always paint above the UI renderer, so anything that must
 * overlap page content (menus, suggestions, the find bar) is rendered into a
 * separate document opened with `window.open('about:blank')`. The main
 * process wraps that document in a WebContentsView placed on top of every tab.
 *
 * Because the document is same-origin and created by this renderer, it lives
 * in the same process and the same JS realm can drive it directly: React
 * portals render into it, state is shared, no extra IPC or process is needed.
 * The main process only positions / shows / focuses the layer.
 */
export class OverlayLayer {
  private win: Window | null = null
  private root: HTMLElement | null = null
  private headObserver: MutationObserver | null = null
  private attrObserver: MutationObserver | null = null
  private syncScheduled = false

  constructor(readonly role: OverlayRole) {}

  /** The layer's window, opening it on first use. */
  get window(): Window | null {
    this.container()
    return this.win
  }

  /** Portal target inside the overlay document (recreated if the document was replaced). */
  container(): HTMLElement | null {
    if (
      this.win &&
      !this.win.closed &&
      this.root &&
      this.root.ownerDocument === this.win.document &&
      this.root.isConnected
    ) {
      return this.root
    }
    if (!this.win || this.win.closed) {
      this.win = window.open('about:blank', `aqua-overlay-${this.role}`)
      if (!this.win) return null
    }
    try {
      this.root = this.setup(this.win.document)
    } catch (err) {
      console.error(`[overlay:${this.role}] cannot access overlay document`, err)
      this.root = null
    }
    return this.root
  }

  private setup(doc: Document): HTMLElement {
    doc.title = `aqua-${this.role}`
    this.copyRootAttributes(doc)
    this.syncStyles(doc)
    doc.body.className = 'overlay-body'
    doc.body.replaceChildren()
    const root = doc.createElement('div')
    root.id = 'overlay-root'
    doc.body.appendChild(root)

    // Keep styles (Vite HMR in dev) and theme attributes in sync with the UI document.
    this.headObserver?.disconnect()
    this.headObserver = new MutationObserver(() => this.scheduleStyleSync())
    this.headObserver.observe(document.head, { childList: true, subtree: true, characterData: true })
    this.attrObserver?.disconnect()
    this.attrObserver = new MutationObserver(() => {
      if (this.win && !this.win.closed) this.copyRootAttributes(this.win.document)
    })
    this.attrObserver.observe(document.documentElement, { attributes: true })
    return root
  }

  private scheduleStyleSync(): void {
    if (this.syncScheduled) return
    this.syncScheduled = true
    requestAnimationFrame(() => {
      this.syncScheduled = false
      if (this.win && !this.win.closed) this.syncStyles(this.win.document)
    })
  }

  private syncStyles(doc: Document): void {
    doc.head.querySelectorAll('[data-overlay-style]').forEach((n) => n.remove())
    const nodes = document.head.querySelectorAll('style, link[rel="stylesheet"]')
    for (const node of nodes) {
      let copy: HTMLElement
      if (node instanceof HTMLLinkElement) {
        const link = doc.createElement('link')
        link.rel = 'stylesheet'
        link.href = node.href
        copy = link
      } else {
        const style = doc.createElement('style')
        style.textContent = node.textContent
        copy = style
      }
      copy.setAttribute('data-overlay-style', '')
      doc.head.appendChild(copy)
    }
  }

  private copyRootAttributes(doc: Document): void {
    const source = document.documentElement
    const target = doc.documentElement
    for (const attr of [...target.attributes]) if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name)
    for (const attr of [...source.attributes]) target.setAttribute(attr.name, attr.value)
    target.classList.add('overlay-document')
  }
}

export const popupLayer = new OverlayLayer('popup')
export const findLayer = new OverlayLayer('findbar')
/** Tab-modal dialogs and permission bubbles: above the find bar, below popups. */
export const modalLayer = new OverlayLayer('modal')
/** Where the link under the pointer leads (bottom-left corner of the page). */
export const statusLayer = new OverlayLayer('status')
