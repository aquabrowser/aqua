/**
 * Protections installed in every page's own JavaScript world (see tab.ts).
 *
 * This function is serialised by `contextBridge.executeInMainWorld` and runs
 * in the page before any of its scripts, so it must be self-contained: it may
 * use only its parameters and web platform globals - no imports, no closures.
 */
export function installPageProtections(
  dialogBridge: (kind: string, message: string, defaultValue: string) => unknown
): void {
  type Method = (this: unknown, ...args: unknown[]) => unknown

  /** Replaces `target[name]`, keeping its name, arity, property flags and a native-looking toString. */
  const replace = (target: object | undefined, name: string, make: (original: Method) => Method): void => {
    if (!target) return
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    const original = descriptor?.value as Method | undefined
    if (typeof original !== 'function') return
    const impl = make(original)
    const fn = {
      [name](this: unknown, ...args: unknown[]) {
        return impl.apply(this, args)
      }
    }[name]
    const source = `function ${name}() { [native code] }`
    Object.defineProperty(fn, 'length', { value: original.length })
    Object.defineProperty(fn, 'toString', {
      value: function toString() {
        return source
      },
      writable: true,
      configurable: true,
      enumerable: false
    })
    Object.defineProperty(target, name, {
      value: fn,
      writable: descriptor?.writable ?? true,
      enumerable: descriptor?.enumerable ?? true,
      configurable: true
    })
  }
  const refuse = (message: string): Promise<never> => Promise.reject(new DOMException(message, 'NotAllowedError'))
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } })
    .userActivation

  // ── Dialogs ────────────────────────────────────────────────────────────
  // WebIDL DOMString conversion: throws on symbols, like the native functions.
  const text = (value: unknown): string => `${value as string}`
  // alert() and alert(undefined) differ: the latter shows "undefined".
  replace(
    window,
    'alert',
    () =>
      function (...args) {
        dialogBridge('alert', args.length === 0 ? '' : text(args[0]), '')
      }
  )
  replace(
    window,
    'confirm',
    () =>
      function (...args) {
        return dialogBridge('confirm', args[0] === undefined ? '' : text(args[0]), '') === true
      }
  )
  replace(
    window,
    'prompt',
    () =>
      function (...args) {
        const message = args[0] === undefined ? '' : text(args[0])
        const defaultValue = args[1] === undefined ? '' : text(args[1])
        const result = dialogBridge('prompt', message, defaultValue)
        return typeof result === 'string' ? result : null
      }
  )

  // ── Clipboard ──────────────────────────────────────────────────────────
  const squash = (value: string): string => value.replace(/\s+/g, ' ').trim()
  /**
   * Would putting `written` on the clipboard replace what the user selected
   * with something else? Adding to the selection (attribution lines) or
   * trimming it is fine; swapping it for different text is not.
   */
  const swaps = (selection: string, written: string): boolean => {
    const s = squash(selection)
    const w = squash(written)
    if (!s || !w || w.includes(s) || s.includes(w)) return false
    const words = s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)
    if (!words) return false
    const haystack = w.toLowerCase()
    return words.filter((word) => haystack.includes(word)).length / words.length < 0.5
  }
  const visibleText = (html: string): string =>
    new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  const escapeHtml = (value: string): string =>
    value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
  let lastWarning = -Infinity
  const warn = (): void => {
    if (performance.now() - lastWarning < 2000) return
    lastWarning = performance.now()
    console.warn('[Aqua] Blocked this page from replacing the text you copied. Your selection was copied instead.')
  }

  /** The user's most recent copy/cut: what was selected, when, and whether the event is still dispatching. */
  let copy: { selection: string; at: number; dispatching: boolean; swapped: boolean } | null = null
  const RECENT_COPY_MS = 1500
  const recentCopy = (): typeof copy => (copy && performance.now() - copy.at < RECENT_COPY_MS ? copy : null)
  const onCopy = (event: Event): void => {
    if (!event.isTrusted) return
    const current = {
      selection: String(window.getSelection() ?? ''),
      at: performance.now(),
      dispatching: true,
      swapped: false
    }
    copy = current
    // Runs once every listener of this event has returned.
    setTimeout(() => {
      current.dispatching = false
    }, 0)
  }
  // Registered before any page script, so this runs before every page listener.
  window.addEventListener('copy', onCopy, true)
  window.addEventListener('cut', onCopy, true)

  // A copy handler may add to the selection but not swap it out.
  replace(
    window.DataTransfer?.prototype,
    'setData',
    (original) =>
      function (this: unknown, ...args) {
        const current = copy
        const format = typeof args[0] === 'string' ? args[0].toLowerCase() : ''
        if (current?.dispatching && (format === 'text/plain' || format === 'text' || format === 'text/html')) {
          const html = format === 'text/html'
          const written = String(args[1])
          if (current.swapped || swaps(current.selection, html ? visibleText(written) : written)) {
            if (!current.swapped) warn()
            current.swapped = true
            return original.call(this, args[0], html ? escapeHtml(current.selection) : current.selection)
          }
        }
        return original.apply(this, args)
      }
  )

  const clipboard = window.Clipboard?.prototype
  // Reading needs a click or keypress on this page - never in the background.
  for (const name of ['readText', 'read']) {
    replace(
      clipboard,
      name,
      (original) =>
        function (this: unknown, ...args) {
          if (activation && !activation.isActive) return refuse('Reading the clipboard requires a user gesture.')
          return original.apply(this, args)
        }
    )
  }
  // Writing needs a gesture too, and cannot overwrite what the user has just copied.
  replace(
    clipboard,
    'writeText',
    (original) =>
      function (this: unknown, ...args) {
        if (activation && !activation.isActive) return refuse('Writing to the clipboard requires a user gesture.')
        const current = recentCopy()
        let text = String(args[0])
        if (current && swaps(current.selection, text)) {
          warn()
          text = current.selection
        }
        return original.call(this, text)
      }
  )
  type Item = { types?: readonly string[]; getType?: (type: string) => Promise<Blob> }
  const itemText = (item: Item, type: string): Promise<string> =>
    item?.types?.includes(type) && item.getType
      ? item.getType(type).then(
          (blob) => blob.text(),
          () => ''
        )
      : Promise.resolve('')
  replace(
    clipboard,
    'write',
    (original) =>
      function (this: unknown, ...args) {
        if (activation && !activation.isActive) return refuse('Writing to the clipboard requires a user gesture.')
        const current = recentCopy()
        if (!current) return original.apply(this, args)
        // Right after a copy, the items' text is checked like writeText's before anything is written.
        const items: Item[] = Array.isArray(args[0]) ? args[0] : []
        const texts = items.flatMap((item) => [
          itemText(item, 'text/plain'),
          itemText(item, 'text/html').then(visibleText)
        ])
        return Promise.all(texts).then((values) => {
          if (values.some((value) => swaps(current.selection, value))) {
            warn()
            return refuse('The clipboard holds text the user just copied.')
          }
          return original.apply(this, args)
        })
      }
  )

  // ── Passkeys (WebAuthn) ────────────────────────────────────────────────
  // Conditional mediation ("passkey autofill") needs browser UI Aqua does not
  // have; Electron would turn it into a modal account picker on page load.
  // It is reported as unavailable, and such requests simply wait until the
  // page aborts them.
  //
  // Modal requests open a system dialog, so a page gets one only right after
  // a click or keypress, one at a time, and not again straight after the
  // previous one closed: cancelling can't be answered with an instant new
  // prompt, over and over.
  const pendingUntilAbort = (signal: unknown): Promise<never> =>
    new Promise((_resolve, reject) => {
      if (!(signal instanceof AbortSignal)) return
      const abort = (): void => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  const isPublicKey = (options: unknown): options is { publicKey: unknown; mediation?: string; signal?: unknown } =>
    typeof options === 'object' && options !== null && 'publicKey' in options && !!options.publicKey
  const PASSKEY_COOLDOWN_MS = 1500
  let passkeyOpen = false
  let passkeyReadyAt = -Infinity
  const passkeyRequest = (start: () => unknown): unknown => {
    if (activation && !activation.isActive) return refuse('Passkeys start when you click or press a key on the page.')
    if (passkeyOpen || performance.now() < passkeyReadyAt) return refuse('Another passkey request was just made.')
    passkeyOpen = true
    const settle = (): void => {
      passkeyOpen = false
      passkeyReadyAt = performance.now() + PASSKEY_COOLDOWN_MS
    }
    let result: unknown
    try {
      result = start()
    } catch (err) {
      settle()
      throw err
    }
    void Promise.resolve(result).then(settle, settle)
    return result
  }
  const credentials = window.CredentialsContainer?.prototype
  replace(
    credentials,
    'get',
    (original) =>
      function (this: unknown, ...args) {
        const options = args[0]
        if (!isPublicKey(options)) return original.apply(this, args)
        if (options.mediation === 'conditional') return pendingUntilAbort(options.signal)
        return passkeyRequest(() => original.apply(this, args))
      }
  )
  replace(
    credentials,
    'create',
    (original) =>
      function (this: unknown, ...args) {
        if (!isPublicKey(args[0])) return original.apply(this, args)
        return passkeyRequest(() => original.apply(this, args))
      }
  )
  const PublicKey = (window as Window & { PublicKeyCredential?: object }).PublicKeyCredential
  replace(
    PublicKey,
    'isConditionalMediationAvailable',
    () =>
      function () {
        return Promise.resolve(false)
      }
  )
  replace(
    PublicKey,
    'getClientCapabilities',
    (original) =>
      function (this: unknown, ...args) {
        return Promise.resolve(original.apply(this, args)).then((capabilities) => ({
          ...(capabilities as object),
          conditionalGet: false,
          conditionalCreate: false
        }))
      }
  )
}
