import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { History, Search, Trash2, X } from 'lucide-react'
import type { HistoryEntry } from '@shared/types'
import { Favicon } from '../components/Favicon'
import { Icon } from '../components/Icon'
import { dayKey, dayLabel, formatTime } from '../lib/format'

const PAGE_SIZE = 100

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function HistoryPage() {
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const request = useRef(0)
  const sentinel = useRef<HTMLDivElement>(null)

  const load = useCallback(async (text: string, before?: number) => {
    const id = ++request.current
    const page = await window.aqua.history.query({ text: text || undefined, before, limit: PAGE_SIZE })
    if (id !== request.current) return
    setEntries((current) => (before === undefined ? page : [...current, ...page]))
    setHasMore(page.length === PAGE_SIZE)
    setLoaded(true)
  }, [])

  // Debounced search.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), query ? 150 : 0)
    return () => window.clearTimeout(timer)
  }, [query, load])

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore) return
    const observer = new IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting) && entries.length) void load(query, entries[entries.length - 1].visitedAt)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, entries, query, load])

  const groups = useMemo(() => {
    const out: Array<{ key: number; label: string; items: HistoryEntry[] }> = []
    for (const e of entries) {
      const key = dayKey(e.visitedAt)
      let group = out[out.length - 1]
      if (!group || group.key !== key) {
        group = { key, label: dayLabel(e.visitedAt), items: [] }
        out.push(group)
      }
      group.items.push(e)
    }
    return out
  }, [entries])

  const remove = (id: string): void => {
    setEntries((list) => list.filter((e) => e.id !== id))
    void window.aqua.history.remove([id])
  }

  return (
    <div className="page">
      <div className="page-column">
        <div className="page-header">
          <h1>History</h1>
          <button className="btn" onClick={() => void window.aqua.nav.go('aqua://settings/privacy')}>
            <Icon icon={Trash2} size={15} />
            Clear browsing data…
          </button>
        </div>
        <div className="list-toolbar">
          <label className="search-field">
            <Icon icon={Search} />
            <input
              value={query}
              placeholder="Search history"
              spellCheck={false}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            />
            {query && (
              <button className="mini-button" aria-label="Clear search" onClick={() => setQuery('')}>
                <Icon icon={X} size={14} />
              </button>
            )}
          </label>
        </div>

        {loaded && entries.length === 0 && (
          <div className="empty-state">
            <Icon icon={History} size={32} stroke={1.3} />
            <div>{query ? 'Nothing matches that search' : 'Pages you visit show up here'}</div>
          </div>
        )}

        {groups.map((group) => (
          <section key={group.key}>
            <div className="day-heading">{group.label}</div>
            <div className="card" style={{ padding: 4 }}>
              {group.items.map((e) => (
                <div
                  key={e.id}
                  className="history-row"
                  title={e.url}
                  onClick={(ev) =>
                    ev.ctrlKey || ev.metaKey
                      ? void window.aqua.tabs.create({ url: e.url, background: true })
                      : void window.aqua.nav.go(e.url)
                  }
                  onAuxClick={(ev) => ev.button === 1 && void window.aqua.tabs.create({ url: e.url, background: true })}
                  onMouseDown={(ev) => ev.button === 1 && ev.preventDefault()}
                >
                  <span className="history-time">{formatTime(e.visitedAt)}</span>
                  <Favicon src={e.favicon} url={e.url} />
                  <span className="history-title">{e.title || e.url}</span>
                  <span className="history-host">{hostOf(e.url)}</span>
                  <button
                    className="row-action"
                    title="Remove from history"
                    aria-label="Remove from history"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      remove(e.id)
                    }}
                  >
                    <Icon icon={X} size={15} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
        <div ref={sentinel} style={{ height: 1 }} />
      </div>
    </div>
  )
}
