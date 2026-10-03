import { useSyncExternalStore } from 'react'
import type {
  AppVersions,
  Bookmark,
  BrowserSettings,
  ContentBlockerInfo,
  DownloadEntry,
  FindState,
  Platform,
  TabState,
  VaultStatus,
  WindowState
} from '@shared/types'

type Listener = () => void

/** Minimal external store; components subscribe via `useStore`. */
export class Store<T> {
  private readonly listeners = new Set<Listener>()

  constructor(private value: T) {}

  get = (): T => this.value

  set = (next: T | ((previous: T) => T)): void => {
    const value = typeof next === 'function' ? (next as (previous: T) => T)(this.value) : next
    if (Object.is(value, this.value)) return
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/**
 * Subscribes to a store. `select` must return a primitive or a reference that
 * is stable between updates, otherwise React would re-render in a loop.
 */
export function useStore<T>(store: Store<T>): T
export function useStore<T, S>(store: Store<T>, select: (value: T) => S): S
export function useStore<T, S>(store: Store<T>, select?: (value: T) => S): T | S {
  return useSyncExternalStore(store.subscribe, () => (select ? select(store.get()) : store.get()))
}

const EMPTY_WINDOW: WindowState = {
  windowId: 0,
  tabs: [],
  activeTabId: null,
  canReopenClosedTab: false,
  htmlFullscreen: false,
  focused: true,
  maximized: false,
  prompts: [],
  private: false
}

export const windowStore = new Store<WindowState>(EMPTY_WINDOW)
export const settingsStore = new Store<BrowserSettings | null>(null)
export const bookmarksStore = new Store<Bookmark[]>([])
export const downloadsStore = new Store<DownloadEntry[]>([])
export const vaultStore = new Store<VaultStatus>({ state: 'locked', legacyUpgrade: false })
export const blockerStore = new Store<ContentBlockerInfo>({
  enabled: false,
  status: 'loading',
  filterCount: 0,
  listCount: 0,
  updatedAt: null,
  updating: false,
  updateError: null
})
export const findStore = new Store<FindState | null>(null)
/** The New Tab page's own picture (a data: URL), once something asked for it; see `useNtpImage`. */
export const ntpImageStore = new Store<string | null>(null)
let ntpImageWanted = false

/** Fetches the picture the first time a view needs it; kept current from then on. */
export function wantNtpImage(): void {
  if (ntpImageWanted) return
  ntpImageWanted = true
  void window.aqua.ntp.image().then((url) => ntpImageStore.set(url))
}
/** UI start time; the downloads button shows once a download happened in this session. */
export const sessionStart = Date.now()

/** Id of the popup currently shown in the popup overlay layer (only one at a time). */
export const popupStore = new Store<string | null>(null)

export const env: { platform: Platform; versions: AppVersions } = {
  platform: 'win32',
  versions: { app: '', electron: '', chrome: '', node: '', v8: '' }
}

export function useSettings(): BrowserSettings {
  const settings = useStore(settingsStore)
  if (!settings) throw new Error('settings not bootstrapped')
  return settings
}

export function useActiveTab(): TabState | null {
  return useStore(windowStore, (s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
}

export async function bootstrapStores(): Promise<void> {
  const aqua = window.aqua
  const data = await aqua.ui.bootstrap()
  env.platform = data.platform
  env.versions = data.versions
  windowStore.set(data.state)
  settingsStore.set(data.settings)
  bookmarksStore.set(data.bookmarks)
  downloadsStore.set(data.downloads)
  vaultStore.set(data.vault)
  blockerStore.set(data.contentBlocker)

  aqua.ui.onState((state) => windowStore.set(state))
  aqua.settings.onChanged((settings) => settingsStore.set(settings))
  aqua.bookmarks.onChanged((list) => bookmarksStore.set(list))
  aqua.find.onState((state) => findStore.set(state))
  aqua.downloads.onReset((list) => downloadsStore.set(list))
  aqua.downloads.onChanged((entry) =>
    downloadsStore.set((list) => {
      const index = list.findIndex((d) => d.id === entry.id)
      if (index === -1) return [entry, ...list]
      const next = list.slice()
      next[index] = entry
      return next
    })
  )
  aqua.blocker.onChanged((info) => blockerStore.set(info))
  aqua.ntp.onImageChanged(() => {
    if (ntpImageWanted) void aqua.ntp.image().then((url) => ntpImageStore.set(url))
  })
  aqua.vault.onChanged(async (status) => {
    vaultStore.set(status)
    if (status.state === 'unlocked') {
      // Data withheld while locked is fetched again once unlocked.
      const fresh = await aqua.ui.bootstrap()
      bookmarksStore.set(fresh.bookmarks)
      downloadsStore.set(fresh.downloads)
      windowStore.set(fresh.state)
    }
  })
}
