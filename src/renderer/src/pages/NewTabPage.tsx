import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { CircleAlert, Plus, VenetianMask, X, UserRound } from 'lucide-react'
import { greetingFor, NTP_FONTS, ntpBackdrop } from '@shared/ntp'
import type { Shortcut } from '@shared/types'
import { normalizeWebAddress } from '@shared/url'
import { Dialog } from '../components/Dialog'
import { Icon } from '../components/Icon'
import { cx } from '../lib/format'
import { fontStyle } from '../lib/ntp'
import { ntpImageStore, useSettings, useStore, wantNtpImage, windowStore, isGuest } from '../store'

/** Tiles the page shows at most; mirrors MAX_SHORTCUTS in the main process. */
const MAX_SHORTCUTS = 10
const UNDO_MS = 6000

/** Last list shown, so the next New Tab page draws its tiles in the first frame. */
let cachedShortcuts: Shortcut[] | null = null

function tileLabel(site: Shortcut): string {
  if (site.title && site.title.length <= 24) return site.title
  try {
    return new URL(site.url).hostname.replace(/^www\./, '')
  } catch {
    return site.title
  }
}

/** Favicon, falling back to the site's initial when there is none or it fails to load. */
function TileIcon({ site }: { site: Shortcut }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [site.favicon])
  if (site.favicon && !failed) {
    return <img src={site.favicon} alt="" width={24} height={24} draggable={false} onError={() => setFailed(true)} />
  }
  const initial = tileLabel(site).trim().charAt(0).toUpperCase() || '·'
  return (
    <span className="ntp-tile-initial" aria-hidden>
      {initial}
    </span>
  )
}

export function NewTabPage() {
  const isPrivate = useStore(windowStore, (w) => w.private)
  if (isPrivate) return <PrivateNewTab />
  return isGuest() ? <GuestNewTab /> : <RegularNewTab />
}

/** What a guest session does and doesn't do. */
function GuestNewTab() {
  return (
    <div className="page">
      <div className="ntp private">
        <span className="private-mark">
          <Icon icon={UserRound} size={28} stroke={1.5} />
        </span>
        <h1>Guest window</h1>
        <p>
          Aqua keeps nothing from a guest session: the pages you visit, cookies and site data exist only in memory and
          are gone when the last guest window closes. Aqua’s profiles stay locked and out of reach.
        </p>
        <p className="private-note">
          Downloads go to your Downloads folder and stay there. Sites and your network can still see what you do. Ads
          and trackers are blocked here too.
        </p>
      </div>
    </div>
  )
}

/** What a private window does and doesn't do - stated plainly, once. */
function PrivateNewTab() {
  return (
    <div className="page">
      <div className="ntp private">
        <span className="private-mark">
          <Icon icon={VenetianMask} size={28} stroke={1.5} />
        </span>
        <h1>Private window</h1>
        <p>
          Aqua doesn’t keep the pages you visit here, or the cookies and site data they leave behind. It’s all gone when
          you close this window.
        </p>
        <p className="private-note">
          Downloads and bookmarks are still saved. Sites and your network can still see what you do. Ads and trackers
          are blocked here too.
        </p>
      </div>
    </div>
  )
}

/** The page's own background: a tone, a gradient or the user's picture (dimmed a little for legibility). */
function useBackdrop(value: string): { background?: string; contrast?: 'dark' | 'light' } {
  const image = useStore(ntpImageStore)
  useEffect(() => {
    if (value === 'image') wantNtpImage()
  }, [value])
  if (value === 'image') {
    return image
      ? {
          background: `linear-gradient(rgba(0, 0, 0, 0.26), rgba(0, 0, 0, 0.4)), center / cover no-repeat url("${image}")`,
          contrast: 'dark'
        }
      : {}
  }
  const backdrop = ntpBackdrop(value)
  return backdrop ? { background: backdrop.css, contrast: backdrop.dark ? 'dark' : 'light' } : {}
}

function RegularNewTab() {
  const settings = useSettings()
  const showClock = settings.ntpShowClock
  const showGreeting = settings.ntpGreeting
  const showShortcuts = settings.ntpShortcuts === 'grid'
  const font = NTP_FONTS.find((f) => f.id === settings.ntpFont) ?? NTP_FONTS[0]
  const { background, contrast } = useBackdrop(settings.ntpBackground)
  const [now, setNow] = useState(() => new Date())
  const [sites, setSitesState] = useState<Shortcut[] | null>(cachedShortcuts)
  const setSites = useCallback((list: Shortcut[]) => {
    cachedShortcuts = list
    setSitesState(list)
  }, [])
  const [adding, setAdding] = useState(false)
  const [removed, setRemoved] = useState<{ site: Shortcut; index: number } | null>(null)
  const undoTimer = useRef(0)

  useEffect(() => {
    if (!showClock && !showGreeting) return
    // Tick exactly on minute boundaries instead of polling every second.
    setNow(new Date())
    let timer = 0
    const schedule = (): void => {
      const msToMinute = 60_000 - (Date.now() % 60_000) + 20
      timer = window.setTimeout(() => {
        setNow(new Date())
        schedule()
      }, msToMinute)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [showClock, showGreeting])

  // Loaded again when suggestions are switched on or off in Settings.
  useEffect(() => {
    if (!showShortcuts) return
    let alive = true
    void window.aqua.shortcuts.list().then((list) => alive && setSites(list))
    return () => {
      alive = false
    }
  }, [showShortcuts, settings.ntpAutoShortcuts, setSites])

  useEffect(() => () => window.clearTimeout(undoTimer.current), [])

  const remove = useCallback(
    (site: Shortcut, index: number) => {
      void window.aqua.shortcuts.remove(site.id).then(setSites)
      setRemoved({ site, index })
      window.clearTimeout(undoTimer.current)
      undoTimer.current = window.setTimeout(() => setRemoved(null), UNDO_MS)
    },
    [setSites]
  )

  const undo = (): void => {
    if (!removed) return
    void window.aqua.shortcuts.restore(removed.site, removed.index).then(setSites)
    window.clearTimeout(undoTimer.current)
    setRemoved(null)
  }

  const open = (site: Shortcut, background: boolean): void => {
    if (background) void window.aqua.tabs.create({ url: site.url, background: true })
    else void window.aqua.nav.go(site.url)
  }

  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div
      className="page ntp-page"
      data-contrast={contrast}
      data-backdrop={settings.ntpBackground === 'image' ? 'image' : undefined}
      style={background ? { background } : undefined}
    >
      <div className="ntp">
        {showGreeting && (
          <div className="ntp-greeting" style={{ fontFamily: font.family, fontStretch: font.stretch }}>
            {greetingFor(now.getHours())}
          </div>
        )}
        {showClock && (
          <>
            <div className="ntp-clock" style={fontStyle(font)}>
              {time}
            </div>
            <div className="ntp-date">{date}</div>
          </>
        )}
        {showShortcuts && sites && (
          <div className="ntp-tiles" role="list" aria-label="Shortcuts">
            {sites.map((site, index) => (
              <div key={site.id} className="ntp-tile-wrap" role="listitem">
                <button
                  className="ntp-tile"
                  title={`${site.title}\n${site.url}`}
                  onClick={(e) => open(site, e.ctrlKey || e.metaKey)}
                  onAuxClick={(e) => e.button === 1 && open(site, true)}
                  onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                  onKeyDown={(e) => {
                    if (e.key === 'Delete') {
                      e.preventDefault()
                      remove(site, index)
                    }
                  }}
                >
                  <span className="ntp-tile-icon">
                    <TileIcon site={site} />
                  </span>
                  <span className="ntp-tile-label">{tileLabel(site)}</span>
                </button>
                <button
                  className="ntp-tile-remove"
                  aria-label={`Remove ${tileLabel(site)}`}
                  title="Remove"
                  onClick={() => remove(site, index)}
                >
                  <Icon icon={X} size={12} stroke={2} />
                </button>
              </div>
            ))}
            {sites.length < MAX_SHORTCUTS && (
              <div className="ntp-tile-wrap" role="listitem">
                <button className="ntp-tile add" onClick={() => setAdding(true)}>
                  <span className="ntp-tile-icon">
                    <Icon icon={Plus} size={20} stroke={1.6} />
                  </span>
                  <span className="ntp-tile-label">Add shortcut</span>
                </button>
              </div>
            )}
          </div>
        )}
        <div className={cx('ntp-undo-slot', !showShortcuts && 'empty')} aria-live="polite">
          {removed && (
            <div className="ntp-undo" key={removed.site.id}>
              <span>Shortcut removed</span>
              <button className="ntp-undo-button" onClick={undo}>
                Undo
              </button>
            </div>
          )}
        </div>
      </div>
      <AddShortcutDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(list) => {
          setSites(list)
          setAdding(false)
        }}
      />
    </div>
  )
}

function AddShortcutDialog({
  open,
  onClose,
  onAdded
}: {
  open: boolean
  onClose: () => void
  onAdded: (list: Shortcut[]) => void
}) {
  const [title, setTitle] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle('')
    setAddress('')
    setError(null)
    setBusy(false)
  }, [open])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const url = normalizeWebAddress(address)
    if (!url) return setError('Enter a web address, such as example.com.')
    setBusy(true)
    try {
      onAdded(await window.aqua.shortcuts.add({ title: title.trim(), url }))
    } catch {
      setBusy(false)
      setError('This shortcut could not be saved.')
    }
  }

  return (
    <Dialog
      open={open}
      title="Add shortcut"
      icon={Plus}
      width={400}
      busy={busy}
      onCancel={onClose}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit" form="add-shortcut" disabled={!address.trim() || busy}>
            Add
          </button>
        </>
      }
    >
      <form id="add-shortcut" className="dialog-form" onSubmit={(e) => void submit(e)} noValidate>
        <label className="dialog-field">
          <span>Name</span>
          <input
            className="text-input"
            value={title}
            maxLength={100}
            placeholder="Optional"
            spellCheck={false}
            data-autofocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="dialog-field">
          <span>URL</span>
          <input
            className="text-input"
            value={address}
            placeholder="example.com"
            spellCheck={false}
            aria-invalid={!!error}
            onChange={(e) => {
              setAddress(e.target.value)
              setError(null)
            }}
          />
        </label>
        {error && (
          <div className="form-message error" role="alert">
            <Icon icon={CircleAlert} size={14} />
            {error}
          </div>
        )}
      </form>
    </Dialog>
  )
}
