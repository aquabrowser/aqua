import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { Icon } from '../components/Icon'
import { cx } from '../lib/format'
import { findLayer } from '../lib/overlay'
import { findStore, useStore } from '../store'

const WIDTH = 380
const HEIGHT = 44
/** Shadow margin inside the overlay view. */
const MARGIN = 20

/**
 * Chrome-style floating find bar, rendered into its own overlay layer pinned
 * to the top-right of the web content (the main process keeps it anchored
 * during window resizes, so it never lags behind the page).
 */
export function FindBar() {
  const find = useStore(findStore)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const lastToken = useRef(-1)
  const lastTab = useRef<string | null>(null)

  const open = !!find?.open

  useEffect(() => {
    if (open && !container) setContainer(findLayer.container())
  }, [open, container])

  // Re-seed the input when the bar opens for a (different) tab.
  useLayoutEffect(() => {
    if (!find) {
      lastTab.current = null
      return
    }
    if (lastTab.current !== find.tabId) {
      lastTab.current = find.tabId
      setText(find.text)
    }
  }, [find])

  useLayoutEffect(() => {
    if (!find || !container) {
      window.aqua.ui.hideOverlay('findbar')
      return
    }
    const refocus = find.focusToken !== lastToken.current
    lastToken.current = find.focusToken
    window.aqua.ui.showOverlay(
      'findbar',
      {
        type: 'content-top-right',
        width: WIDTH + MARGIN * 2,
        height: HEIGHT + MARGIN * 2,
        right: 16 - MARGIN,
        top: -8
      },
      refocus
    )
    if (refocus) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [find, container])

  if (!find || !container) return null

  const query = (value: string): void => {
    setText(value)
    window.aqua.find.query(find.tabId, value)
  }
  const step = (forward: boolean): void => window.aqua.find.step(find.tabId, forward)
  const close = (): void => window.aqua.find.close(find.tabId)
  const noMatch = text.length > 0 && find.text === text && find.matches === 0

  return createPortal(
    <div className="popup-frame" style={{ padding: MARGIN }}>
      <div className={cx('findbar', noMatch && 'no-match')} style={{ width: WIDTH }} role="search">
        <input
          ref={inputRef}
          className="findbar-input"
          value={text}
          placeholder="Find in page"
          aria-label="Find in page"
          spellCheck={false}
          onChange={(e) => query(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              step(!e.shiftKey)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
        />
        <span className="findbar-count" aria-live="polite">
          {text ? `${find.matches ? find.activeMatch : 0}/${find.matches}` : ''}
        </span>
        <button
          className="mini-button"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          disabled={!find.matches}
          onClick={() => step(false)}
        >
          <Icon icon={ChevronUp} />
        </button>
        <button
          className="mini-button"
          title="Next match (Enter)"
          aria-label="Next match"
          disabled={!find.matches}
          onClick={() => step(true)}
        >
          <Icon icon={ChevronDown} />
        </button>
        <button className="mini-button" title="Close (Esc)" aria-label="Close find bar" onClick={close}>
          <Icon icon={X} />
        </button>
      </div>
    </div>,
    container
  )
}
