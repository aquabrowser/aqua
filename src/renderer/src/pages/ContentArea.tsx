import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TabState } from '@shared/types'
import { internalPageOf, internalSubpage } from '@shared/url'
import { CrashPage } from './CrashPage'
import { DownloadsPage } from './DownloadsPage'
import { ErrorPage } from './ErrorPage'
import { HistoryPage } from './HistoryPage'
import { NewTabPage } from './NewTabPage'
import { NotFoundPage } from './NotFoundPage'
import { SettingsPage } from './SettingsPage'

/**
 * Pages fade in when a tab navigates to them, but appear at once when the
 * user switches (or closes their way) to a tab already showing them: a fade
 * there reads as a flash of empty page. Decided once, when the page mounts.
 */
function Entry({ instant, children }: { instant: boolean; children: ReactNode }) {
  const [still] = useState(instant)
  return <div className={still ? 'page-entry instant' : 'page-entry'}>{children}</div>
}

function pageFor(tab: TabState): { key: string; node: ReactNode } | null {
  if (tab.crashed) return { key: `${tab.id}:crashed`, node: <CrashPage tab={tab} /> }
  if (tab.error) return { key: `${tab.id}:${tab.error.url}`, node: <ErrorPage tab={tab} /> }
  switch (internalPageOf(tab.url)) {
    case 'newtab':
      return { key: `${tab.id}:newtab`, node: <NewTabPage /> }
    case 'settings':
      return { key: `${tab.id}:settings`, node: <SettingsPage section={internalSubpage(tab.url)} /> }
    case 'history':
      return { key: `${tab.id}:history`, node: <HistoryPage /> }
    case 'downloads':
      return { key: `${tab.id}:downloads`, node: <DownloadsPage /> }
    case 'unknown':
      return { key: `${tab.id}:unknown`, node: <NotFoundPage url={tab.url} /> }
    default:
      return null
  }
}

/**
 * What the UI draws beneath the tab's web view. For ordinary web pages this
 * renders nothing and the native view covers the area; for internal pages,
 * load errors and crashed renderers the main process hides the view and the
 * page below becomes visible.
 */
export function ContentArea({ tab }: { tab: TabState | null }) {
  const shownTab = useRef<string | null>(null)
  const switched = !!tab && shownTab.current !== null && shownTab.current !== tab.id
  useEffect(() => {
    shownTab.current = tab?.id ?? null
  }, [tab?.id])

  const page = tab ? pageFor(tab) : null
  if (!page) return null
  return (
    <Entry key={page.key} instant={switched}>
      {page.node}
    </Entry>
  )
}
