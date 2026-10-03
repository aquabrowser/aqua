import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import {
  AppWindow,
  Bookmark,
  Check,
  Code,
  Download,
  History,
  Lock,
  LogOut,
  Maximize2,
  Minus,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Settings,
  SquarePlus,
  type LucideIcon,
  VenetianMask
} from 'lucide-react'
import type { CommandId, TabState } from '@shared/types'
import { Icon } from '../components/Icon'
import { Popup } from '../components/Popup'
import { cx } from '../lib/format'
import { useSettings, useStore, windowStore } from '../store'

type MenuEntry =
  | {
      type: 'item'
      id: string
      label: string
      icon: LucideIcon
      kbd?: string
      disabled?: boolean
      checked?: boolean
      command: CommandId
    }
  | { type: 'separator'; id: string }
  | { type: 'zoom'; id: string }

const isMac = navigator.userAgent.includes('Mac OS')
const k = (win: string, mac: string): string => (isMac ? mac : win)

export function AppMenu({
  anchorRef,
  tab,
  onClose
}: {
  anchorRef: RefObject<HTMLElement | null>
  tab: TabState | null
  onClose: () => void
}) {
  const settings = useSettings()
  const canReopen = useStore(windowStore, (s) => s.canReopenClosedTab)
  const web = !!tab && /^(https?|file):/.test(tab.url) && !tab.error && !tab.crashed

  const entries = useMemo<MenuEntry[]>(
    () => [
      { type: 'item', id: 'new-tab', label: 'New tab', icon: SquarePlus, kbd: k('Ctrl+T', '⌘T'), command: 'tab.new' },
      {
        type: 'item',
        id: 'new-window',
        label: 'New window',
        icon: AppWindow,
        kbd: k('Ctrl+N', '⌘N'),
        command: 'window.new'
      },
      {
        type: 'item',
        id: 'new-private-window',
        label: 'New private window',
        icon: VenetianMask,
        kbd: k('Ctrl+Shift+N', '⇧⌘N'),
        command: 'window.new-private'
      },
      { type: 'separator', id: 's1' },
      { type: 'item', id: 'history', label: 'History', icon: History, kbd: k('Ctrl+H', '⌘Y'), command: 'open.history' },
      {
        type: 'item',
        id: 'downloads',
        label: 'Downloads',
        icon: Download,
        kbd: k('Ctrl+J', '⇧⌘J'),
        command: 'open.downloads'
      },
      {
        type: 'item',
        id: 'bookmarks-bar',
        label: 'Show bookmarks bar',
        icon: Bookmark,
        kbd: k('Ctrl+Shift+B', '⇧⌘B'),
        checked: settings.showBookmarksBar,
        command: 'bookmarks.toggle-bar'
      },
      {
        type: 'item',
        id: 'reopen',
        label: 'Reopen closed tab',
        icon: RotateCcw,
        kbd: k('Ctrl+Shift+T', '⇧⌘T'),
        disabled: !canReopen,
        command: 'tab.reopen'
      },
      { type: 'separator', id: 's2' },
      { type: 'zoom', id: 'zoom' },
      { type: 'separator', id: 's3' },
      {
        type: 'item',
        id: 'find',
        label: 'Find…',
        icon: Search,
        kbd: k('Ctrl+F', '⌘F'),
        disabled: !web,
        command: 'find.open'
      },
      {
        type: 'item',
        id: 'print',
        label: 'Print…',
        icon: Printer,
        kbd: k('Ctrl+P', '⌘P'),
        disabled: !web,
        command: 'page.print'
      },
      {
        type: 'item',
        id: 'devtools',
        label: 'Developer tools',
        icon: Code,
        kbd: k('F12', '⌥⌘I'),
        disabled: !web,
        command: 'page.devtools'
      },
      { type: 'separator', id: 's4' },
      {
        type: 'item',
        id: 'settings',
        label: 'Settings',
        icon: Settings,
        kbd: isMac ? '⌘,' : undefined,
        command: 'open.settings'
      },
      {
        type: 'item',
        id: 'lock',
        label: 'Lock Aqua',
        icon: Lock,
        kbd: k('Ctrl+Shift+L', '⇧⌘L'),
        command: 'vault.lock'
      },
      { type: 'separator', id: 's5' },
      {
        type: 'item',
        id: 'quit',
        label: isMac ? 'Quit Aqua' : 'Exit',
        icon: LogOut,
        kbd: isMac ? '⌘Q' : undefined,
        command: 'app.quit'
      }
    ],
    [settings.showBookmarksBar, canReopen, web]
  )

  const actionable = entries.filter((e): e is Extract<MenuEntry, { type: 'item' }> => e.type === 'item' && !e.disabled)
  const [highlight, setHighlight] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const run = (command: CommandId): void => {
    onClose()
    void window.aqua.ui.command(command)
  }

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    const index = actionable.findIndex((e) => e.id === highlight)
    const move = (to: number): void => {
      event.preventDefault()
      setHighlight(actionable[(to + actionable.length) % actionable.length].id)
    }
    switch (event.key) {
      case 'ArrowDown':
        return move(index + 1)
      case 'ArrowUp':
        return move(index <= 0 ? actionable.length - 1 : index - 1)
      case 'Home':
        return move(0)
      case 'End':
        return move(actionable.length - 1)
      case 'Enter':
      case ' ': {
        const item = actionable[index]
        if (item) {
          event.preventDefault()
          run(item.command)
        }
        return
      }
    }
  }

  const zoom = tab?.zoomFactor ?? 1
  return (
    <Popup anchorRef={anchorRef} align="end" width={300} onDismiss={onClose} role="menu" label="Aqua menu">
      <div
        ref={listRef}
        className="menu popup-scroll"
        onKeyDown={onKeyDown}
        tabIndex={-1}
        data-autofocus
        onMouseLeave={() => setHighlight(null)}
      >
        {entries.map((entry) => {
          if (entry.type === 'separator') return <div key={entry.id} className="menu-separator" role="separator" />
          if (entry.type === 'zoom') {
            return (
              <div key={entry.id} className="menu-row" role="group" aria-label="Zoom">
                <span className="menu-label">Zoom</span>
                <button
                  className="mini-button"
                  title="Zoom out"
                  aria-label="Zoom out"
                  disabled={!web}
                  onClick={() => void window.aqua.ui.command('page.zoom-out')}
                >
                  <Icon icon={Minus} />
                </button>
                <span className="value">{Math.round(zoom * 100)}%</span>
                <button
                  className="mini-button"
                  title="Zoom in"
                  aria-label="Zoom in"
                  disabled={!web}
                  onClick={() => void window.aqua.ui.command('page.zoom-in')}
                >
                  <Icon icon={Plus} />
                </button>
                <button
                  className="mini-button bordered"
                  title={`Full screen (${k('F11', '⌃⌘F')})`}
                  aria-label="Full screen"
                  onClick={() => run('window.fullscreen')}
                >
                  <Icon icon={Maximize2} size={14} />
                </button>
              </div>
            )
          }
          return (
            <div
              key={entry.id}
              className={cx('menu-item', highlight === entry.id && 'highlighted')}
              role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={entry.checked}
              aria-disabled={entry.disabled || undefined}
              onMouseMove={() => !entry.disabled && highlight !== entry.id && setHighlight(entry.id)}
              onClick={() => !entry.disabled && run(entry.command)}
            >
              <Icon icon={entry.icon} />
              <span className="menu-label">{entry.label}</span>
              {entry.checked && <Icon icon={Check} className="menu-check" />}
              {entry.kbd && <span className="menu-kbd">{entry.kbd}</span>}
            </div>
          )
        })}
      </div>
    </Popup>
  )
}
