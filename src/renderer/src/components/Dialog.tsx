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
import type { LucideIcon } from 'lucide-react'
import { cx } from '../lib/format'
import { Icon } from './Icon'

/** Matches the `dialog-out` animation in dialogs.css. */
const EXIT_MS = 120

interface DialogProps {
  open: boolean
  title: string
  icon?: LucideIcon
  tone?: 'default' | 'danger'
  width?: number
  /** Esc, the Cancel button and a click on the backdrop call this (unless `busy`). */
  onCancel: () => void
  /** Blocks dismissal while an irreversible action runs. */
  busy?: boolean
  footer: ReactNode
  children: ReactNode
}

/**
 * Modal dialog for Aqua's own pages (Settings, the lock screen). Keeps focus
 * inside while open, restores it afterwards, and animates in and out.
 * Tab-modal dialogs for web pages are separate (see PromptLayer).
 */
export function Dialog({
  open,
  title,
  icon,
  tone = 'default',
  width = 440,
  onCancel,
  busy,
  footer,
  children
}: DialogProps) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  const busyRef = useRef(busy)
  busyRef.current = busy
  const titleId = useId()

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    setClosing(true)
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

  useLayoutEffect(() => {
    if (!open || !mounted) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const card = cardRef.current
    const target = card?.querySelector<HTMLElement>('[data-autofocus]') ?? card
    target?.focus({ preventScroll: true })
    return () => returnFocus.current?.focus({ preventScroll: true })
  }, [open, mounted])

  if (!mounted) return null

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      if (!busyRef.current) cancelRef.current()
      return
    }
    if (event.key !== 'Tab') return
    // Focus trap: cycle within the dialog.
    const focusable = [
      ...(cardRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
      ) ?? [])
    ]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className={cx('dialog-backdrop', closing && 'closing')}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busyRef.current) cancelRef.current()
      }}
    >
      <div
        ref={cardRef}
        className={cx('dialog', tone === 'danger' && 'danger', closing && 'closing')}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-header">
          {icon && (
            <span className="dialog-icon">
              <Icon icon={icon} size={18} stroke={1.7} />
            </span>
          )}
          <h2 id={titleId}>{title}</h2>
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-footer">{footer}</div>
      </div>
    </div>,
    document.body
  )
}
