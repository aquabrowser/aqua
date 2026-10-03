import { useEffect, useRef, useState, type RefObject } from 'react'
import type { TabState } from '@shared/types'
import { Popup } from '../components/Popup'
import { bookmarksStore, useStore } from '../store'

export function BookmarkBubble({
  anchorRef,
  tab,
  onClose
}: {
  anchorRef: RefObject<HTMLElement | null>
  tab: TabState
  onClose: () => void
}) {
  const bookmark = useStore(bookmarksStore, (list) => list.find((b) => b.url === tab.url) ?? null)
  const [name, setName] = useState(bookmark?.title ?? tab.title)
  const [isNew] = useState(() => !!bookmark && Date.now() - bookmark.createdAt < 2000)
  const removed = useRef(false)

  useEffect(() => {
    if (bookmark) setName((current) => current || bookmark.title)
  }, [bookmark])

  // Save on any kind of close (Done, Enter, Escape, clicking elsewhere) - like Chrome.
  const nameRef = useRef(name)
  nameRef.current = name
  const idRef = useRef(bookmark?.id)
  idRef.current = bookmark?.id
  const originalTitle = useRef(bookmark?.title)
  useEffect(
    () => () => {
      const id = idRef.current
      const title = nameRef.current.trim()
      if (id && !removed.current && title && title !== originalTitle.current)
        void window.aqua.bookmarks.update(id, { title })
    },
    []
  )

  if (!bookmark) return null

  return (
    <Popup anchorRef={anchorRef} align="end" width={320} onDismiss={onClose} label="Bookmark">
      <div className="popup-header">
        <div className="popup-title">{isNew ? 'Bookmark added' : 'Edit bookmark'}</div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onClose()
        }}
      >
        <div className="field">
          <label htmlFor="bookmark-name">Name</label>
          <input
            id="bookmark-name"
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            data-autofocus
          />
        </div>
        <div className="popup-footer">
          <button
            type="button"
            className="btn"
            onClick={() => {
              removed.current = true
              void window.aqua.bookmarks.remove(bookmark.id)
              onClose()
            }}
          >
            Remove
          </button>
          <button type="submit" className="btn primary">
            Done
          </button>
        </div>
      </form>
    </Popup>
  )
}
