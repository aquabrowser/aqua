import { useMemo, useState } from 'react'
import { Download, FolderOpen, Search, X } from 'lucide-react'
import type { DownloadEntry } from '@shared/types'
import { DownloadActions, DownloadProgress, downloadStatusText, FileKindIcon } from '../chrome/DownloadsFlyout'
import { Icon } from '../components/Icon'
import { cx, dayKey, dayLabel } from '../lib/format'
import { downloadsStore, useStore } from '../store'

export function DownloadsPage() {
  const downloads = useStore(downloadsStore)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? downloads.filter((d) => d.filename.toLowerCase().includes(q) || d.url.toLowerCase().includes(q))
      : downloads
    const out: Array<{ key: number; label: string; items: DownloadEntry[] }> = []
    for (const d of list) {
      const key = dayKey(d.startedAt)
      let group = out[out.length - 1]
      if (!group || group.key !== key) {
        group = { key, label: dayLabel(d.startedAt), items: [] }
        out.push(group)
      }
      group.items.push(d)
    }
    return out
  }, [downloads, query])

  const hasFinished = downloads.some((d) => d.status !== 'progressing' && d.status !== 'paused')

  return (
    <div className="page">
      <div className="page-column">
        <div className="page-header">
          <h1>Downloads</h1>
          <button className="btn" disabled={!hasFinished} onClick={() => void window.aqua.downloads.clear()}>
            Clear all
          </button>
        </div>
        <div className="list-toolbar">
          <label className="search-field">
            <Icon icon={Search} />
            <input
              value={query}
              placeholder="Search downloads"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="mini-button" aria-label="Clear search" onClick={() => setQuery('')}>
                <Icon icon={X} size={14} />
              </button>
            )}
          </label>
        </div>

        {groups.length === 0 && (
          <div className="empty-state">
            <Icon icon={Download} size={32} stroke={1.3} />
            <div>{query ? 'Nothing matches that search' : 'Files you download show up here'}</div>
          </div>
        )}

        {groups.map((group) => (
          <section key={group.key}>
            <div className="day-heading">{group.label}</div>
            <div className="card">
              {group.items.map((d) => {
                const openable = d.status === 'completed' && !d.fileMissing
                return (
                  <div key={d.id} className="download-card">
                    <FileKindIcon name={d.filename} size={20} />
                    <div className="download-main">
                      {openable ? (
                        <a
                          className="download-name"
                          href="#"
                          onClick={(e) => {
                            e.preventDefault()
                            void window.aqua.downloads.action(d.id, 'open')
                          }}
                        >
                          {d.filename}
                        </a>
                      ) : (
                        <div className={cx('download-name', (d.status === 'cancelled' || d.fileMissing) && 'struck')}>
                          {d.filename}
                        </div>
                      )}
                      <div className="download-url" title={d.url}>
                        {d.url}
                      </div>
                      <div className={cx('download-meta', d.status === 'interrupted' && 'error')}>
                        {downloadStatusText(d)}
                      </div>
                      <DownloadProgress d={d} />
                      {openable && (
                        <div className="download-buttons">
                          <button className="btn small" onClick={() => void window.aqua.downloads.action(d.id, 'show')}>
                            <Icon icon={FolderOpen} size={14} />
                            Show in folder
                          </button>
                        </div>
                      )}
                    </div>
                    <DownloadActions d={d} />
                    <button
                      className="row-action"
                      title="Remove from list"
                      aria-label="Remove from list"
                      onClick={() => void window.aqua.downloads.action(d.id, 'remove')}
                    >
                      <Icon icon={X} size={15} />
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
