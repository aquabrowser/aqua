import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { installPageProtections } from '../preload/page-protections.ts'

/**
 * A scripted stand-in for a page's world: only the web APIs the protections
 * wrap, recording what reaches the "browser". The real function is the one
 * the tab preload serialises into every page.
 */
interface Page {
  activation: { isActive: boolean; hasBeenActive: boolean }
  dialogs: Array<[string, string, string]>
  clipboardWrites: string[]
  /** Makes credential requests stay open until the returned function is called. */
  holdCredentials(): () => void
  credentialCalls: unknown[]
  /** A trusted copy of `selection`, then runs page `handler` as a later copy listener would. */
  copy(selection: string, handler?: (data: FakeDataTransfer) => void): FakeDataTransfer
  window: Record<string, unknown> & {
    alert: (...args: unknown[]) => unknown
    confirm: (...args: unknown[]) => unknown
    prompt: (...args: unknown[]) => unknown
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<void>
    write(items: unknown[]): Promise<void>
  }
  credentials: { get(options?: unknown): Promise<unknown>; create(options?: unknown): Promise<unknown> }
  PublicKeyCredential: {
    isConditionalMediationAvailable(): Promise<boolean>
    getClientCapabilities(): Promise<Record<string, boolean>>
  }
}

interface FakeDataTransfer {
  data: Map<string, string>
  setData(format: string, value: string): void
}

const saved = { window: globalThis.window, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') }
const quiet = console.warn

/** The page's clock (`performance.now()`), moved by hand in tests about timing. */
let clock = 0
const advance = (ms: number): void => {
  clock += ms
}

function page(answer: (kind: string, message: string, defaultValue: string) => unknown = () => null): Page {
  const listeners = new Map<string, Array<(event: { isTrusted: boolean }) => void>>()
  let selection = ''
  const activation = { isActive: false, hasBeenActive: false }
  const dialogs: Page['dialogs'] = []
  const clipboardWrites: string[] = []
  const credentialCalls: unknown[] = []
  let heldCredential: Promise<unknown> | null = null

  class DataTransfer {
    data = new Map<string, string>()
    setData(format: string, value: string): void {
      this.data.set(format, value)
    }
  }
  class Clipboard {
    readText(): Promise<string> {
      return Promise.resolve('clipboard text')
    }
    read(): Promise<unknown[]> {
      return Promise.resolve([])
    }
    writeText(text: string): Promise<void> {
      clipboardWrites.push(text)
      return Promise.resolve()
    }
    write(): Promise<void> {
      clipboardWrites.push('<items>')
      return Promise.resolve()
    }
  }
  class CredentialsContainer {
    get(options?: unknown): Promise<unknown> {
      credentialCalls.push(options)
      return heldCredential ?? Promise.resolve('credential')
    }
    create(options?: unknown): Promise<unknown> {
      credentialCalls.push(options)
      return Promise.resolve('created')
    }
  }
  class PublicKeyCredential {
    static isConditionalMediationAvailable(): Promise<boolean> {
      return Promise.resolve(true)
    }
    static getClientCapabilities(): Promise<Record<string, boolean>> {
      return Promise.resolve({ conditionalGet: true, conditionalCreate: true, hybridTransport: true })
    }
  }

  const win = {
    addEventListener(type: string, listener: (event: { isTrusted: boolean }) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    getSelection: () => ({ toString: () => selection }),
    DataTransfer,
    Clipboard,
    CredentialsContainer,
    PublicKeyCredential,
    alert: () => undefined,
    confirm: () => false,
    prompt: () => null
  }
  ;(globalThis as Record<string, unknown>).window = win
  Object.defineProperty(globalThis, 'navigator', { value: { userActivation: activation }, configurable: true })
  ;(globalThis as Record<string, unknown>).DOMParser = class {
    parseFromString(html: string) {
      return { body: { textContent: html.replace(/<[^>]*>/g, '') } }
    }
  }

  installPageProtections((kind, message, defaultValue) => {
    dialogs.push([kind, message, defaultValue])
    return answer(kind, message, defaultValue)
  })

  return {
    activation,
    dialogs,
    clipboardWrites,
    holdCredentials() {
      let release: () => void = () => undefined
      heldCredential = new Promise((resolve) => {
        release = () => {
          heldCredential = null
          resolve('credential')
        }
      })
      return () => release()
    },
    credentialCalls,
    window: win,
    clipboard: new Clipboard(),
    credentials: new CredentialsContainer(),
    PublicKeyCredential,
    copy(text, handler) {
      selection = text
      const data = new DataTransfer()
      const event = { isTrusted: true, defaultPrevented: false }
      for (const listener of listeners.get('copy') ?? []) listener(event)
      handler?.(data)
      return data
    }
  }
}

beforeEach(() => {
  console.warn = () => undefined
  clock = 1_000_000
  Object.defineProperty(performance, 'now', { value: () => clock, configurable: true, writable: true })
})
afterEach(() => {
  console.warn = quiet
  delete (performance as { now?: unknown }).now
  ;(globalThis as Record<string, unknown>).window = saved.window
  if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator)
})

// Payment details are what clipboard hijackers go after: the user's IBAN and the attacker's.
const IBAN = 'DE89 3704 0044 0532 0130 00'
const ATTACKER = 'GB29 NWBK 6016 1331 9268 19'

// ─── Copy hijacking ─────────────────────────────────────────────────────────

test('a copy handler cannot swap copied payment details', () => {
  const p = page()
  const data = p.copy(`Send to ${IBAN}`, (d) => d.setData('text/plain', ATTACKER))
  assert.equal(data.data.get('text/plain'), `Send to ${IBAN}`)
})

test('a swapped HTML payload is replaced with the escaped selection', () => {
  const p = page()
  const data = p.copy('Pay <b>me</b> at ' + IBAN, (d) => d.setData('text/html', `<p>${ATTACKER}</p>`))
  assert.equal(data.data.get('text/html'), `Pay &lt;b&gt;me&lt;/b&gt; at ${IBAN}`)
})

test('ordinary text cannot be swapped for unrelated text', () => {
  const p = page()
  const data = p.copy('The quick brown fox jumps over the lazy dog', (d) =>
    d.setData('text/plain', 'Visit totally-legit-prizes.example now')
  )
  assert.equal(data.data.get('text/plain'), 'The quick brown fox jumps over the lazy dog')
})

test('legitimate copy handlers keep working', () => {
  const p = page()
  const attribution = p.copy('The quick brown fox', (d) =>
    d.setData('text/plain', 'The quick brown fox\n- Read more at example.com')
  )
  assert.equal(attribution.data.get('text/plain'), 'The quick brown fox\n- Read more at example.com')
  // Editors re-serialise the selection (whitespace, formatting): still the same words.
  const editor = p.copy('const   answer =\n  42', (d) => d.setData('text/plain', 'const answer = 42'))
  assert.equal(editor.data.get('text/plain'), 'const answer = 42')
  // Nothing selected: the app decides what "copy" means (canvas editors, spreadsheets).
  const app = p.copy('', (d) => d.setData('text/plain', 'shape #3'))
  assert.equal(app.data.get('text/plain'), 'shape #3')
})

test('protection only applies while a real copy event is dispatching', async () => {
  const p = page()
  p.copy(`Send to ${IBAN}`)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const later = new (p.window.DataTransfer as new () => FakeDataTransfer)()
  later.setData('text/plain', ATTACKER)
  assert.equal(later.data.get('text/plain'), ATTACKER)
})

test('writeText right after a copy cannot overwrite it; later writes need a gesture', async () => {
  const p = page()
  p.activation.isActive = true
  p.copy(IBAN)
  await p.clipboard.writeText(ATTACKER)
  assert.deepEqual(p.clipboardWrites, [IBAN])

  p.activation.isActive = false
  await assert.rejects(p.clipboard.writeText('anything'), { name: 'NotAllowedError' })
  await assert.rejects(p.clipboard.write([]), { name: 'NotAllowedError' })
})

test('clipboard reads need a click or keypress', async () => {
  const p = page()
  await assert.rejects(p.clipboard.readText(), { name: 'NotAllowedError' })
  p.activation.isActive = true
  assert.equal(await p.clipboard.readText(), 'clipboard text')
})

// ─── Passkeys ───────────────────────────────────────────────────────────────

const publicKey = { challenge: new Uint8Array(32) }

test('passkey autofill (conditional mediation) never prompts and ends when aborted', async () => {
  const p = page()
  assert.equal(await p.PublicKeyCredential.isConditionalMediationAvailable(), false)
  assert.equal((await p.PublicKeyCredential.getClientCapabilities()).conditionalGet, false)
  const controller = new AbortController()
  const request = p.credentials.get({ publicKey, mediation: 'conditional', signal: controller.signal })
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  assert.equal(p.credentialCalls.length, 0)
})

test('a passkey prompt on page load is refused; right after a click it goes through', async () => {
  const p = page()
  await assert.rejects(p.credentials.get({ publicKey }), { name: 'NotAllowedError' })
  await assert.rejects(p.credentials.create({ publicKey }), { name: 'NotAllowedError' })
  // Having interacted at some point is not enough: the system dialog needs a fresh click or keypress.
  p.activation.hasBeenActive = true
  await assert.rejects(p.credentials.get({ publicKey }), { name: 'NotAllowedError' })
  assert.equal(p.credentialCalls.length, 0)
  p.activation.isActive = true
  assert.equal(await p.credentials.get({ publicKey }), 'credential')
  // Other credential types are untouched.
  const q = page()
  assert.equal(await q.credentials.get({ password: true }), 'credential')
})

// ─── Dialogs ────────────────────────────────────────────────────────────────

test('dialogs reach Aqua with native argument handling and return values', () => {
  const p = page((kind) => (kind === 'confirm' ? true : kind === 'prompt' ? 'Ada' : null))
  p.window.alert()
  p.window.alert(undefined)
  assert.equal(p.window.confirm('Sure?'), true)
  assert.equal(p.window.prompt('Name?', 'Grace'), 'Ada')
  assert.deepEqual(p.dialogs, [
    ['alert', '', ''],
    ['alert', 'undefined', ''],
    ['confirm', 'Sure?', ''],
    ['prompt', 'Name?', 'Grace']
  ])
  assert.throws(() => p.window.alert(Symbol('x')), TypeError)
})

test('replaced functions look native to the page', () => {
  const p = page()
  assert.equal(String(p.window.alert), 'function alert() { [native code] }')
  assert.equal(p.window.alert.name, 'alert')
  assert.equal(String(p.credentials.get), 'function get() { [native code] }')
})

// ─── Rich clipboard writes ──────────────────────────────────────────────────

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
const item = (text: string, type = 'text/plain') => ({
  types: [type],
  getType: () => Promise.resolve(new Blob([text], { type }))
})

test('clipboard.write right after a copy cannot swap it either', async () => {
  const p = page()
  p.activation.isActive = true
  p.copy(`Pay to ${IBAN}`)
  await assert.rejects(p.clipboard.write([item(ATTACKER)]), { name: 'NotAllowedError' })
  await assert.rejects(p.clipboard.write([item(`<b>${ATTACKER}</b>`, 'text/html')]), { name: 'NotAllowedError' })
  // The same text (re-serialised) and anything written later go through.
  await p.clipboard.write([item(`Pay to ${IBAN}`)])
  advance(2000)
  await p.clipboard.write([item(ATTACKER)])
  assert.deepEqual(p.clipboardWrites, ['<items>', '<items>'])
  await tick()
})

// ─── Flood protection ───────────────────────────────────────────────────────

test('passkey prompts come one at a time, with a pause after each', async () => {
  const p = page()
  p.activation.isActive = true
  const release = p.holdCredentials()
  const first = p.credentials.get({ publicKey })
  await assert.rejects(p.credentials.get({ publicKey }), { name: 'NotAllowedError' }, 'second while the first is open')
  release()
  assert.equal(await first, 'credential')
  await tick()
  await assert.rejects(p.credentials.get({ publicKey }), { name: 'NotAllowedError' }, 'straight after the first closed')
  advance(1600)
  assert.equal(await p.credentials.get({ publicKey }), 'credential')
  assert.equal(p.credentialCalls.length, 2)
})
