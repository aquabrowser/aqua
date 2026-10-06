import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { Plus, UserRound, VenetianMask } from 'lucide-react'
import { PROFILE_COLOR_VALUES } from '@shared/profiles'
import type { TabState } from '@shared/types'
import { droppedUrl } from '@shared/url'
import { Icon } from '../components/Icon'
import { cx } from '../lib/format'
import { env, useStore, windowStore } from '../store'
import { TabItem } from './TabItem'

/** Slightly longer than the close transition, which then has always finished. */
const EXIT_MS = 260
/** How long tabs animate to their new widths when the strip lets go of frozen widths. */
const SETTLE_MS = 220
const DRAG_THRESHOLD = 5

interface Rendered {
  tab: TabState
  closing: boolean
  /** A closing tab's width when it was closed: it keeps it while the tabs after it slide over it. */
  width?: number
}

interface DragSession {
  id: string
  pointerId: number
  pinned: boolean
  startX: number
  el: HTMLElement
  els: HTMLElement[]
  lefts: number[]
  widths: number[]
  from: number
  to: number
  started: boolean
}

/**
 * Keeps closed tabs rendered (as `closing`) for the exit transition, at the
 * position they occupied, so neighbours slide into place instead of jumping.
 * `allIds` covers every tab in the window, so a tab that merely moved to the
 * pinned group is not mistaken for a closed one.
 */
function usePresence(tabs: TabState[], allIds: Set<string>): Rendered[] {
  const exiting = useRef(new Map<string, { tab: TabState; after: string | null; width: number; timer: number }>())
  const previous = useRef<TabState[]>(tabs)
  const [, rerender] = useState(0)

  const ids = new Set(tabs.map((t) => t.id))
  const prev = previous.current
  prev.forEach((tab, index) => {
    if (allIds.has(tab.id) || exiting.current.has(tab.id)) return
    const after = index > 0 ? prev[index - 1].id : null
    // The element still has its last committed layout: that is the width it keeps while it goes.
    const el = document.querySelector<HTMLElement>(`.tab-list .tab[data-id="${CSS.escape(tab.id)}"]`)
    const width = el?.getBoundingClientRect().width ?? 0
    const timer = window.setTimeout(() => {
      exiting.current.delete(tab.id)
      rerender((n) => n + 1)
    }, EXIT_MS)
    exiting.current.set(tab.id, { tab, after, width, timer })
  })
  // A tab that comes back (e.g. close cancelled by beforeunload) stops exiting.
  for (const [id, entry] of exiting.current) {
    if (ids.has(id)) {
      window.clearTimeout(entry.timer)
      exiting.current.delete(id)
    }
  }
  previous.current = tabs

  useEffect(() => {
    const map = exiting.current
    return () => map.forEach((e) => window.clearTimeout(e.timer))
  }, [])

  const out: Rendered[] = tabs.map((tab) => ({ tab, closing: false }))
  // A ghost goes right after the tab that was on its left. That tab may be closing too (closed
  // a moment later), so each ghost waits until its anchor is placed; otherwise it would be
  // pushed to the end of the strip, past the last tab.
  const pending = [...exiting.current.values()]
  while (pending.length > 0) {
    const ready = pending.findIndex(({ after }) => after === null || out.some((r) => r.tab.id === after))
    const [{ tab, after, width }] = pending.splice(Math.max(0, ready), 1)
    const at = after === null ? 0 : out.findIndex((r) => r.tab.id === after) + 1
    // Anchor no longer in this group (e.g. pinned meanwhile): the end is the best guess left.
    out.splice(at <= 0 && after !== null ? out.length : at, 0, { tab, closing: true, width })
  }
  return out
}

export function TabStrip() {
  const isPrivate = useStore(windowStore, (w) => w.private)
  const tabs = useStore(windowStore, (s) => s.tabs)
  const activeId = useStore(windowStore, (s) => s.activeTabId)

  // Optimistic order applied at drop time until the main process confirms it.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null)
  const orderedTabs = useMemo(() => {
    if (!localOrder) return tabs
    const byId = new Map(tabs.map((t) => [t.id, t]))
    const ordered = localOrder.map((id) => byId.get(id)).filter((t): t is TabState => !!t)
    return ordered.length === tabs.length ? ordered : tabs
  }, [tabs, localOrder])

  useEffect(() => {
    if (!localOrder) return
    const confirmed = tabs.map((t) => t.id).join() === localOrder.join()
    if (confirmed) setLocalOrder(null)
    const timer = window.setTimeout(() => setLocalOrder(null), 600)
    return () => window.clearTimeout(timer)
  }, [tabs, localOrder])

  const pinned = orderedTabs.filter((t) => t.pinned)
  const allIds = useMemo(() => new Set(tabs.map((t) => t.id)), [tabs])
  const normal = usePresence(
    orderedTabs.filter((t) => !t.pinned),
    allIds
  )

  // Only tabs created after mount animate in.
  const known = useRef<Set<string> | null>(null)
  const entering = useRef(new Set<string>())
  if (known.current === null) known.current = new Set(tabs.map((t) => t.id))
  for (const t of tabs) {
    if (!known.current.has(t.id)) {
      known.current.add(t.id)
      entering.current.add(t.id)
    }
  }
  const onEntered = useCallback((id: string) => {
    entering.current.delete(id)
  }, [])

  // ─── Width freeze after closing with the mouse ─────────────────────────────
  const stripRef = useRef<HTMLDivElement>(null)
  const [frozenWidth, setFrozenWidth] = useState<number | null>(null)
  const frozen = useRef(false)
  frozen.current = frozenWidth !== null
  // Letting go of frozen widths animates the tabs to their natural widths instead of snapping.
  const [settling, setSettling] = useState(false)
  const settleTimer = useRef(0)
  const unfreeze = useCallback(() => {
    if (!frozen.current) return
    setFrozenWidth(null)
    setSettling(true)
    window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => setSettling(false), SETTLE_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(settleTimer.current), [])
  useEffect(() => {
    window.addEventListener('resize', unfreeze)
    return () => window.removeEventListener('resize', unfreeze)
  }, [unfreeze])

  const closeTab = useCallback((tab: TabState, event: { clientX: number; target: EventTarget }) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>('.tab')
    // Keyboard-activated clicks report clientX 0: no freeze needed then.
    if (el && !tab.pinned && event.clientX > 0) setFrozenWidth(el.getBoundingClientRect().width)
    void window.aqua.tabs.close(tab.id)
  }, [])

  const toggleMute = useCallback((tab: TabState) => void window.aqua.tabs.setMuted(tab.id, !tab.muted), [])
  const contextMenu = useCallback(
    (tab: TabState) => void window.aqua.ui.contextMenu({ kind: 'tab', tabId: tab.id }),
    []
  )

  // ─── Overflow scrolling ────────────────────────────────────────────────────
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState({ left: false, right: false })
  const updateFade = useCallback(() => {
    const s = scrollerRef.current
    if (!s) return
    const left = s.scrollLeft > 1
    // Only tabs that stay count: a closing tab is invisible and overhangs the end while it goes.
    const open = s.querySelectorAll<HTMLElement>('.tab:not(.closing)')
    const last = open[open.length - 1]
    const edge = s.getBoundingClientRect().right - parseFloat(getComputedStyle(s).paddingRight)
    const right = last !== undefined && last.getBoundingClientRect().right > edge + 1
    setFade((f) => (f.left === left && f.right === right ? f : { left, right }))
  }, [])

  useLayoutEffect(() => {
    const s = scrollerRef.current
    if (!s) return
    const observer = new ResizeObserver(updateFade)
    observer.observe(s)
    if (s.firstElementChild) observer.observe(s.firstElementChild)
    return () => observer.disconnect()
  }, [updateFade])

  // A tab starting or finishing its close can leave every size as it was (its negative margin
  // cancels its width), so the observer above doesn't fire: check again whenever the set changes.
  const presence = normal.map((r) => (r.closing ? `-${r.tab.id}` : r.tab.id)).join()
  useLayoutEffect(updateFade, [presence, updateFade])

  useEffect(() => {
    const el = scrollerRef.current?.querySelector<HTMLElement>(`.tab[data-id="${activeId}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [activeId, normal.length])

  // ─── Drag to reorder ───────────────────────────────────────────────────────
  const drag = useRef<DragSession | null>(null)
  const [dragging, setDragging] = useState(false)
  const pendingFlip = useRef<Map<string, number> | null>(null)

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, tab: TabState) => {
      if (event.button !== 0) return
      if (tab.id !== activeId) void window.aqua.tabs.activate(tab.id, false)
      const el = event.currentTarget
      const group = el.parentElement
      if (!group) return
      const els = [...group.children].filter(
        (c): c is HTMLElement =>
          c instanceof HTMLElement && c.classList.contains('tab') && !c.classList.contains('closing')
      )
      const rects = els.map((e) => e.getBoundingClientRect())
      drag.current = {
        id: tab.id,
        pointerId: event.pointerId,
        pinned: tab.pinned,
        startX: event.clientX,
        el,
        els,
        lefts: rects.map((r) => r.left),
        widths: rects.map((r) => r.width),
        from: els.indexOf(el),
        to: els.indexOf(el),
        started: false
      }
      el.setPointerCapture(event.pointerId)
    },
    [activeId]
  )

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const s = drag.current
      if (!s || event.pointerId !== s.pointerId) return
      const dx = event.clientX - s.startX
      if (!s.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return
        s.started = true
        s.el.classList.add('drag-source')
        setDragging(true)
        setFrozenWidth(null)
      }
      const n = s.els.length
      const ownLeft = s.lefts[s.from]
      const ownWidth = s.widths[s.from]
      const min = s.lefts[0] - ownLeft
      const max = s.lefts[n - 1] + s.widths[n - 1] - (ownLeft + ownWidth)
      const offset = Math.max(min, Math.min(max, dx))
      s.el.style.transform = `translateX(${offset}px)`

      const center = ownLeft + ownWidth / 2 + offset
      let to = 0
      for (let i = 0; i < n; i++) {
        if (i !== s.from && s.lefts[i] + s.widths[i] / 2 < center) to++
      }
      if (to !== s.to) {
        s.to = to
        for (let i = 0; i < n; i++) {
          if (i === s.from) continue
          let shift = 0
          if (s.from < to && i > s.from && i <= to) shift = -ownWidth
          else if (s.from > to && i >= to && i < s.from) shift = ownWidth
          s.els[i].style.transform = shift ? `translateX(${shift}px)` : ''
        }
      }
    }

    const onUp = (event: PointerEvent): void => {
      const s = drag.current
      if (!s || event.pointerId !== s.pointerId) return
      drag.current = null
      if (s.el.hasPointerCapture(event.pointerId)) s.el.releasePointerCapture(event.pointerId)
      if (!s.started) {
        // A plain click: hand focus to the page (or the omnibox on New Tab).
        void window.aqua.tabs.activate(s.id, true)
        return
      }
      const flip = new Map<string, number>()
      for (const el of s.els) flip.set(el.dataset.id!, el.getBoundingClientRect().left)
      pendingFlip.current = flip
      setDragging(false)

      const all = windowStore.get().tabs.map((t) => t.id)
      const group = s.els.map((el) => el.dataset.id!)
      const [moved] = group.splice(s.from, 1)
      group.splice(s.to, 0, moved)
      const pinnedIds = all.filter((id) => windowStore.get().tabs.find((t) => t.id === id)?.pinned)
      const normalIds = all.filter((id) => !pinnedIds.includes(id))
      const order = s.pinned ? [...group, ...normalIds] : [...pinnedIds, ...group]
      const globalIndex = s.pinned ? s.to : pinnedIds.length + s.to

      if (s.to === s.from) {
        // Dropped in place: just settle the tab back.
        setLocalOrder(null)
        settle(flip, s.els)
        pendingFlip.current = null
      } else {
        setLocalOrder(order)
      }
      void window.aqua.tabs.move(s.id, globalIndex).then(() => window.aqua.tabs.activate(s.id, true))
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  // FLIP: after the optimistic reorder renders, animate tabs from where they were dropped.
  useLayoutEffect(() => {
    const flip = pendingFlip.current
    if (!flip || !localOrder) return
    pendingFlip.current = null
    const els = [...(stripRef.current?.querySelectorAll<HTMLElement>('.tab') ?? [])]
    settle(flip, els)
  }, [localOrder])

  // ─── Links and images dropped on the strip ─────────────────────────────────
  // Each opens in a new tab where it is dropped, with a marker showing the spot.
  const [dropX, setDropX] = useState<number | null>(null)
  const dropIndex = useRef(0)

  const carriesLink = (event: ReactDragEvent): boolean => draggingLink(event.dataTransfer)

  // The strip's empty space doubles as the window's title bar, and the system swallows drops
  // there. While a link is dragged over the browser UI, the whole strip becomes a drop zone.
  useEffect(() => {
    const root = document.documentElement
    let timer = 0
    const end = (): void => {
      window.clearTimeout(timer)
      root.classList.remove('link-drag')
      setDropX(null)
    }
    const during = (event: DragEvent): void => {
      if (!event.dataTransfer || !draggingLink(event.dataTransfer)) return
      root.classList.add('link-drag')
      // Drag events stop when the pointer moves over a page (another view): end the mode then.
      window.clearTimeout(timer)
      timer = window.setTimeout(end, 400)
    }
    window.addEventListener('dragenter', during)
    window.addEventListener('dragover', during)
    window.addEventListener('drop', end)
    window.addEventListener('dragend', end)
    return () => {
      end()
      window.removeEventListener('dragenter', during)
      window.removeEventListener('dragover', during)
      window.removeEventListener('drop', end)
      window.removeEventListener('dragend', end)
    }
  }, [])

  const locateDrop = (clientX: number): { index: number; x: number } => {
    const strip = stripRef.current
    if (!strip) return { index: tabs.length, x: 0 }
    const origin = strip.getBoundingClientRect().left
    const open = normal.filter((r) => !r.closing).map((r) => r.tab.id)
    const els = open
      .map((id) => strip.querySelector<HTMLElement>(`.tab-list .tab[data-id="${id}"]`))
      .filter((el): el is HTMLElement => el !== null)
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect()
      if (clientX < r.left + r.width / 2) return { index: pinned.length + i, x: r.left - origin }
    }
    const last = els[els.length - 1]?.getBoundingClientRect()
    return { index: pinned.length + els.length, x: (last ? last.right : origin) - origin }
  }

  const onDragOver = (event: ReactDragEvent): void => {
    if (!carriesLink(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    const { index, x } = locateDrop(event.clientX)
    dropIndex.current = index
    setDropX(x)
  }

  const onDragLeave = (event: ReactDragEvent): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropX(null)
  }

  const onDrop = (event: ReactDragEvent): void => {
    setDropX(null)
    const url = droppedUrl(event.dataTransfer.getData('text/uri-list'), event.dataTransfer.getData('text/plain'))
    if (!url) return
    event.preventDefault()
    void window.aqua.tabs.create({ url, index: dropIndex.current })
  }

  const renderTab = (item: Rendered): JSX.Element => (
    <TabItem
      key={item.tab.id}
      tab={item.tab}
      active={item.tab.id === activeId}
      entering={entering.current.has(item.tab.id)}
      closing={item.closing}
      closingWidth={item.width}
      onPointerDown={onPointerDown}
      onClose={closeTab}
      onToggleMute={toggleMute}
      onContextMenu={contextMenu}
      onEntered={onEntered}
    />
  )

  return (
    <div
      ref={stripRef}
      className={cx('tabstrip', frozenWidth !== null && 'frozen', settling && 'settling', dragging && 'dragging')}
      style={frozenWidth !== null ? ({ '--frozen-w': `${frozenWidth}px` } as CSSProperties) : undefined}
      onPointerLeave={unfreeze}
      onContextMenu={(e) => {
        // Tabs open their own menu, and the empty space is a window drag area whose right-click
        // the main process answers (system-context-menu). The new tab button opens the same menu.
        if (!(e.target as HTMLElement).closest('.newtab-button')) return
        e.preventDefault()
        void window.aqua.ui.contextMenu({ kind: 'tabstrip' })
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {pinned.length > 0 && (
        <div className="tab-group pinned" role="tablist" aria-label="Pinned tabs">
          {pinned.map((tab) => renderTab({ tab, closing: false }))}
        </div>
      )}
      <div
        ref={scrollerRef}
        className={cx('tab-scroller', fade.left && 'fade-left', fade.right && 'fade-right')}
        onScroll={updateFade}
        onWheel={(e) => {
          const s = scrollerRef.current
          if (s && Math.abs(e.deltaY) > Math.abs(e.deltaX)) s.scrollLeft += e.deltaY
        }}
      >
        <div className="tab-list" role="tablist" aria-label="Tabs">
          {normal.map(renderTab)}
        </div>
      </div>
      <button
        className="newtab-button"
        title="New tab (Ctrl+T)"
        aria-label="New tab"
        onClick={() => void window.aqua.ui.command('tab.new')}
      >
        <span className="newtab-circle">
          <Icon icon={Plus} size={16} stroke={1.75} />
        </span>
      </button>
      <div className="tabstrip-spacer" />
      {dropX !== null && <div className="tab-drop-marker" style={{ left: dropX }} aria-hidden />}
      {isPrivate ? (
        <div className="private-badge" title="Private window: history, cookies and site data aren’t kept">
          <Icon icon={VenetianMask} size={15} stroke={1.6} />
          Private
        </div>
      ) : (
        <ProfileBadge />
      )}
    </div>
  )
}

/**
 * Which profile the window belongs to, once there is more than one (always in a guest session).
 * A button: it opens the profile switcher.
 */
function ProfileBadge() {
  const profile = env.profile
  const guest = profile.kind === 'guest'
  if (!guest && profile.profileCount < 2) return null
  return (
    <button
      className={cx('private-badge', 'profile-badge')}
      title={guest ? 'Guest window: nothing is kept after the last guest window closes' : `Profile: ${profile.name}`}
      onClick={() => void window.aqua.ui.contextMenu({ kind: 'profiles' })}
    >
      {guest ? (
        <Icon icon={UserRound} size={15} stroke={1.6} />
      ) : (
        <span className="profile-dot" style={{ background: PROFILE_COLOR_VALUES[profile.color] }} aria-hidden />
      )}
      {profile.name}
    </button>
  )
}

function draggingLink(data: DataTransfer): boolean {
  return data.types.includes('text/uri-list') || data.types.includes('text/plain')
}

/** Animates each element from its recorded left edge to its current layout position. */
function settle(before: Map<string, number>, els: HTMLElement[]): void {
  for (const el of els) {
    el.classList.remove('drag-source')
    el.style.transition = 'none'
    el.style.transform = ''
  }
  for (const el of els) {
    const from = before.get(el.dataset.id ?? '')
    if (from === undefined) continue
    const delta = from - el.getBoundingClientRect().left
    if (Math.abs(delta) < 0.5) continue
    el.style.transform = `translateX(${delta}px)`
  }
  void document.body.offsetWidth
  for (const el of els) {
    if (!el.style.transform) {
      el.style.transition = ''
      continue
    }
    el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)'
    el.style.transform = ''
    el.addEventListener(
      'transitionend',
      () => {
        el.style.transition = ''
      },
      { once: true }
    )
  }
}
