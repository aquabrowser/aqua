import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import {
  AppWindow,
  Bell,
  Camera,
  Clipboard,
  Download,
  MapPin,
  Mic,
  Monitor,
  Music,
  X,
  type LucideIcon
} from 'lucide-react'
import type { PermissionKind, PromptRequest, PromptResponse } from '@shared/types'
import { Icon } from '../components/Icon'
import { POPUP_MARGIN } from '../components/Popup'
import { cx } from '../lib/format'
import { modalLayer } from '../lib/overlay'
import { env, useStore, windowStore } from '../store'

type DialogRequest = Extract<PromptRequest, { kind: 'alert' | 'confirm' | 'prompt' }>
type ExternalRequest = Extract<PromptRequest, { kind: 'external' }>
type PermissionRequest = Extract<PromptRequest, { kind: 'permission' }>
type DownloadsRequest = Extract<PromptRequest, { kind: 'downloads' }>
type CaptureRequest = Extract<PromptRequest, { kind: 'display-capture' }>
type LeaveRequest = Extract<PromptRequest, { kind: 'leave' }>
type UnresponsiveRequest = Extract<PromptRequest, { kind: 'unresponsive' }>

const PERMISSION_TEXT: Record<PermissionKind, { text: string; icon: LucideIcon }> = {
  camera: { text: 'Use your camera', icon: Camera },
  microphone: { text: 'Use your microphone', icon: Mic },
  geolocation: { text: 'Know your location', icon: MapPin },
  notifications: { text: 'Show notifications', icon: Bell },
  midi: { text: 'Use your MIDI devices', icon: Music },
  'clipboard-read': { text: 'See text and images copied to the clipboard', icon: Clipboard }
}

const respond = (id: string, response: PromptResponse): void => void window.aqua.prompts.respond(id, response)

/** Host shown in prompt titles; empty for opaque origins (sandboxed frames, data: URLs). */
function hostOf(origin: string): string {
  try {
    const url = new URL(origin)
    return url.protocol === 'file:' ? '' : url.host
  } catch {
    return ''
  }
}

/**
 * Renders the active tab's oldest pending prompt into the modal overlay
 * layer. Prompts of background tabs wait (their tab shows an indicator) and
 * appear when the tab is selected - exactly like Chrome's tab-modal dialogs.
 */
export function PromptLayer() {
  const prompt = useStore(windowStore, (s) => s.prompts.find((p) => p.tabId === s.activeTabId) ?? null)
  const [container] = useState(() => modalLayer.container())

  useEffect(() => {
    if (!prompt) window.aqua.ui.hideOverlay('modal')
  }, [prompt])
  useEffect(() => () => window.aqua.ui.hideOverlay('modal'), [])

  if (!prompt || !container) return null
  let content
  switch (prompt.kind) {
    case 'permission':
      content = <PermissionBubble key={prompt.id} request={prompt} />
      break
    case 'downloads':
      content = <DownloadsBubble key={prompt.id} request={prompt} />
      break
    case 'display-capture':
      content = <ScreenSharePicker key={prompt.id} request={prompt} />
      break
    case 'leave':
      content = <LeaveDialog key={prompt.id} request={prompt} />
      break
    case 'unresponsive':
      content = <UnresponsiveDialog key={prompt.id} request={prompt} />
      break
    case 'external':
      content = <ExternalDialog key={prompt.id} request={prompt} />
      break
    default:
      content = <PageDialog key={prompt.id} request={prompt} />
  }
  return createPortal(content, container)
}

// ─── Tab-modal card ──────────────────────────────────────────────────────────

/**
 * Scrim over the page plus a centred card. The page cannot be used while it
 * is up, but the rest of the browser can (other tabs, the address bar).
 */
function ModalCard({
  labelledBy,
  describedBy,
  onEscape,
  onEnter,
  className,
  children
}: {
  labelledBy: string
  describedBy: string
  onEscape: () => void
  onEnter: () => void
  className?: string
  children: ReactNode
}) {
  const cardRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    window.aqua.ui.showOverlay('modal', { type: 'content' }, true)
    const card = cardRef.current
    const target = card?.querySelector<HTMLElement>('[data-autofocus]') ?? card
    target?.focus({ preventScroll: true })
    // The card lives in the overlay document: compare tag names, not constructors from this realm.
    if (target?.tagName === 'INPUT') (target as HTMLInputElement).select()
  }, [])

  // Clicking outside a modal dialog does not dismiss it; the card acknowledges the click instead.
  const nudge = (): void => {
    cardRef.current?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.018)' }, { transform: 'scale(1)' }], {
      duration: 220,
      easing: 'cubic-bezier(0.2, 0, 0, 1)'
    })
  }

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onEscape()
    } else if (event.key === 'Enter' && !event.shiftKey && (event.target as Element).tagName !== 'BUTTON') {
      event.preventDefault()
      onEnter()
    }
  }

  return (
    <div className="prompt-scrim" onPointerDown={(e) => e.target === e.currentTarget && nudge()}>
      <div
        ref={cardRef}
        className={cx('prompt-card', className)}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  )
}

function PageDialog({ request }: { request: DialogRequest }) {
  const [value, setValue] = useState(request.defaultValue)
  const [suppress, setSuppress] = useState(false)
  const titleId = useId()
  const messageId = useId()
  const host = hostOf(request.origin)
  const title = !host ? 'This page says' : request.embedded ? `An embedded page at ${host} says` : `${host} says`

  const answer = (accepted: boolean): void =>
    respond(request.id, {
      kind: 'dialog',
      accepted,
      value: request.kind === 'prompt' && accepted ? value : undefined,
      suppress: request.offerSuppress ? suppress : undefined
    })
  const cancel = (): void => answer(request.kind === 'alert')

  return (
    <ModalCard labelledBy={titleId} describedBy={messageId} onEscape={cancel} onEnter={() => answer(true)}>
      <h2 id={titleId} className="prompt-title">
        {title}
      </h2>
      <div id={messageId} className="prompt-message">
        {request.message}
      </div>
      {request.kind === 'prompt' && (
        <input
          className="text-input prompt-input"
          value={value}
          aria-label="Response"
          spellCheck={false}
          data-autofocus
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      {request.offerSuppress && (
        <label className="checkbox-row prompt-check">
          <input type="checkbox" checked={suppress} onChange={(e) => setSuppress(e.target.checked)} />
          Don’t allow this page to show more dialogs
        </label>
      )}
      <div className="prompt-actions">
        {request.kind !== 'alert' && (
          <button className="btn" onClick={() => answer(false)}>
            Cancel
          </button>
        )}
        <button
          className="btn primary"
          onClick={() => answer(true)}
          data-autofocus={request.kind !== 'prompt' || undefined}
        >
          OK
        </button>
      </div>
    </ModalCard>
  )
}

function ExternalDialog({ request }: { request: ExternalRequest }) {
  const [remember, setRemember] = useState(false)
  const titleId = useId()
  const messageId = useId()
  const host = hostOf(request.origin)
  const app = request.appName
  const answer = (allow: boolean): void =>
    respond(request.id, { kind: 'external', allow, remember: allow && remember && request.canRemember })
  const shownUrl = request.url.length > 120 ? `${request.url.slice(0, 119)}…` : request.url

  let detail: ReactNode
  if (app) {
    detail = host ? (
      <>
        <strong>{host}</strong> wants to open this application.
      </>
    ) : (
      'The address you entered opens this application.'
    )
  } else {
    detail = host ? (
      <>
        <strong>{host}</strong> wants to open a <code>{request.scheme}:</code> link. No app is set up for it yet.
      </>
    ) : (
      <>
        No app is set up to open <code>{request.scheme}:</code> links yet.
      </>
    )
  }

  return (
    <ModalCard labelledBy={titleId} describedBy={messageId} onEscape={() => answer(false)} onEnter={() => answer(true)}>
      <div className="prompt-app">
        <span className={cx('prompt-app-icon', request.appIcon && 'has-image')}>
          {request.appIcon ? (
            <img src={request.appIcon} alt="" width={28} height={28} draggable={false} />
          ) : (
            <Icon icon={AppWindow} size={20} stroke={1.6} />
          )}
        </span>
        <div>
          <h2 id={titleId} className="prompt-title">
            {app ? `Open ${app}?` : 'Open with another app?'}
          </h2>
          <p id={messageId} className="prompt-detail">
            {detail}
          </p>
        </div>
      </div>
      <div className="prompt-url" title={request.url}>
        {shownUrl}
      </div>
      {request.canRemember && (
        <label className="checkbox-row prompt-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Always allow {host} to open this application
        </label>
      )}
      <div className="prompt-actions">
        <button className="btn" onClick={() => answer(false)}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => answer(true)} data-autofocus>
          {app ? `Open ${app}` : 'Choose an app…'}
        </button>
      </div>
    </ModalCard>
  )
}

// ─── Leaving a page, a page that hangs ──────────────────────────────────────

/** The page asked to confirm leaving it (unsaved changes). Staying is the safe default for Esc. */
function LeaveDialog({ request }: { request: LeaveRequest }) {
  const titleId = useId()
  const messageId = useId()
  const host = hostOf(request.origin)
  const answer = (leave: boolean): void => respond(request.id, { kind: 'leave', leave })
  return (
    <ModalCard labelledBy={titleId} describedBy={messageId} onEscape={() => answer(false)} onEnter={() => answer(true)}>
      <h2 id={titleId} className="prompt-title">
        Leave site?
      </h2>
      <p id={messageId} className="prompt-detail">
        {host ? (
          <>
            Changes you made on <strong>{host}</strong> may not be saved.
          </>
        ) : (
          'Changes you made may not be saved.'
        )}
      </p>
      <div className="prompt-actions">
        <button className="btn" onClick={() => answer(false)}>
          Stay
        </button>
        <button className="btn primary" onClick={() => answer(true)} data-autofocus>
          Leave
        </button>
      </div>
    </ModalCard>
  )
}

/** The page stopped responding. Waiting is the default; it goes away by itself if the page recovers. */
function UnresponsiveDialog({ request }: { request: UnresponsiveRequest }) {
  const titleId = useId()
  const messageId = useId()
  const answer = (exit: boolean): void => respond(request.id, { kind: 'unresponsive', exit })
  const title = request.title.length > 80 ? `${request.title.slice(0, 79)}…` : request.title
  return (
    <ModalCard
      labelledBy={titleId}
      describedBy={messageId}
      onEscape={() => answer(false)}
      onEnter={() => answer(false)}
    >
      <h2 id={titleId} className="prompt-title">
        Page unresponsive
      </h2>
      <p id={messageId} className="prompt-detail">
        “{title}” isn’t responding. You can wait for it, or end it and reload later.
      </p>
      <div className="prompt-actions">
        <button className="btn danger" onClick={() => answer(true)}>
          End page
        </button>
        <button className="btn primary" onClick={() => answer(false)} data-autofocus>
          Wait
        </button>
      </div>
    </ModalCard>
  )
}

// ─── Screen sharing ──────────────────────────────────────────────────────────

/**
 * getDisplayMedia(): the page gets nothing until the user picks a screen or a
 * window here. System audio can come with a whole screen (Windows).
 */
function ScreenSharePicker({ request }: { request: CaptureRequest }) {
  const screens = request.sources.filter((s) => s.kind === 'screen')
  const windows = request.sources.filter((s) => s.kind === 'window')
  const [view, setView] = useState<'screen' | 'window'>(screens.length > 0 ? 'screen' : 'window')
  const [selected, setSelected] = useState<string | null>(screens.length === 1 ? screens[0].id : null)
  const [audio, setAudio] = useState(false)
  const titleId = useId()
  const messageId = useId()
  const host = hostOf(request.origin) || 'This page'
  const shown = view === 'screen' ? screens : windows
  const choice = request.sources.find((s) => s.id === selected) ?? null
  const offerAudio = request.audio && choice?.kind === 'screen' && env.platform === 'win32'

  const share = (id = selected): void => {
    const source = request.sources.find((s) => s.id === id)
    if (!source) return
    const withAudio = request.audio && source.kind === 'screen' && env.platform === 'win32' && audio
    respond(request.id, { kind: 'display-capture', sourceId: source.id, audio: withAudio })
  }
  const cancel = (): void => respond(request.id, { kind: 'display-capture', sourceId: null, audio: false })

  return (
    <ModalCard
      labelledBy={titleId}
      describedBy={messageId}
      onEscape={cancel}
      onEnter={() => share()}
      className="share-card"
    >
      <h2 id={titleId} className="prompt-title">
        Share your screen with {host}?
      </h2>
      <p id={messageId} className="prompt-detail">
        The site sees everything in what you choose until you stop sharing.
      </p>
      {screens.length > 0 && windows.length > 0 && (
        <div className="segmented share-tabs" role="radiogroup" aria-label="What to share">
          <button role="radio" aria-checked={view === 'screen'} onClick={() => setView('screen')}>
            <Icon icon={Monitor} size={14} />
            Entire screen
          </button>
          <button role="radio" aria-checked={view === 'window'} onClick={() => setView('window')}>
            <Icon icon={AppWindow} size={14} />
            Window
          </button>
        </div>
      )}
      <div className={cx('share-grid', view)} role="listbox" aria-label={view === 'screen' ? 'Screens' : 'Windows'}>
        {shown.map((source, index) => (
          <button
            key={source.id}
            role="option"
            aria-selected={selected === source.id}
            className={cx('share-item', selected === source.id && 'selected')}
            title={source.name}
            data-autofocus={index === 0 || undefined}
            onClick={() => setSelected(source.id)}
            onDoubleClick={() => share(source.id)}
          >
            <span className="share-thumb">
              {source.thumbnail ? (
                <img src={source.thumbnail} alt="" draggable={false} />
              ) : (
                <Icon icon={source.kind === 'screen' ? Monitor : AppWindow} size={22} stroke={1.5} />
              )}
            </span>
            <span className="share-name">
              {source.icon && <img src={source.icon} alt="" width={14} height={14} draggable={false} />}
              <span>{source.name}</span>
            </span>
          </button>
        ))}
      </div>
      {offerAudio && (
        <label className="checkbox-row prompt-check">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          Also share system audio
        </label>
      )}
      <div className="prompt-actions">
        <button className="btn" onClick={cancel}>
          Cancel
        </button>
        <button className="btn primary" disabled={!choice} onClick={() => share()}>
          Share
        </button>
      </div>
    </ModalCard>
  )
}

// ─── Permission bubble ───────────────────────────────────────────────────────

function PermissionBubble({ request }: { request: PermissionRequest }) {
  return (
    <AnchoredBubble
      host={hostOf(request.origin) || request.origin}
      items={request.permissions.map((kind) => PERMISSION_TEXT[kind])}
      onDecide={(decision) => respond(request.id, { kind: 'permission', decision })}
    />
  )
}

/** The page started another download without a click (see DownloadGate in the main process). */
function DownloadsBubble({ request }: { request: DownloadsRequest }) {
  const name = request.filename.length > 60 ? `${request.filename.slice(0, 59)}…` : request.filename
  return (
    <AnchoredBubble
      host={hostOf(request.origin) || 'This page'}
      items={[{ text: 'Download multiple files', icon: Download }]}
      detail={name ? `“${name}” is waiting.` : undefined}
      onDecide={(decision) => respond(request.id, { kind: 'downloads', decision })}
    />
  )
}

/**
 * Anchored to the site-information chip, like Chrome's permission prompt. It
 * does not block the page: ignoring it (or pressing Esc) leaves the request
 * unanswered, which the site sees as "not granted".
 */
function AnchoredBubble({
  host,
  items,
  detail,
  onDecide
}: {
  host: string
  items: ReadonlyArray<{ text: string; icon: LucideIcon }>
  detail?: string
  onDecide: (decision: 'allow' | 'block' | 'dismiss') => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const decide = onDecide

  useLayoutEffect(() => {
    const card = cardRef.current
    const layerWindow = modalLayer.window
    if (!card || !layerWindow) return
    const place = (): void => {
      const chip = document.querySelector('.omnibox-chip')?.getBoundingClientRect()
      const x = Math.max(8, (chip?.left ?? 88) - 6)
      const y = (chip?.bottom ?? 84) + 8
      window.aqua.ui.showOverlay(
        'modal',
        {
          type: 'rect',
          rect: {
            x: Math.round(x - POPUP_MARGIN),
            y: Math.round(y - POPUP_MARGIN),
            width: card.offsetWidth + POPUP_MARGIN * 2,
            height: card.offsetHeight + POPUP_MARGIN * 2
          }
        },
        true
      )
    }
    place()
    card.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
    const Observer = (layerWindow as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver
    const observer = new Observer(place)
    observer.observe(card)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [])

  return (
    <div className="popup-frame" style={{ padding: POPUP_MARGIN }}>
      <div
        ref={cardRef}
        className="popup from-left permission-bubble"
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            decide('dismiss')
          }
        }}
      >
        <div className="permission-head">
          <h2 id={titleId}>
            <strong>{host}</strong> wants to
          </h2>
          <button className="mini-button" aria-label="Dismiss" title="Dismiss" onClick={() => decide('dismiss')}>
            <Icon icon={X} size={14} />
          </button>
        </div>
        <ul className="permission-list">
          {items.map((item) => (
            <li key={item.text}>
              <Icon icon={item.icon} size={16} />
              {item.text}
            </li>
          ))}
        </ul>
        {detail && <p className="permission-detail">{detail}</p>}
        <div className="permission-actions">
          <button className="btn" onClick={() => decide('block')}>
            Block
          </button>
          <button className="btn primary" onClick={() => decide('allow')} data-autofocus>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
