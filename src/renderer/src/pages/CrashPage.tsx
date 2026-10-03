import { Frown, FileQuestion } from 'lucide-react'
import type { TabState } from '@shared/types'
import { Icon } from '../components/Icon'

export function CrashPage({ tab }: { tab: TabState }) {
  return (
    <div className="page">
      <div className="error-page">
        <div className="error-body">
          <div className="error-icon">
            <Icon icon={Frown} size={28} stroke={1.6} />
          </div>
          <h1>This page crashed</h1>
          <p>“{tab.title}” stopped working. Your other tabs are fine.</p>
          <div className="error-actions">
            <button className="btn primary" autoFocus onClick={() => void window.aqua.tabs.reload(tab.id)}>
              Reload
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function NotFoundPageContent({ url }: { url: string }) {
  return (
    <div className="error-body">
      <div className="error-icon">
        <Icon icon={FileQuestion} size={28} stroke={1.6} />
      </div>
      <h1>Page not found</h1>
      <p>{url} doesn’t exist in this version of Aqua.</p>
      <div className="error-actions">
        <button className="btn primary" onClick={() => void window.aqua.nav.go('aqua://newtab')}>
          Open New Tab
        </button>
        <button className="btn ghost" onClick={() => void window.aqua.nav.go('aqua://settings')}>
          Settings
        </button>
      </div>
    </div>
  )
}
