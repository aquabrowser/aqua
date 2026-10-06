/**
 * Preload bridge for the browser UI renderer (sandboxed, context-isolated).
 *
 * Exposes `window.aqua` - a frozen object of explicit functions, each bound to
 * one IPC channel from the shared contract. The renderer never receives
 * `ipcRenderer` itself and cannot name arbitrary channels; listener
 * registrations return disposers and never leak the raw IPC event object.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AquaApi, Unsubscribe } from '../shared/api'
import type { EventMap, InvokeMap, SendMap } from '../shared/ipc'

function invoke<K extends keyof InvokeMap>(
  channel: K,
  ...args: Parameters<InvokeMap[K]>
): Promise<Awaited<ReturnType<InvokeMap[K]>>> {
  return ipcRenderer.invoke(channel, ...args)
}

function send<K extends keyof SendMap>(channel: K, ...args: Parameters<SendMap[K]>): void {
  ipcRenderer.send(channel, ...args)
}

function subscribe<K extends keyof EventMap>(channel: K, listener: EventMap[K]): Unsubscribe {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    ;(listener as (...a: unknown[]) => void)(...args)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: AquaApi = {
  ui: {
    bootstrap: () => invoke('ui:bootstrap'),
    command: (command, arg) => invoke('ui:command', command, arg),
    contextMenu: (request) => invoke('ui:context-menu', request),
    setContentTop: (top) => send('ui:content-top', top),
    focusContent: () => send('ui:focus-content'),
    showOverlay: (role, placement, focus) => send('ui:overlay-show', role, placement, focus),
    hideOverlay: (role) => send('ui:overlay-hide', role),
    onState: (listener) => subscribe('window:state', listener),
    onCommand: (listener) => subscribe('ui:command', listener)
  },
  tabs: {
    create: (options) => invoke('tabs:create', options),
    activate: (tabId, focusContent) => invoke('tabs:activate', tabId, focusContent),
    close: (tabId) => invoke('tabs:close', tabId),
    move: (tabId, index) => invoke('tabs:move', tabId, index),
    setPinned: (tabId, pinned) => invoke('tabs:set-pinned', tabId, pinned),
    setMuted: (tabId, muted) => invoke('tabs:set-muted', tabId, muted),
    duplicate: (tabId) => invoke('tabs:duplicate', tabId),
    reload: (tabId) => invoke('tabs:reload', tabId),
    openBlockedPopup: (tabId) => invoke('tabs:open-blocked-popup', tabId)
  },
  nav: {
    go: (input, options) => invoke('nav:go', input, options),
    proceedUnsafe: (tabId) => invoke('nav:proceed-unsafe', tabId)
  },
  omnibox: {
    suggest: (text) => invoke('omnibox:suggest', text)
  },
  prompts: {
    respond: (promptId, response) => invoke('prompt:respond', promptId, response)
  },
  find: {
    query: (tabId, text) => send('find:query', tabId, text),
    step: (tabId, forward) => send('find:step', tabId, forward),
    close: (tabId) => send('find:close', tabId),
    onState: (listener) => subscribe('find:state', listener)
  },
  site: {
    info: (tabId) => invoke('site:info', tabId),
    permissions: () => invoke('site:permissions'),
    resetPermission: (origin, permission) => invoke('site:reset-permission', origin, permission),
    protocolGrants: () => invoke('site:protocol-grants'),
    revokeGrant: (origin, scheme) => invoke('site:revoke-grant', origin, scheme)
  },
  bookmarks: {
    add: (bookmark) => invoke('bookmarks:add', bookmark),
    update: (id, patch) => invoke('bookmarks:update', id, patch),
    remove: (id) => invoke('bookmarks:remove', id),
    move: (id, index) => invoke('bookmarks:move', id, index),
    open: (id, disposition) => invoke('bookmarks:open', id, disposition),
    onChanged: (listener) => subscribe('bookmarks:changed', listener)
  },
  downloads: {
    action: (id, action) => invoke('downloads:action', id, action),
    clear: () => invoke('downloads:clear'),
    onChanged: (listener) => subscribe('downloads:changed', listener),
    onReset: (listener) => subscribe('downloads:reset', listener)
  },
  history: {
    query: (query) => invoke('history:query', query),
    remove: (ids) => invoke('history:remove', ids),
    topSites: (limit) => invoke('history:top-sites', limit)
  },
  shortcuts: {
    list: () => invoke('shortcuts:list'),
    add: (shortcut) => invoke('shortcuts:add', shortcut),
    remove: (id) => invoke('shortcuts:remove', id),
    restore: (shortcut, index) => invoke('shortcuts:restore', shortcut, index)
  },
  settings: {
    update: (patch) => invoke('settings:update', patch),
    dataSummary: () => invoke('settings:data-summary'),
    clearData: (kinds) => invoke('settings:clear-data', kinds),
    onChanged: (listener) => subscribe('settings:changed', listener)
  },
  ntp: {
    image: () => invoke('ntp:image'),
    imageFromFile: () => invoke('ntp:image-from-file'),
    imageFromUrl: (url) => invoke('ntp:image-from-url', url),
    clearImage: () => invoke('ntp:image-clear'),
    onImageChanged: (listener) => subscribe('ntp:image-changed', listener)
  },
  storage: {
    info: () => invoke('storage:info'),
    open: (which) => invoke('storage:open', which)
  },
  profiles: {
    list: () => invoke('profiles:list'),
    open: (id) => invoke('profiles:open', id),
    openGuest: () => invoke('profiles:open-guest'),
    create: (profile) => invoke('profile-admin:create', profile),
    update: (id, profile) => invoke('profile-admin:update', id, profile),
    remove: (id) => invoke('profile-admin:delete', id)
  },
  blocker: {
    info: () => invoke('blocker:info'),
    setPaused: (tabId, paused) => invoke('blocker:set-paused', tabId, paused),
    updateLists: () => invoke('blocker:update-lists'),
    onChanged: (listener) => subscribe('blocker:changed', listener)
  },
  vault: {
    setup: (password) => invoke('vault:setup', password),
    unlock: (password) => invoke('vault:unlock', password),
    lock: () => invoke('vault:lock'),
    changePassword: (oldPassword, newPassword) => invoke('vault:change-password', oldPassword, newPassword),
    wipe: (confirmation) => invoke('vault:wipe', confirmation),
    onChanged: (listener) => subscribe('vault:changed', listener)
  },
  updater: {
    status: () => invoke('updater:status'),
    check: () => invoke('updater:check'),
    restart: () => invoke('updater:restart'),
    onStatus: (listener) => subscribe('updater:status', listener)
  }
}

contextBridge.exposeInMainWorld('aqua', api)
