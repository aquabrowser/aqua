import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  AppWindow,
  Bell,
  Camera,
  Eraser,
  HardDrive,
  Info,
  Keyboard,
  KeyRound,
  LayoutGrid,
  MapPin,
  Mic,
  Palette,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  ToggleRight,
  Users,
  X,
  type LucideIcon
} from 'lucide-react'
import { SEARCH_ENGINES } from '@shared/search'
import { normalizeWebAddress } from '@shared/url'
import type {
  AutoLockTime,
  ClearDataKind,
  ClearDataSummary,
  ContentBlockerInfo,
  FilterListGroup,
  PermissionDefaults,
  PermissionKind,
  ProtocolGrant,
  SitePermission,
  StartupBehavior,
  UpdateStatus
} from '@shared/types'
import { Dialog } from '../components/Dialog'
import { AquaMark, Icon } from '../components/Icon'
import { WipeDialog } from '../components/WipeDialog'
import { cx, formatAgo, formatBytes } from '../lib/format'
import { blockerStore, env, useSettings, useStore, windowStore, isGuest } from '../store'
import { AppearanceSection } from './settings/AppearanceSection'
import { FormMessage, plural, RadioList, Row, Switch, update } from './settings/controls'
import { NewTabSection } from './settings/NewTabSection'
import { ProfilesSection } from './settings/ProfilesSection'
import { StorageSection } from './settings/StorageSection'

type SectionId =
  | 'general'
  | 'appearance'
  | 'newtab'
  | 'privacy'
  | 'permissions'
  | 'security'
  | 'profiles'
  | 'storage'
  | 'shortcuts'
  | 'about'

const SECTIONS: Array<{ id: SectionId; label: string; icon: LucideIcon }> = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'newtab', label: 'New Tab page', icon: LayoutGrid },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck },
  { id: 'permissions', label: 'Site permissions', icon: ToggleRight },
  { id: 'security', label: 'Vault & security', icon: KeyRound },
  { id: 'profiles', label: 'Profiles', icon: Users },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard },
  { id: 'about', label: 'About Aqua', icon: Info }
]

/** A guest session has no vault password, keeps nothing on disk and is independent of the profiles. */
const GUEST_HIDDEN: ReadonlySet<SectionId> = new Set(['security', 'profiles', 'storage'])
const sectionsFor = (guest: boolean): typeof SECTIONS =>
  guest ? SECTIONS.filter((s) => !GUEST_HIDDEN.has(s.id)) : SECTIONS

const MIN_PASSWORD = 8
const MAX_STARTUP_PAGES = 20

// ─── Page ────────────────────────────────────────────────────────────────────

export function SettingsPage({ section }: { section: string }) {
  const sections = sectionsFor(isGuest())
  const fromUrl = (sections.find((s) => s.id === section)?.id ?? 'general') as SectionId
  const [active, setActive] = useState<SectionId>(fromUrl)
  // Back/forward between settings sections updates the URL; follow it.
  useEffect(() => setActive(fromUrl), [fromUrl])

  const go = (id: SectionId): void => {
    setActive(id)
    if (id !== fromUrl) void window.aqua.nav.go(`aqua://settings/${id}`)
  }
  const updates = useUpdateStatus()

  return (
    <div className="page">
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <h1>Settings</h1>
          {sections.map((s) => (
            <button key={s.id} aria-current={active === s.id ? 'page' : undefined} onClick={() => go(s.id)}>
              <Icon icon={s.icon} />
              {s.label}
              {s.id === 'about' && updates?.state === 'downloaded' && (
                <span className="nav-badge" title="An update is ready" aria-label="An update is ready" />
              )}
            </button>
          ))}
        </nav>
        <main className="settings-main" key={active}>
          {active === 'general' && <GeneralSection />}
          {active === 'appearance' && <AppearanceSection />}
          {active === 'newtab' && <NewTabSection />}
          {active === 'privacy' && <PrivacySection />}
          {active === 'permissions' && <PermissionsSection />}
          {active === 'security' && <SecuritySection />}
          {active === 'profiles' && <ProfilesSection />}
          {active === 'storage' && <StorageSection />}
          {active === 'shortcuts' && <ShortcutsSection />}
          {active === 'about' && <AboutSection updates={updates} />}
        </main>
      </div>
    </div>
  )
}

// ─── General ─────────────────────────────────────────────────────────────────

function GeneralSection() {
  const s = useSettings()
  return (
    <>
      <h2>General</h2>
      <div className="card">
        <div className="card-title">Search engine</div>
        <p className="card-intro">Used for searches typed in the address bar.</p>
        <div className="engine-grid" role="radiogroup" aria-label="Search engine">
          {Object.values(SEARCH_ENGINES).map((e) => (
            <button
              key={e.id}
              className="choice-card"
              role="radio"
              aria-checked={s.searchEngine === e.id}
              onClick={() => update({ searchEngine: e.id })}
            >
              <strong>{e.name}</strong>
              <span>{e.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">On startup</div>
        <RadioList<StartupBehavior>
          label="On startup"
          value={s.startupBehavior}
          onChange={(v) => update({ startupBehavior: v })}
          options={[
            { value: 'newtab', label: 'Open a new tab', hint: 'Start fresh every time.' },
            {
              value: 'continue',
              label: 'Continue where you left off',
              hint: 'Reopen the windows and tabs from last time.'
            },
            { value: 'pages', label: 'Open specific pages', hint: 'Open the pages listed below.' }
          ]}
        />
        {s.startupBehavior === 'pages' && <StartupPages pages={s.startupPages} />}
      </div>

      <div className="card">
        <Row label="Ask where to save each file" hint="Otherwise files go to your Downloads folder.">
          <Switch
            label="Ask where to save each file"
            checked={s.askWhereToSave}
            onChange={(v) => update({ askWhereToSave: v })}
          />
        </Row>
      </div>
    </>
  )
}

function StartupPages({ pages }: { pages: string[] }) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const tabs = useStore(windowStore, (w) => w.tabs)
  const openPages = tabs.map((t) => t.url).filter((url) => /^https?:/.test(url))

  const save = (next: string[]): void => update({ startupPages: [...new Set(next)].slice(0, MAX_STARTUP_PAGES) })

  const add = (event: FormEvent): void => {
    event.preventDefault()
    const url = normalizeWebAddress(draft)
    if (!url) return setError('That doesn’t look like a web address.')
    if (pages.includes(url)) return setError('Already in the list.')
    if (pages.length >= MAX_STARTUP_PAGES) return setError(`You can add up to ${MAX_STARTUP_PAGES} pages.`)
    save([...pages, url])
    setDraft('')
    setError(null)
  }

  return (
    <div className="startup-pages">
      {pages.length > 0 && (
        <ul className="url-list">
          {pages.map((url) => (
            <li key={url}>
              <span className="url-text" title={url}>
                {url.replace(/^https:\/\//, '').replace(/\/$/, '')}
              </span>
              <button
                className="mini-button"
                aria-label={`Remove ${url}`}
                title="Remove"
                onClick={() => save(pages.filter((p) => p !== url))}
              >
                <Icon icon={X} size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="inline-form" onSubmit={add}>
        <input
          className="text-input"
          value={draft}
          placeholder="example.com"
          aria-label="Add a startup page"
          aria-invalid={!!error}
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
        />
        <button className="btn" type="submit" disabled={!draft.trim()}>
          <Icon icon={Plus} size={14} />
          Add
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={openPages.length === 0}
          title="Replace the list with the tabs open in this window"
          onClick={() => {
            save(openPages)
            setError(null)
          }}
        >
          Use open tabs
        </button>
      </form>
      {error && <FormMessage tone="error">{error}</FormMessage>}
      {pages.length === 0 && !error && (
        <p className="muted-note">No pages yet. Until you add one, Aqua opens a new tab.</p>
      )}
    </div>
  )
}

// ─── Privacy ─────────────────────────────────────────────────────────────────

const CLEAR_OPTIONS: Array<{ kind: ClearDataKind; label: string }> = [
  { kind: 'history', label: 'Browsing history' },
  { kind: 'downloads', label: 'Download list' },
  { kind: 'cache', label: 'Cached images and files' },
  { kind: 'cookies', label: 'Cookies and other site data' }
]

function clearDetail(kind: ClearDataKind, summary: ClearDataSummary | null): string {
  if (!summary) return 'Calculating…'
  switch (kind) {
    case 'history':
      return plural(summary.historyEntries, 'entry', 'entries')
    case 'downloads':
      return `${plural(summary.downloadEntries, 'entry', 'entries')} · the files themselves stay`
    case 'cache':
      return summary.cacheBytes > 0 ? `${formatBytes(summary.cacheBytes)}` : 'Empty'
    case 'cookies':
      return `${plural(summary.cookieCount, 'cookie')} · signs you out of most sites`
  }
}

/** Exactly what "Clear data" removes, spelled out before anything is deleted. */
function purgeDescription(kind: ClearDataKind, summary: ClearDataSummary): ReactNode {
  switch (kind) {
    case 'history':
      return (
        <>
          <strong>Browsing history</strong>: {plural(summary.historyEntries, 'entry', 'entries')}, plus the address bar
          suggestions and shortcuts that come from it.
        </>
      )
    case 'downloads':
      return (
        <>
          <strong>Download list</strong>: {plural(summary.downloadEntries, 'finished download')}. The files stay where
          they are.
        </>
      )
    case 'cache':
      return (
        <>
          <strong>Cached images and files</strong>: {formatBytes(summary.cacheBytes)}. Sites may load a little slower
          next time.
        </>
      )
    case 'cookies':
      return (
        <>
          <strong>Cookies and other site data</strong>: {plural(summary.cookieCount, 'cookie')}, plus everything else
          sites keep, like local storage and IndexedDB. You’ll be signed out of most sites.
        </>
      )
  }
}

const LIST_GROUPS: ReadonlyArray<{ group: FilterListGroup; label: string; hint: string }> = [
  { group: 'ads', label: 'Ads and malware', hint: 'Ad networks, pop-up ads and sites known to spread malware.' },
  { group: 'privacy', label: 'Trackers', hint: 'Analytics, tracking pixels and fingerprinting scripts.' },
  { group: 'cookies', label: 'Cookie notices', hint: 'Hides cookie consent banners without answering them.' },
  { group: 'annoyances', label: 'Annoyances', hint: 'Newsletter pop-ups, chat widgets and “open in app” banners.' }
]

function listStatus(info: ContentBlockerInfo): string {
  if (info.status === 'loading') return 'Preparing the filter lists…'
  if (info.status === 'error') return 'No filter list could be loaded.'
  const counts = `${plural(info.filterCount, 'filter')} from ${plural(info.listCount, 'list')}`
  return info.updatedAt ? `${counts}, updated ${formatAgo(info.updatedAt)}.` : `${counts}.`
}

function PrivacySection() {
  const s = useSettings()
  const blocker = useStore(blockerStore)
  const [kinds, setKinds] = useState<Record<ClearDataKind, boolean>>({
    history: true,
    downloads: false,
    cache: true,
    cookies: false
  })
  const [summary, setSummary] = useState<ClearDataSummary | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle')
  const selected = CLEAR_OPTIONS.filter((o) => kinds[o.kind]).map((o) => o.kind)

  const refresh = useCallback(() => void window.aqua.settings.dataSummary().then(setSummary), [])
  useEffect(refresh, [refresh])

  const clear = async (): Promise<void> => {
    setState('working')
    await window.aqua.settings.clearData(selected)
    setConfirming(false)
    setState('done')
    refresh()
    window.setTimeout(() => setState((v) => (v === 'done' ? 'idle' : v)), 2600)
  }

  return (
    <>
      <h2>Privacy</h2>
      <div className="card">
        <div className="card-title">Ads and trackers</div>
        <Row
          label="Block ads and trackers"
          hint="Uses uBlock Origin’s filter lists, EasyList and EasyPrivacy, in every window including private ones."
        >
          <Switch
            label="Block ads and trackers"
            checked={s.contentBlocking}
            onChange={(v) => update({ contentBlocking: v })}
          />
        </Row>
        {LIST_GROUPS.map(({ group, label, hint }) => (
          <Row key={group} label={label} hint={hint}>
            <Switch
              label={label}
              checked={s.blockerLists[group]}
              disabled={!s.contentBlocking}
              onChange={(v) => update({ blockerLists: { ...s.blockerLists, [group]: v } })}
            />
          </Row>
        ))}
        <Row
          label="Filter lists"
          hint={
            <>
              {listStatus(blocker)}
              {blocker.updateError && <span className="text-danger"> {blocker.updateError}</span>}
            </>
          }
        >
          <button
            className="btn"
            disabled={blocker.updating || !s.contentBlocking}
            onClick={() => void window.aqua.blocker.updateLists()}
          >
            {blocker.updating ? 'Updating…' : 'Update now'}
          </button>
        </Row>
        {s.blockerPausedSites.length > 0 && (
          <>
            <div className="card-subtitle">Paused on</div>
            {s.blockerPausedSites.map((host) => (
              <Row key={host} label={host}>
                <button
                  className="btn small ghost"
                  onClick={() => update({ blockerPausedSites: s.blockerPausedSites.filter((h) => h !== host) })}
                >
                  Resume
                </button>
              </Row>
            ))}
          </>
        )}
      </div>

      <div className="card">
        <div className="card-title">Tracking protection</div>
        <Row
          label="Strip tracking parameters"
          hint="Removes tags like utm_source and fbclid from links. If a sign-in link stops working, try turning this off."
        >
          <Switch
            label="Strip tracking parameters"
            checked={s.stripTrackingParams}
            onChange={(v) => update({ stripTrackingParams: v })}
          />
        </Row>
      </div>

      <div className="card">
        <div className="card-title">Screen capture</div>
        <Row
          label="Hide from screen capture"
          hint="Screenshots, recordings, OBS and screen sharing in apps like Discord show nothing where Aqua’s windows are. Menus and file dialogs can still appear."
        >
          <Switch
            label="Hide from screen capture"
            checked={s.hideFromCapture}
            onChange={(v) => update({ hideFromCapture: v })}
          />
        </Row>
      </div>

      <div className="card">
        <div className="card-title">Voice and video calls</div>
        <Row
          label="Calls only through a proxy"
          hint={
            s.webrtcProxyOnly
              ? 'Voice and video calls never bypass your proxy. Without a proxy, calls on sites like Discord can’t connect.'
              : 'Calls use your main connection (your VPN’s, when it’s on) and never share local network addresses.'
          }
        >
          <Switch
            label="Calls only through a proxy"
            checked={s.webrtcProxyOnly}
            onChange={(v) => update({ webrtcProxyOnly: v })}
          />
        </Row>
      </div>

      <div className="card">
        <div className="card-title">Clear browsing data</div>
        <div className="check-list">
          {CLEAR_OPTIONS.map(({ kind, label }) => (
            <label key={kind} className="check-row">
              <input
                type="checkbox"
                checked={kinds[kind]}
                onChange={(e) => setKinds((k) => ({ ...k, [kind]: e.target.checked }))}
              />
              <span className="text">
                <span className="label">{label}</span>
                <span className="hint">{clearDetail(kind, summary)}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="card-row">
          <div className="text">{state === 'done' && <FormMessage tone="success">Data cleared</FormMessage>}</div>
          <button
            className="btn danger"
            disabled={state === 'working' || selected.length === 0}
            onClick={() => {
              refresh()
              setConfirming(true)
            }}
          >
            Clear data…
          </button>
        </div>
      </div>

      <Dialog
        open={confirming}
        title="Clear browsing data?"
        icon={Eraser}
        tone="danger"
        width={480}
        busy={state === 'working'}
        onCancel={() => setConfirming(false)}
        footer={
          <>
            <button className="btn ghost" disabled={state === 'working'} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className="btn danger-fill"
              data-autofocus
              disabled={state === 'working' || !summary}
              onClick={() => void clear()}
            >
              {state === 'working' ? 'Clearing…' : 'Clear data'}
            </button>
          </>
        }
      >
        <p>This permanently deletes:</p>
        {summary && (
          <ul className="dialog-list">
            {selected.map((kind) => (
              <li key={kind}>{purgeDescription(kind, summary)}</li>
            ))}
          </ul>
        )}
        <p className="dialog-note">Bookmarks, site permissions and blocking settings are kept. There’s no undo.</p>
      </Dialog>
    </>
  )
}

// ─── Site permissions ────────────────────────────────────────────────────────

const PERMISSION_NAMES: Record<PermissionKind, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  midi: 'MIDI devices',
  'clipboard-read': 'Clipboard'
}

const DEFAULTS: Array<{ kind: keyof PermissionDefaults; icon: LucideIcon; ask: string; blocked: string }> = [
  {
    kind: 'camera',
    icon: Camera,
    ask: 'Sites can ask to use your camera',
    blocked: 'Sites are not allowed to use your camera'
  },
  {
    kind: 'microphone',
    icon: Mic,
    ask: 'Sites can ask to use your microphone',
    blocked: 'Sites are not allowed to use your microphone'
  },
  {
    kind: 'geolocation',
    icon: MapPin,
    ask: 'Sites can ask for your location',
    blocked: 'Sites are not allowed to see your location'
  },
  {
    kind: 'notifications',
    icon: Bell,
    ask: 'Sites can ask to send notifications',
    blocked: 'Sites are not allowed to send notifications'
  }
]

function hostLabel(origin: string): string {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' ? url.host : origin
  } catch {
    return origin
  }
}

function PermissionsSection() {
  const s = useSettings()
  const [permissions, setPermissions] = useState<SitePermission[]>([])
  const [grants, setGrants] = useState<ProtocolGrant[]>([])

  const refresh = useCallback(() => {
    void window.aqua.site.permissions().then(setPermissions)
    void window.aqua.site.protocolGrants().then(setGrants)
  }, [])
  useEffect(refresh, [refresh])

  const setDefault = (kind: keyof PermissionDefaults, allowAsk: boolean): void =>
    update({ permissionDefaults: { ...s.permissionDefaults, [kind]: allowAsk ? 'ask' : 'block' } })

  return (
    <>
      <h2>Site permissions</h2>
      <div className="card">
        <div className="card-title">Default behavior</div>
        <p className="card-intro">
          If a site is allowed to ask, Aqua asks you once and remembers your answer for that site.
        </p>
        {DEFAULTS.map(({ kind, icon, ask, blocked }) => {
          const on = s.permissionDefaults[kind] === 'ask'
          return (
            <div className="card-row" key={kind}>
              <span className={cx('row-icon', !on && 'off')}>
                <Icon icon={icon} size={16} />
              </span>
              <div className="text">
                <div className="label">{PERMISSION_NAMES[kind]}</div>
                <div className="hint">{on ? ask : blocked}</div>
              </div>
              <Switch
                label={`${PERMISSION_NAMES[kind]}: sites can ask`}
                checked={on}
                onChange={(v) => setDefault(kind, v)}
              />
            </div>
          )
        })}
      </div>

      <div className="card">
        <div className="card-title">Site exceptions</div>
        {permissions.length === 0 ? (
          <p className="card-intro last">Nothing yet. Choices you make on individual sites show up here.</p>
        ) : (
          permissions.map((p) => (
            <Row
              key={`${p.origin}:${p.permission}`}
              label={hostLabel(p.origin)}
              hint={
                <>
                  {PERMISSION_NAMES[p.permission]} ·{' '}
                  <span className={p.decision === 'allow' ? 'text-success' : 'text-danger'}>
                    {p.decision === 'allow' ? 'Allowed' : 'Blocked'}
                  </span>
                </>
              }
            >
              <button
                className="btn small"
                onClick={() => void window.aqua.site.resetPermission(p.origin, p.permission).then(refresh)}
              >
                Reset
              </button>
            </Row>
          ))
        )}
      </div>

      <div className="card">
        <div className="card-title">External applications</div>
        {grants.length === 0 ? (
          <p className="card-intro last">
            Sites ask before opening apps like Discord or Steam. The ones you’ve let skip that step show up here.
          </p>
        ) : (
          grants.map((g) => (
            <div className="card-row" key={`${g.origin}:${g.scheme}`}>
              <span className="row-icon">
                <Icon icon={AppWindow} size={16} />
              </span>
              <div className="text">
                <div className="label">{hostLabel(g.origin)}</div>
                <div className="hint">
                  Opens <code>{g.scheme}:</code> links without asking
                </div>
              </div>
              <button
                className="btn small"
                onClick={() => void window.aqua.site.revokeGrant(g.origin, g.scheme).then(refresh)}
              >
                Revoke
              </button>
            </div>
          ))
        )}
      </div>
    </>
  )
}

// ─── Vault & security ────────────────────────────────────────────────────────

function ChangePasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if ([...next].length < MIN_PASSWORD)
      return setMessage({ tone: 'error', text: `Use at least ${MIN_PASSWORD} characters.` })
    if (next !== confirm) return setMessage({ tone: 'error', text: 'The new passwords don’t match.' })
    setBusy(true)
    setMessage(null)
    const result = await window.aqua.vault.changePassword(current, next)
    setBusy(false)
    if (!result.success) return setMessage({ tone: 'error', text: result.error ?? 'Something went wrong.' })
    setMessage({ tone: 'success', text: 'Master password changed.' })
    setCurrent('')
    setNext('')
    setConfirm('')
  }

  return (
    <form className="form-grid" onSubmit={(e) => void submit(e)}>
      <input
        className="text-input"
        type="password"
        placeholder="Current password"
        aria-label="Current password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <input
        className="text-input"
        type="password"
        placeholder="New password"
        aria-label="New password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <input
        className="text-input"
        type="password"
        placeholder="Confirm new password"
        aria-label="Confirm new password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      <div>
        <button className="btn primary" type="submit" disabled={busy || !current || !next || !confirm}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </form>
  )
}

function SecuritySection() {
  const s = useSettings()
  const [wipeOpen, setWipeOpen] = useState(false)
  const lockKeys = env.platform === 'darwin' ? '⇧⌘L' : 'Ctrl+Shift+L'

  return (
    <>
      <h2>Vault & security</h2>
      <div className="card">
        <Row
          label="Vault"
          hint="Your tabs, history, cookies, site data, bookmarks and settings are encrypted with your master password."
        >
          <button className="btn" title={lockKeys} onClick={() => void window.aqua.vault.lock()}>
            Lock now
          </button>
        </Row>
        <Row
          label="Lock automatically"
          hint="After this long without any input. Aqua also locks when your computer does."
        >
          <select
            className="select"
            value={s.autoLockTimer}
            onChange={(e) => update({ autoLockTimer: e.target.value as AutoLockTime })}
          >
            <option value="1m">After 1 minute</option>
            <option value="5m">After 5 minutes</option>
            <option value="15m">After 15 minutes</option>
            <option value="30m">After 30 minutes</option>
            <option value="1h">After 1 hour</option>
            <option value="never">Never</option>
          </select>
        </Row>
      </div>

      <div className="card">
        <div className="card-title">Change master password</div>
        <p className="card-intro">
          There’s no way to recover a forgotten master password, so pick one you’ll remember.
        </p>
        <ChangePasswordForm />
      </div>

      <div className="card danger-zone">
        <Row label="Wipe vault and reset Aqua" hint="Deletes everything Aqua keeps on this device, then restarts.">
          <button className="btn danger" onClick={() => setWipeOpen(true)}>
            Wipe…
          </button>
        </Row>
      </div>
      <WipeDialog open={wipeOpen} onClose={() => setWipeOpen(false)} />
    </>
  )
}

// ─── Shortcuts / About ───────────────────────────────────────────────────────

function ShortcutsSection() {
  const mac = env.platform === 'darwin'
  const m = mac ? '⌘' : 'Ctrl'
  const rows: Array<[string, string[]]> = [
    ['New tab', [m, 'T']],
    ['Close tab', [m, 'W']],
    ['Reopen closed tab', [m, 'Shift', 'T']],
    ['Next tab', ['Ctrl', 'Tab']],
    ['Previous tab', ['Ctrl', 'Shift', 'Tab']],
    ['Go to tab 1 to 8', [m, '1…8']],
    ['Go to the last tab', [m, '9']],
    ['New window', [m, 'N']],
    ['New private window', [m, 'Shift', 'N']],
    ['Close window', [m, 'Shift', 'W']],
    ['Focus the address bar', [m, 'L']],
    ['Reload', mac ? ['⌘', 'R'] : ['F5']],
    ['Reload without the cache', [m, 'Shift', 'R']],
    ['Back', mac ? ['⌘', '['] : ['Alt', '←']],
    ['Forward', mac ? ['⌘', ']'] : ['Alt', '→']],
    ['Find in page', [m, 'F']],
    ['Find next', mac ? ['⌘', 'G'] : ['F3']],
    ['Find previous', mac ? ['⌘', 'Shift', 'G'] : ['Shift', 'F3']],
    ['Bookmark this page', [m, 'D']],
    ['Show or hide the bookmarks bar', [m, 'Shift', 'B']],
    ['History', mac ? ['⌘', 'Y'] : ['Ctrl', 'H']],
    ['Downloads', mac ? ['⌘', 'Shift', 'J'] : ['Ctrl', 'J']],
    ['Zoom in', [m, '+']],
    ['Zoom out', [m, '−']],
    ['Reset zoom', [m, '0']],
    ['Print', [m, 'P']],
    ['View page source', [m, 'U']],
    ['Full screen', mac ? ['⌃', '⌘', 'F'] : ['F11']],
    ['Developer tools', mac ? ['⌥', '⌘', 'I'] : ['F12']],
    ['Lock Aqua', [m, 'Shift', 'L']]
  ]
  return (
    <>
      <h2>Keyboard shortcuts</h2>
      <div className="card">
        <table className="kbd-table">
          <tbody>
            {rows.map(([label, keys]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>
                  {keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** The updater's state, live (main/services/updater.ts). */
function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.aqua.updater.status().then((s) => live && setStatus(s))
    const off = window.aqua.updater.onStatus(setStatus)
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}

const RELEASES_URL = 'https://github.com/aquabrowser/aqua/releases'

function UpdateRow({ status }: { status: UpdateStatus | null }) {
  if (!status) return null
  const check = (
    <button className="btn" onClick={() => void window.aqua.updater.check()}>
      Check for updates
    </button>
  )
  switch (status.state) {
    case 'disabled':
      return status.reason === 'portable' ? (
        <Row label="Updates" hint="A portable copy doesn’t update itself. New versions are on the Releases page.">
          <button className="btn" onClick={() => void window.aqua.nav.go(RELEASES_URL, { disposition: 'new-tab' })}>
            Open Releases
          </button>
        </Row>
      ) : status.reason === 'other-profile' ? (
        <Row label="Updates" hint="Updates are installed from your default profile’s windows." />
      ) : (
        <Row label="Updates" hint="Off in development builds." />
      )
    case 'idle':
      return (
        <Row label="Updates" hint="New versions come from GitHub Releases.">
          {check}
        </Row>
      )
    case 'checking':
      return <Row label="Updates" hint="Checking for updates…" />
    case 'up-to-date':
      return (
        <Row label="Updates" hint={`Aqua is up to date. Checked ${formatAgo(status.checkedAt)}.`}>
          {check}
        </Row>
      )
    case 'downloading':
      return (
        <Row label="Updates" hint={`Downloading version ${status.version}… ${status.percent}%`}>
          <span className="update-progress" aria-hidden>
            <span style={{ width: `${status.percent}%` }} />
          </span>
        </Row>
      )
    case 'downloaded':
      return (
        <div className="card-row update-ready">
          <div className="text">
            <div className="label">Version {status.version} is ready</div>
            <div className="hint">It installs when Aqua restarts.</div>
          </div>
          <button className="btn primary" onClick={() => void window.aqua.updater.restart()}>
            Restart to update
          </button>
        </div>
      )
    case 'error':
      return (
        <Row label="Updates" hint="Couldn’t check for updates. Try again later.">
          {check}
        </Row>
      )
  }
}

function AboutSection({ updates }: { updates: UpdateStatus | null }) {
  const v = env.versions
  return (
    <>
      <h2>About Aqua</h2>
      <div className="card">
        <div className="card-row about-row">
          <AquaMark size={44} />
          <div className="text">
            <div className="label about-name">Aqua</div>
            <div className="hint">Version {v.app}</div>
          </div>
        </div>
        <UpdateRow status={updates} />
        <Row label="Chromium" hint={v.chrome} />
        <Row label="Electron" hint={v.electron} />
        <Row label="Node.js / V8" hint={`${v.node} / ${v.v8}`} />
      </div>
    </>
  )
}
