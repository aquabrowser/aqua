import { useLayoutEffect, useRef } from 'react'
import { ContentArea } from '../pages/ContentArea'
import { useActiveTab, useSettings } from '../store'
import { BookmarksBar } from './BookmarksBar'
import { FindBar } from './FindBar'
import { ProgressBar } from './ProgressBar'
import { TabStrip } from './TabStrip'
import { Toolbar } from './Toolbar'

/**
 * Window layout: header (tab strip, toolbar, bookmarks bar) above the content
 * area. The header's bottom edge is reported to the main process on every
 * size change so native web views are positioned to the exact pixel.
 */
export function BrowserChrome({ inert }: { inert: boolean }) {
  const settings = useSettings()
  const tab = useActiveTab()
  const headerRef = useRef<HTMLElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // `inert` (not yet in React 18's typings) removes the locked UI from focus and the a11y tree.
  useLayoutEffect(() => {
    rootRef.current?.toggleAttribute('inert', inert)
  }, [inert])

  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return
    let last = -1
    const report = (): void => {
      const bottom = Math.round(header.getBoundingClientRect().bottom)
      if (bottom === last) return
      last = bottom
      window.aqua.ui.setContentTop(bottom)
      // In-page dialogs (Settings, New Tab) cover the content area only.
      document.documentElement.style.setProperty('--content-top', `${bottom}px`)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(header)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={rootRef} className="browser" aria-hidden={inert || undefined}>
      <header ref={headerRef} className="header">
        <TabStrip />
        <Toolbar tab={tab} />
        {settings.showBookmarksBar && <BookmarksBar />}
        <ProgressBar tab={tab} />
      </header>
      <main className="content">
        <ContentArea tab={tab} />
      </main>
      {!inert && <FindBar />}
    </div>
  )
}
