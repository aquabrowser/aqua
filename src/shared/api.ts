/**
 * Shape of `window.aqua`, the only surface the UI renderer has into the
 * privileged side. Implemented by the preload script with explicit,
 * per-method channel bindings - the renderer can never name an arbitrary
 * IPC channel.
 */
import type {
  Bookmark,
  BrowserSettings,
  ClearDataKind,
  ClearDataSummary,
  CommandId,
  ContentBlockerInfo,
  ContextMenuRequest,
  CreateTabOptions,
  DownloadAction,
  DownloadEntry,
  FindState,
  HistoryEntry,
  HistoryQuery,
  ImageResult,
  NavigateOptions,
  OverlayPlacement,
  OverlayRole,
  PermissionKind,
  PromptResponse,
  ProtocolGrant,
  Shortcut,
  SiteInfo,
  SitePermission,
  StorageInfo,
  SuggestResult,
  TopSite,
  UiBootstrap,
  UiCommand,
  UpdateStatus,
  VaultResult,
  VaultStatus,
  WindowState
} from './types'

export type Unsubscribe = () => void

export interface AquaApi {
  ui: {
    bootstrap(): Promise<UiBootstrap>
    command(command: CommandId, arg?: number): Promise<void>
    contextMenu(request: ContextMenuRequest): Promise<void>
    setContentTop(top: number): void
    focusContent(): void
    showOverlay(role: OverlayRole, placement: OverlayPlacement, focus: boolean): void
    hideOverlay(role: OverlayRole): void
    onState(listener: (state: WindowState) => void): Unsubscribe
    onCommand(listener: (command: UiCommand) => void): Unsubscribe
  }
  tabs: {
    create(options?: CreateTabOptions): Promise<string | null>
    activate(tabId: string, focusContent: boolean): Promise<void>
    close(tabId: string): Promise<void>
    move(tabId: string, index: number): Promise<void>
    setPinned(tabId: string, pinned: boolean): Promise<void>
    setMuted(tabId: string, muted: boolean): Promise<void>
    duplicate(tabId: string): Promise<void>
    reload(tabId: string): Promise<void>
    openBlockedPopup(tabId: string): Promise<void>
  }
  nav: {
    go(input: string, options?: NavigateOptions): Promise<void>
    proceedUnsafe(tabId: string): Promise<void>
  }
  omnibox: {
    suggest(text: string): Promise<SuggestResult>
  }
  prompts: {
    respond(promptId: string, response: PromptResponse): Promise<void>
  }
  find: {
    query(tabId: string, text: string): void
    step(tabId: string, forward: boolean): void
    close(tabId: string): void
    onState(listener: (state: FindState | null) => void): Unsubscribe
  }
  site: {
    info(tabId: string): Promise<SiteInfo | null>
    permissions(): Promise<SitePermission[]>
    resetPermission(origin: string, permission: PermissionKind): Promise<void>
    protocolGrants(): Promise<ProtocolGrant[]>
    revokeGrant(origin: string, scheme: string): Promise<void>
  }
  bookmarks: {
    add(bookmark: { url: string; title: string; favicon: string | null }): Promise<Bookmark>
    update(id: string, patch: { title?: string; url?: string }): Promise<void>
    remove(id: string): Promise<void>
    move(id: string, index: number): Promise<void>
    open(id: string, disposition: 'current' | 'new-tab' | 'background-tab'): Promise<void>
    onChanged(listener: (bookmarks: Bookmark[]) => void): Unsubscribe
  }
  downloads: {
    action(id: string, action: DownloadAction): Promise<void>
    clear(): Promise<void>
    onChanged(listener: (entry: DownloadEntry) => void): Unsubscribe
    onReset(listener: (entries: DownloadEntry[]) => void): Unsubscribe
  }
  history: {
    query(query: HistoryQuery): Promise<HistoryEntry[]>
    remove(ids: string[]): Promise<void>
    topSites(limit: number): Promise<TopSite[]>
  }
  shortcuts: {
    list(): Promise<Shortcut[]>
    add(shortcut: { title: string; url: string }): Promise<Shortcut[]>
    remove(id: string): Promise<Shortcut[]>
    restore(shortcut: Shortcut, index: number): Promise<Shortcut[]>
  }
  settings: {
    update(patch: Partial<BrowserSettings>): Promise<BrowserSettings>
    dataSummary(): Promise<ClearDataSummary>
    clearData(kinds: ClearDataKind[]): Promise<void>
    onChanged(listener: (settings: BrowserSettings) => void): Unsubscribe
  }
  ntp: {
    image(): Promise<string | null>
    imageFromFile(): Promise<ImageResult | null>
    imageFromUrl(url: string): Promise<ImageResult>
    clearImage(): Promise<void>
    onImageChanged(listener: () => void): Unsubscribe
  }
  storage: {
    info(): Promise<StorageInfo>
    open(which: 'profile' | 'other'): Promise<void>
  }
  blocker: {
    info(): Promise<ContentBlockerInfo>
    setPaused(tabId: string, paused: boolean): Promise<boolean>
    updateLists(): Promise<void>
    onChanged(listener: (info: ContentBlockerInfo) => void): Unsubscribe
  }
  vault: {
    setup(password: string): Promise<VaultResult>
    unlock(password: string): Promise<VaultResult>
    lock(): Promise<void>
    changePassword(oldPassword: string, newPassword: string): Promise<VaultResult>
    wipe(confirmation: string): Promise<VaultResult>
    onChanged(listener: (status: VaultStatus) => void): Unsubscribe
  }
  updater: {
    status(): Promise<UpdateStatus>
    check(): Promise<void>
    restart(): Promise<void>
    onStatus(listener: (status: UpdateStatus) => void): Unsubscribe
  }
}
