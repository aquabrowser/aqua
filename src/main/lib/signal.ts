import { randomBytes } from 'crypto'

export type Listener<T> = (value: T) => void

/** Minimal typed event source whose subscriptions return their own disposer. */
export class Signal<T> {
  private readonly listeners = new Set<Listener<T>>()

  on(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value)
      } catch (err) {
        console.error('[signal] listener failed:', err)
      }
    }
  }
}

/** Collects teardown callbacks so owners can release everything in one call. */
export class Disposables {
  private readonly items: Array<() => void> = []

  add(dispose: () => void): void {
    this.items.push(dispose)
  }

  dispose(): void {
    while (this.items.length) {
      const dispose = this.items.pop()!
      try {
        dispose()
      } catch (err) {
        console.error('[disposables] teardown failed:', err)
      }
    }
  }
}

/**
 * An opaque id: the prefix and 128 random bits. Carries no clock, since some ids
 * are stored in plaintext (history row ids, see HistoryService).
 */
export function uid(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`
}
