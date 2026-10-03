import type { WebContents } from 'electron'
import type { WebsiteAppearance } from '../../shared/types'

interface Emulation {
  mode: Exclude<WebsiteAppearance, 'system'>
  /** Flattened CDP sessions of out-of-process iframes. */
  sessions: Set<string>
  onMessage: (event: Electron.Event, method: string, params: unknown) => void
  onDetach: () => void
}

const active = new WeakMap<WebContents, Emulation>()

/**
 * Overrides `prefers-color-scheme` for one tab, independent of the OS and of
 * Aqua's own theme.
 *
 * Uses the DevTools protocol (the same mechanism as DevTools' "Emulate CSS
 * media feature"), attached only while an override is in effect - tabs that
 * follow the system have no debugger attached at all. Out-of-process iframes
 * (embeds on other sites) are separate targets: they are auto-attached,
 * receive the same override, and are resumed immediately.
 */
export function applyWebsiteAppearance(wc: WebContents, mode: WebsiteAppearance): void {
  if (wc.isDestroyed()) return
  const current = active.get(wc)
  if (mode === 'system') {
    if (current) stop(wc, current)
    return
  }
  if (current) {
    if (current.mode === mode) return
    current.mode = mode
    for (const target of [undefined, ...current.sessions]) void emulate(wc, mode, target)
    return
  }
  start(wc, mode)
}

function start(wc: WebContents, mode: Emulation['mode']): void {
  const dbg = wc.debugger
  if (!dbg.isAttached()) {
    try {
      dbg.attach('1.3')
    } catch (err) {
      console.warn('[appearance] cannot attach to tab:', err)
      return
    }
  }
  const state: Emulation = {
    mode,
    sessions: new Set(),
    onMessage: (_event, method, params) => {
      const p = params as { sessionId?: string; targetInfo?: { type?: string }; waitingForDebugger?: boolean }
      if (method === 'Target.attachedToTarget' && p.sessionId) {
        void adoptChild(wc, state, p.sessionId, p.targetInfo?.type === 'iframe')
      } else if (method === 'Target.detachedFromTarget' && p.sessionId) {
        state.sessions.delete(p.sessionId)
      }
    },
    onDetach: () => {
      if (active.get(wc) === state) active.delete(wc)
      dbg.removeListener('message', state.onMessage)
    }
  }
  active.set(wc, state)
  dbg.on('message', state.onMessage)
  dbg.once('detach', state.onDetach)
  void emulate(wc, mode)
  void autoAttach(wc)
}

function stop(wc: WebContents, state: Emulation): void {
  active.delete(wc)
  const dbg = wc.debugger
  dbg.removeListener('message', state.onMessage)
  dbg.removeListener('detach', state.onDetach)
  // Detaching discards every override of this client, in all frames.
  try {
    if (dbg.isAttached()) dbg.detach()
  } catch {
    /* already gone */
  }
}

/** Child targets start paused; whatever happens they must be resumed. */
async function adoptChild(wc: WebContents, state: Emulation, sessionId: string, isFrame: boolean): Promise<void> {
  try {
    if (isFrame) {
      state.sessions.add(sessionId)
      await emulate(wc, state.mode, sessionId)
      await autoAttach(wc, sessionId)
    }
  } finally {
    await send(wc, 'Runtime.runIfWaitingForDebugger', {}, sessionId)
  }
}

function autoAttach(wc: WebContents, sessionId?: string): Promise<unknown> {
  return send(wc, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
}

function emulate(wc: WebContents, mode: Emulation['mode'], sessionId?: string): Promise<unknown> {
  return send(
    wc,
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: mode }] },
    sessionId
  )
}

async function send(wc: WebContents, method: string, params: object, sessionId?: string): Promise<unknown> {
  if (wc.isDestroyed() || !wc.debugger.isAttached()) return null
  try {
    return await wc.debugger.sendCommand(method, params, sessionId)
  } catch {
    // Target navigated away or closed mid-command; nothing to undo.
    return null
  }
}
