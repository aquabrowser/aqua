import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronsRight } from 'lucide-react'
import type { Bookmark } from '@shared/types'
import { Favicon } from '../components/Favicon'
import { Icon } from '../components/Icon'
import { cx } from '../lib/format'
import { bookmarksStore, useStore } from '../store'

/**
 * Bookmarks bar. Items that do not fit are moved (not squashed) into a native
 * overflow menu, measured with a ResizeObserver so resizing never reflows
 * items into half-visible states.
 */
export function BookmarksBar() {
  const bookmarks = useStore(bookmarksStore)
  const listRef = useRef<HTMLDivElement>(null)
  const chevronRef = useRef<HTMLButtonElement>(null)
  const [visibleCount, setVisibleCount] = useState(bookmarks.length)

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = (): void => {
      const items = [...list.querySelectorAll<HTMLElement>('[data-bookmark]')]
      const available = list.clientWidth
      let used = 0
      let count = 0
      for (const el of items) {
        const width = el.offsetWidth + 2
        if (used + width > available) break
        used += width
        count++
      }
      setVisibleCount(count)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [bookmarks])

  const open = (bookmark: Bookmark, disposition: 'current' | 'new-tab' | 'background-tab'): void => {
    void window.aqua.bookmarks.open(bookmark.id, disposition)
  }

  const overflow = bookmarks.slice(visibleCount)

  return (
    <div className="bookmarks-bar" role="toolbar" aria-label="Bookmarks">
      <div ref={listRef} className="bookmarks-list">
        {bookmarks.length === 0 && (
          <span className="bookmarks-empty">Bookmark pages with the star in the address bar to keep them here.</span>
        )}
        {bookmarks.map((b, i) => (
          <button
            key={b.id}
            data-bookmark
            className={cx('bookmark', i >= visibleCount && 'hidden')}
            title={`${b.title}\n${b.url}`}
            tabIndex={i >= visibleCount ? -1 : 0}
            onClick={(e) => open(b, e.ctrlKey || e.metaKey ? 'background-tab' : e.shiftKey ? 'new-tab' : 'current')}
            onAuxClick={(e) => e.button === 1 && open(b, 'background-tab')}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onContextMenu={(e) => {
              e.preventDefault()
              void window.aqua.ui.contextMenu({ kind: 'bookmark', bookmarkId: b.id })
            }}
          >
            <Favicon src={b.favicon} url={b.url} />
            {b.title && <span className="bookmark-label">{b.title}</span>}
          </button>
        ))}
      </div>
      {overflow.length > 0 && (
        <button
          ref={chevronRef}
          className="icon-button bookmarks-overflow"
          title="More bookmarks"
          aria-label={`${overflow.length} more bookmarks`}
          onClick={() => {
            const r = chevronRef.current?.getBoundingClientRect()
            if (!r) return
            void window.aqua.ui.contextMenu({
              kind: 'bookmarks-overflow',
              bookmarkIds: overflow.map((b) => b.id),
              x: r.left,
              y: r.bottom
            })
          }}
        >
          <Icon icon={ChevronsRight} />
        </button>
      )}
    </div>
  )
}
