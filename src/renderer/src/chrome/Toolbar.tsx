import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Download, EllipsisVertical, Lock, RotateCw, X } from 'lucide-react'
import type { TabState } from '@shared/types'
import { Icon } from '../components/Icon'
import { usePopup } from '../components/Popup'
import { cx } from '../lib/format'
import { downloadsStore, sessionStart, useStore } from '../store'
import { AppMenu } from './AppMenu'
import { BlockerButton } from './BlockerButton'
import { DownloadsFlyout } from './DownloadsFlyout'
import { Omnibox } from './Omnibox'

const isMac = navigator.userAgent.includes('Mac OS')
const mod = isMac ? '⌘' : 'Ctrl+'

function NavButton({ direction, tab }: { direction: 'back' | 'forward'; tab: TabState | null }) {
  const ref = useRef<HTMLButtonElement>(null)
  const holdTimer = useRef(0)
  const enabled = direction === 'back' ? !!tab?.canGoBack : !!tab?.canGoForward

  const showHistory = (): void => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    void window.aqua.ui.contextMenu({ kind: 'nav-history', direction, x: r.left, y: r.bottom + 2 })
  }

  return (
    <button
      ref={ref}
      className="icon-button"
      disabled={!enabled}
      title={
        direction === 'back'
          ? `Back (${isMac ? '⌘[' : 'Alt+Left'}). Right-click to see history`
          : `Forward (${isMac ? '⌘]' : 'Alt+Right'})`
      }
      aria-label={direction === 'back' ? 'Back' : 'Forward'}
      onClick={() => void window.aqua.ui.command(direction === 'back' ? 'nav.back' : 'nav.forward')}
      onContextMenu={(e) => {
        e.preventDefault()
        showHistory()
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        window.clearTimeout(holdTimer.current)
        holdTimer.current = window.setTimeout(showHistory, 450)
      }}
      onPointerUp={() => window.clearTimeout(holdTimer.current)}
      onPointerLeave={() => window.clearTimeout(holdTimer.current)}
    >
      <Icon icon={direction === 'back' ? ArrowLeft : ArrowRight} size={18} stroke={1.75} />
    </button>
  )
}

function ReloadButton({ tab }: { tab: TabState | null }) {
  const loading = !!tab?.loading && !tab.discarded
  return (
    <button
      className="icon-button"
      disabled={!tab}
      title={loading ? 'Stop loading (Esc)' : `Reload (${mod}R). Shift-click to reload without the cache`}
      aria-label={loading ? 'Stop' : 'Reload'}
      onClick={(e) => {
        if (loading) void window.aqua.ui.command('nav.stop')
        else void window.aqua.ui.command(e.shiftKey || e.ctrlKey ? 'nav.reload-hard' : 'nav.reload')
      }}
    >
      <span className="reload-icon" key={loading ? 'stop' : 'reload'}>
        <Icon icon={loading ? X : RotateCw} size={18} stroke={1.75} />
      </span>
    </button>
  )
}

function DownloadsButton() {
  const downloads = useStore(downloadsStore)
  const popup = usePopup('downloads')
  const ref = useRef<HTMLButtonElement>(null)
  const [pulse, setPulse] = useState(false)

  const active = downloads.filter((d) => d.status === 'progressing' || d.status === 'paused')
  const recent = downloads.some((d) => d.startedAt >= sessionStart)
  const total = active.reduce((sum, d) => sum + d.totalBytes, 0)
  const received = active.reduce((sum, d) => sum + d.receivedBytes, 0)
  const indeterminate = active.length > 0 && active.some((d) => d.totalBytes <= 0)
  const fraction = total > 0 ? received / total : 0

  // Brief pulse when the last active download completes.
  const lastActive = useRef(active.length)
  useEffect(() => {
    if (lastActive.current > 0 && active.length === 0 && downloads.some((d) => d.status === 'completed')) setPulse(true)
    lastActive.current = active.length
  }, [active.length, downloads])

  // The main process asks to open the bubble when a download starts in this window.
  const showPopup = popup.show
  useEffect(
    () =>
      window.aqua.ui.onCommand((command) => {
        if (command.type === 'popup.open' && command.popup === 'downloads') showPopup()
      }),
    [showPopup]
  )

  if (!recent && active.length === 0 && !popup.open) return null

  const r = 13
  const circumference = 2 * Math.PI * r
  return (
    <>
      <button
        ref={ref}
        className={cx('icon-button', popup.open && 'pressed', pulse && 'done-pulse', active.length > 0 && 'accent')}
        title={
          active.length ? `Downloading ${active.length} file${active.length > 1 ? 's' : ''}` : `Downloads (${mod}J)`
        }
        aria-label="Downloads"
        {...popup.anchorProps}
        onAnimationEnd={() => setPulse(false)}
      >
        <Icon icon={Download} size={17} stroke={1.6} />
        {active.length > 0 && (
          <svg className={cx('download-ring', indeterminate && 'indeterminate')} viewBox="0 0 30 30" aria-hidden>
            <circle className="track" cx="15" cy="15" r={r} />
            <circle
              className="value"
              cx="15"
              cy="15"
              r={r}
              strokeDasharray={circumference}
              strokeDashoffset={indeterminate ? circumference * 0.75 : circumference * (1 - fraction)}
            />
          </svg>
        )}
      </button>
      {popup.open && <DownloadsFlyout anchorRef={ref} onClose={popup.close} />}
    </>
  )
}

function MenuButton({ tab }: { tab: TabState | null }) {
  const popup = usePopup('app-menu')
  const ref = useRef<HTMLButtonElement>(null)
  const showPopup = popup.show
  useEffect(
    () =>
      window.aqua.ui.onCommand((command) => {
        if (command.type === 'popup.open' && command.popup === 'app-menu') showPopup()
      }),
    [showPopup]
  )
  return (
    <>
      <button
        ref={ref}
        className={cx('icon-button', popup.open && 'pressed')}
        title="Menu"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={popup.open}
        {...popup.anchorProps}
      >
        <Icon icon={EllipsisVertical} size={18} stroke={1.75} />
      </button>
      {popup.open && <AppMenu anchorRef={ref} tab={tab} onClose={popup.close} />}
    </>
  )
}

export function Toolbar({ tab }: { tab: TabState | null }) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Navigation">
      <div className="toolbar-group">
        <NavButton direction="back" tab={tab} />
        <NavButton direction="forward" tab={tab} />
        <ReloadButton tab={tab} />
      </div>
      <Omnibox tab={tab} />
      <div className="toolbar-group">
        <BlockerButton tab={tab} />
        <DownloadsButton />
        <button
          className="icon-button"
          title={`Lock Aqua (${mod}Shift+L)`}
          aria-label="Lock Aqua"
          onClick={() => void window.aqua.vault.lock()}
        >
          <Icon icon={Lock} size={17} stroke={1.6} />
        </button>
        <MenuButton tab={tab} />
      </div>
    </div>
  )
}
