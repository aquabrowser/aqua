import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../lib/format'
import { popupLayer } from '../lib/overlay'
import { popupStore, useStore, windowStore } from '../store'

/** Transparent margin around the card inside the overlay view, so its shadow is not clipped. */
export const POPUP_MARGIN = 20

/** A blur must last this long before it dismisses a popup (Windows flips focus during activation). */
const BLUR_GRACE_MS = 120

export interface PopupControls {
  open: boolean
  show: () => void
  close: () => void
  toggle: () => void
  /** Spread onto the button that opens the popup: toggles deterministically, whatever blur did in between. */
  anchorProps: {
    onPointerDown: (event: ReactPointerEvent) => void
    onClick: () => void
  }
}

/**
 * One popup at a time lives in the popup layer.
 *
 * Pressing the anchor button while its popup is open moves focus out of the
 * popup, which dismisses it before the click arrives. The anchor therefore
 * records the open state at pointer-down and decides on click from that, so a
 * second click always closes and never re-opens - no timing heuristics.
 */
export function usePopup(id: string, openWith?: () => void): PopupControls {
  const open = useStore(popupStore, (current) => current === id)
  const openAtPointerDown = useRef(false)
  const opener = useRef(openWith)
  opener.current = openWith
  const show = useCallback(() => popupStore.set(id), [id])
  const close = useCallback(() => {
    if (popupStore.get() === id) popupStore.set(null)
  }, [id])
  const toggle = useCallback(() => {
    if (popupStore.get() === id) close()
    else show()
  }, [id, close, show])
  const anchorProps = useMemo(
    () => ({
      onPointerDown: (event: ReactPointerEvent) => {
        if (event.button === 0) openAtPointerDown.current = popupStore.get() === id
      },
      onClick: () => {
        const wasOpen = openAtPointerDown.current || popupStore.get() === id
        openAtPointerDown.current = false
        if (wasOpen) close()
        else (opener.current ?? show)()
      }
    }),
    [id, close, show]
  )
  return { open, show, close, toggle, anchorProps }
}

interface PopupProps {
  anchorRef: RefObject<HTMLElement | null>
  /** `end`: right edges aligned (toolbar buttons). `start`: left edges aligned. */
  align?: 'start' | 'end'
  offset?: number
  width?: number
  /** Size the card to the anchor's width (omnibox suggestions). */
  matchAnchorWidth?: boolean
  /** Give the popup keyboard focus (menus, dialogs). Suggestions keep focus in the omnibox. */
  focus?: boolean
  onDismiss: () => void
  className?: string
  role?: string
  label?: string
  children: ReactNode
}

/**
 * Renders `children` into the popup overlay layer (above native web views),
 * anchored to an element of the browser UI. Handles measurement, clamping to
 * the window, Escape / blur dismissal and hiding the layer on unmount.
 */
export function Popup({
  anchorRef,
  align = 'end',
  offset = 6,
  width = 320,
  matchAnchorWidth = false,
  focus = true,
  onDismiss,
  className,
  role = 'dialog',
  label,
  children
}: PopupProps) {
  const [container] = useState(() => popupLayer.container())
  const cardRef = useRef<HTMLDivElement>(null)
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useLayoutEffect(() => {
    const card = cardRef.current
    const anchor = anchorRef.current
    const layerWindow = popupLayer.window
    if (!card || !anchor || !layerWindow) return

    const place = (): void => {
      const a = anchor.getBoundingClientRect()
      const w = matchAnchorWidth ? Math.round(a.width) : width
      const x = align === 'end' ? a.right - w : a.left
      const y = a.bottom + offset
      card.style.width = `${w}px`
      card.style.maxHeight = `${Math.max(140, window.innerHeight - y - POPUP_MARGIN)}px`
      const h = card.offsetHeight
      window.aqua.ui.showOverlay(
        'popup',
        {
          type: 'rect',
          rect: {
            x: Math.round(x - POPUP_MARGIN),
            y: Math.round(y - POPUP_MARGIN),
            width: w + POPUP_MARGIN * 2,
            height: h + POPUP_MARGIN * 2
          }
        },
        focus
      )
    }

    place()
    const Observer = (layerWindow as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver
    const observer = new Observer(() => place())
    observer.observe(card)
    if (focus) {
      const target = card.querySelector<HTMLElement>('[data-autofocus]') ?? card
      target.focus({ preventScroll: true })
      if (
        target instanceof (layerWindow as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement
      ) {
        target.select()
      }
    }
    return () => observer.disconnect()
  }, [anchorRef, align, offset, width, matchAnchorWidth, focus])

  useEffect(() => () => window.aqua.ui.hideOverlay('popup'), [])

  useEffect(() => {
    const layerWindow = popupLayer.window
    if (!layerWindow) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismissRef.current()
      }
    }
    // Only a sustained loss of focus dismisses: activation can blur and refocus within a frame.
    let blurTimer = 0
    const onBlur = (): void => {
      if (!focus) return
      window.clearTimeout(blurTimer)
      blurTimer = window.setTimeout(() => {
        if (!layerWindow.document.hasFocus()) dismissRef.current()
      }, BLUR_GRACE_MS)
    }
    const onFocus = (): void => window.clearTimeout(blurTimer)
    // The transparent shadow margin belongs to the layer: a click there is a click outside.
    const onPointerDown = (event: PointerEvent): void => {
      const card = cardRef.current
      if (card && !card.contains(event.target as Node)) dismissRef.current()
    }
    layerWindow.addEventListener('keydown', onKeyDown)
    layerWindow.addEventListener('blur', onBlur)
    layerWindow.addEventListener('focus', onFocus)
    layerWindow.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.clearTimeout(blurTimer)
      layerWindow.removeEventListener('keydown', onKeyDown)
      layerWindow.removeEventListener('blur', onBlur)
      layerWindow.removeEventListener('focus', onFocus)
      layerWindow.removeEventListener('pointerdown', onPointerDown)
    }
  }, [focus])

  // Close when the window really deactivates (alt-tab), ignoring transient flips and
  // a possibly stale "unfocused" flag at the moment the popup mounts.
  const windowFocused = useStore(windowStore, (s) => s.focused)
  const wasFocused = useRef(windowFocused)
  useEffect(() => {
    const lostFocus = wasFocused.current && !windowFocused
    wasFocused.current = windowFocused
    if (!lostFocus) return
    const timer = window.setTimeout(() => {
      if (!windowStore.get().focused) dismissRef.current()
    }, BLUR_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [windowFocused])

  if (!container) return null
  return createPortal(
    <div className="popup-frame" style={{ padding: POPUP_MARGIN }}>
      <div
        ref={cardRef}
        className={cx('popup', align === 'end' ? 'from-right' : 'from-left', className)}
        role={role}
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    container
  )
}
