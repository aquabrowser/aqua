import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { statusLayer } from '../lib/overlay'

/** Moving between adjacent links must not make the bubble blink. */
const HIDE_DELAY_MS = 150
/** The bubble never covers more than this share of the window's width. */
const MAX_WIDTH_RATIO = 0.45

/** Percent-escapes decoded where that is safe, so addresses read as people write them. */
function readable(url: string): string {
  try {
    return decodeURI(url)
  } catch {
    return url
  }
}

/**
 * Where the link under the pointer leads, in the bottom-left corner of the
 * page (Chrome's status bubble). It lives in its own overlay layer above the
 * page; the main process moves it to the other corner while the pointer is
 * over that spot, so it never hides what it describes.
 */
export function StatusBubble() {
  const [url, setUrl] = useState('')
  const [container] = useState(() => statusLayer.container())
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer = 0
    const unsubscribe = window.aqua.ui.onCommand((command) => {
      if (command.type !== 'status') return
      window.clearTimeout(timer)
      if (command.url) setUrl(command.url)
      else timer = window.setTimeout(() => setUrl(''), HIDE_DELAY_MS)
    })
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!url || !el) {
      window.aqua.ui.hideOverlay('status')
      return
    }
    window.aqua.ui.showOverlay(
      'status',
      { type: 'content-bottom-left', width: Math.ceil(el.offsetWidth), height: Math.ceil(el.offsetHeight) },
      false
    )
  }, [url])

  useEffect(() => () => window.aqua.ui.hideOverlay('status'), [])

  if (!url || !container) return null
  return createPortal(
    <div ref={ref} className="status-bubble" style={{ maxWidth: Math.round(window.innerWidth * MAX_WIDTH_RATIO) }}>
      {readable(url)}
    </div>,
    container
  )
}
