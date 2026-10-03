import { useEffect, useRef, useState, type RefObject } from 'react'
import { Shield, ShieldCheck, ShieldOff } from 'lucide-react'
import type { TabState } from '@shared/types'
import { Icon } from '../components/Icon'
import { Popup, usePopup } from '../components/Popup'
import { cx, formatAgo } from '../lib/format'
import { blockerStore, useSettings, useStore, windowStore } from '../store'

const POPUP_ID = 'blocker'
const numberFormat = new Intl.NumberFormat()

function badgeText(count: number): string {
  if (count < 1000) return String(count)
  return count < 10_000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.floor(count / 1000)}k`
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null
  } catch {
    return null
  }
}

/**
 * The shield in the toolbar: how many requests were blocked on this page,
 * and a panel to pause blocking on the site.
 */
export function BlockerButton({ tab }: { tab: TabState | null }) {
  const settings = useSettings()
  const ref = useRef<HTMLButtonElement>(null)
  const popup = usePopup(POPUP_ID)
  if (!settings.contentBlocking) return null

  const host = tab && !tab.discarded ? hostOf(tab.url) : null
  const paused = !!tab?.blockerPaused
  const count = tab && host && !paused ? tab.blockedCount : 0
  const title = !host
    ? 'Ad and tracker blocking doesn’t apply to this page'
    : paused
      ? `Blocking is paused on ${host}`
      : count > 0
        ? `${numberFormat.format(count)} blocked on this page`
        : 'Ad and tracker blocking'

  return (
    <>
      <button
        ref={ref}
        className={cx('icon-button', 'blocker-button', popup.open && 'pressed', paused && 'paused')}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={popup.open}
        disabled={!host}
        {...popup.anchorProps}
      >
        <Icon icon={paused ? ShieldOff : Shield} size={18} stroke={1.6} />
        {count > 0 && <span className="badge">{badgeText(count)}</span>}
      </button>
      {popup.open && tab && host && <BlockerPanel anchorRef={ref} tab={tab} host={host} onClose={popup.close} />}
    </>
  )
}

function BlockerPanel({
  anchorRef,
  tab,
  host,
  onClose
}: {
  anchorRef: RefObject<HTMLElement | null>
  tab: TabState
  host: string
  onClose: () => void
}) {
  const info = useStore(blockerStore)
  const isPrivate = useStore(windowStore, (w) => w.private)
  const [busy, setBusy] = useState(false)
  const paused = tab.blockerPaused
  const count = paused ? 0 : tab.blockedCount

  // The panel describes one site: going somewhere else closes it (a reload after toggling does not).
  const [openedFor] = useState(host)
  useEffect(() => {
    if (host !== openedFor) onClose()
  }, [host, openedFor, onClose])

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.aqua.blocker.setPaused(tab.id, !paused)
    } finally {
      setBusy(false)
    }
  }

  const meta =
    info.status === 'loading'
      ? 'Preparing filter lists…'
      : info.status === 'error'
        ? 'Filter lists unavailable'
        : `${numberFormat.format(info.filterCount)} filters${info.updatedAt ? ` · updated ${formatAgo(info.updatedAt)}` : ''}`

  return (
    <Popup anchorRef={anchorRef} align="end" width={300} onDismiss={onClose} label="Ad and tracker blocking">
      <div className="popup-header">
        <div className="popup-title">{host}</div>
      </div>
      <div className="blocker-summary">
        <div className={cx('blocker-shield', paused && 'off')}>
          <Icon icon={paused ? ShieldOff : ShieldCheck} size={20} stroke={1.8} />
        </div>
        {paused ? (
          <div>
            <div className="blocker-state">Blocking is paused</div>
            <div className="blocker-caption">Ads and trackers load normally on this site.</div>
          </div>
        ) : (
          <div>
            <div className="blocker-count">{numberFormat.format(count)}</div>
            <div className="blocker-caption">{count === 1 ? 'request' : 'requests'} blocked on this page</div>
          </div>
        )}
      </div>
      <div className="popup-divider" />
      <div className="blocker-toggle">
        <div className="blocker-toggle-text">
          <div className="blocker-toggle-label">Block ads and trackers here</div>
          <div className="blocker-caption">
            {isPrivate
              ? 'Applies until this window closes. The page reloads.'
              : 'Applies to all of this site. The page reloads.'}
          </div>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={!paused}
          aria-label={`Block ads and trackers on ${host}`}
          disabled={busy}
          data-autofocus
          onClick={() => void toggle()}
        />
      </div>
      <div className="popup-footer blocker-footer">
        <span className="blocker-meta">{meta}</span>
        <button
          className="link-button"
          onClick={() => {
            onClose()
            void window.aqua.nav.go('aqua://settings/privacy', { disposition: 'new-tab' })
          }}
        >
          Settings
        </button>
      </div>
    </Popup>
  )
}
