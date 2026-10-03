import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import {
  Ban,
  Clock,
  File as FileIcon,
  Globe,
  Info,
  Lock,
  Search,
  Star,
  TriangleAlert,
  ZoomIn,
  ZoomOut,
  type LucideIcon
} from 'lucide-react'
import { SEARCH_ENGINES } from '@shared/search'
import type { Disposition, Suggestion, SuggestResult, TabState } from '@shared/types'
import { internalPageOf, toDisplayUrl } from '@shared/url'
import { Favicon } from '../components/Favicon'
import { AquaMark, Icon } from '../components/Icon'
import { Popup, usePopup } from '../components/Popup'
import { cx } from '../lib/format'
import { bookmarksStore, useSettings, useStore } from '../store'
import { BookmarkBubble } from './BookmarkBubble'
import { SiteInfoPopup } from './SiteInfoPopup'

interface Awaiting {
  tabId: string
  fromUrl: string
  text: string
  sawLoading: boolean
}

export function Omnibox({ tab }: { tab: TabState | null }) {
  const settings = useSettings()
  const bookmarked = useStore(bookmarksStore, (list) => (tab ? list.some((b) => b.url === tab.url) : false))
  const suggestionsPopup = usePopup('suggestions')
  const siteInfo = usePopup('site-info')
  // Opening the bubble bookmarks the page first (Chrome's star behaviour).
  const bookmarkBubble = usePopup('bookmark', () => void openBookmarkBubble())

  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const starRef = useRef<HTMLButtonElement>(null)

  const tabId = tab?.id ?? null
  const page = tab ? internalPageOf(tab.url) : null
  const urlText = !tab || page === 'newtab' ? '' : tab.url

  const [focused, setFocused] = useState(false)
  const [value, setValue] = useState(urlText)
  const [edited, setEdited] = useState(false)
  const [result, setResult] = useState<SuggestResult | null>(null)
  /** The text `result` was computed for: rows highlight that, not the keystroke still being answered. */
  const [resultQuery, setResultQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [awaiting, setAwaiting] = useState<Awaiting | null>(null)
  const [starPop, setStarPop] = useState(false)

  // Mirrors for callbacks that must not go stale.
  const valueRef = useRef(value)
  const editedRef = useRef(edited)
  const focusedRef = useRef(false)
  valueRef.current = value
  editedRef.current = edited

  const typed = useRef('')
  /** Full text of the inline completion on show (typed text + selected rest), or null. */
  const completion = useRef<string | null>(null)
  const drafts = useRef(new Map<string, string>())
  const seq = useRef(0)
  const pendingSelection = useRef<[number, number] | null>(null)
  /**
   * Bumped with every selection request, so it is applied even when the value
   * does not change (typing into a completion that still fits leaves the text
   * as it was, and React then skips the render that would restore the selection).
   */
  const [selectionRequest, setSelectionRequest] = useState(0)
  const selectRange = (start: number, end: number): void => {
    pendingSelection.current = [start, end]
    setSelectionRequest((n) => n + 1)
  }
  const composing = useRef(false)
  const selectAllOnMouseUp = useRef(false)
  const blurTimer = useRef(0)

  const closeSuggestions = useCallback(() => {
    seq.current++
    setResult(null)
    suggestionsPopup.close()
  }, [suggestionsPopup])

  // ─── Tab switches & navigations ────────────────────────────────────────────
  const shownTab = useRef(tabId)
  useLayoutEffect(() => {
    if (shownTab.current !== tabId) {
      const previous = shownTab.current
      if (previous && editedRef.current) drafts.current.set(previous, valueRef.current)
      shownTab.current = tabId
      closeSuggestions()
      setAwaiting(null)
      const draft = tabId ? drafts.current.get(tabId) : undefined
      setValue(draft ?? urlText)
      setEdited(draft !== undefined)
      typed.current = draft ?? ''
      return
    }
    if (!editedRef.current) setValue(urlText)
  }, [tabId, urlText, closeSuggestions])

  // Forget drafts of closed tabs.
  useEffect(() => {
    if (!tabId) return
    for (const id of drafts.current.keys())
      if (id !== tabId && !document.querySelector(`.tab[data-id="${id}"]`)) drafts.current.delete(id)
  }, [tabId])

  // Keep showing the submitted text until the navigation commits or stops.
  useEffect(() => {
    if (!awaiting || !tab || tab.id !== awaiting.tabId) return
    if (tab.url !== awaiting.fromUrl || tab.error) return setAwaiting(null)
    if (tab.loading && !awaiting.sawLoading) return setAwaiting({ ...awaiting, sawLoading: true })
    if (!tab.loading && awaiting.sawLoading) setAwaiting(null)
  }, [awaiting, tab])

  useLayoutEffect(() => {
    const range = pendingSelection.current
    const input = inputRef.current
    if (!range || !input) return
    pendingSelection.current = null
    input.setSelectionRange(range[0], range[1])
  }, [value, selectionRequest])

  // ─── Focus handling ────────────────────────────────────────────────────────
  const focusInput = useCallback(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  /**
   * Drops the selection and scrolls back to the start. When the field is not
   * focused it shows the formatted URL over its own (transparent) raw text,
   * so a leftover selection would be painted at the raw text's width.
   */
  const clearSelection = useCallback(() => {
    const input = inputRef.current
    if (!input) return
    input.setSelectionRange(0, 0)
    input.scrollLeft = 0
  }, [])

  useEffect(
    () =>
      window.aqua.ui.onCommand((command) => {
        if (command.type === 'omnibox.focus') focusInput()
        if (command.type === 'popup.open' && command.popup === 'bookmark') void openBookmarkBubble()
        // A click into the page: the element keeps DOM focus otherwise, and with it a greyed selection.
        if (command.type === 'page.focused' && document.activeElement === inputRef.current) {
          clearSelection()
          inputRef.current?.blur()
        }
      }),
    // Re-subscribed per tab so the bookmark shortcut always targets the current page.
    [focusInput, clearSelection, tabId, tab?.url]
  )

  const onFocus = (): void => {
    window.clearTimeout(blurTimer.current)
    focusedRef.current = true
    setFocused(true)
    if (!editedRef.current) {
      setValue(urlText)
      typed.current = urlText
    }
    if (!selectAllOnMouseUp.current) requestAnimationFrame(() => focusedRef.current && inputRef.current?.select())
  }

  const onBlur = (): void => {
    focusedRef.current = false
    setFocused(false)
    selectAllOnMouseUp.current = false
    clearSelection()
    // Deferred so a click on a suggestion (which moves focus to the popup layer) still lands.
    blurTimer.current = window.setTimeout(closeSuggestions, 150)
    if (!editedRef.current) setValue(urlText)
  }

  // ─── Suggestions ───────────────────────────────────────────────────────────
  const requestSuggestions = (text: string, allowInline: boolean): void => {
    const id = ++seq.current
    if (!text.trim()) {
      setResult(null)
      suggestionsPopup.close()
      return
    }
    void window.aqua.omnibox.suggest(text).then((res) => {
      if (id !== seq.current || !focusedRef.current) return
      setResult(res)
      setResultQuery(text)
      setSelected(0)
      if (res.suggestions.length > 0) suggestionsPopup.show()
      else suggestionsPopup.close()
      // The field holds what was typed, maybe followed by a selected completion carried over from
      // the previous keystroke; anything else means the user has moved the caret or edited since.
      const input = inputRef.current
      const current = input?.value ?? ''
      const untouched =
        !!input &&
        current.toLowerCase().startsWith(text.toLowerCase()) &&
        input.selectionStart === text.length &&
        input.selectionEnd === current.length
      if (!untouched || composing.current) return
      if (allowInline && res.inlineCompletion) {
        const full = text + res.inlineCompletion
        completion.current = full
        if (full !== current) {
          selectRange(text.length, full.length)
          setValue(full)
        }
      } else if (current.length > text.length) {
        // The carried-over completion no longer applies.
        completion.current = null
        selectRange(text.length, text.length)
        setValue(text)
      }
    })
  }

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const text = event.target.value
    const inputType = (event.nativeEvent as InputEvent).inputType ?? ''
    typed.current = text
    // Typing into a completion that still fits keeps it on show, so it doesn't vanish and
    // reappear on every keystroke while the next suggestions load.
    const previous = completion.current
    if (
      inputType === 'insertText' &&
      !composing.current &&
      previous &&
      previous.length > text.length &&
      previous.toLowerCase().startsWith(text.toLowerCase())
    ) {
      selectRange(text.length, previous.length)
      setValue(text + previous.slice(text.length))
    } else {
      completion.current = null
      setValue(text)
    }
    setEdited(true)
    setAwaiting(null)
    if (tabId) drafts.current.set(tabId, text)
    if (!composing.current) requestSuggestions(text, inputType === 'insertText')
  }

  const revert = (): void => {
    completion.current = null
    closeSuggestions()
    setEdited(false)
    if (tabId) drafts.current.delete(tabId)
    setValue(urlText)
    typed.current = urlText
    selectRange(0, urlText.length)
  }

  const submit = (target: string, disposition: Disposition, ctrlEnter = false, display?: string): void => {
    if (!target.trim()) return
    closeSuggestions()
    setEdited(false)
    if (tabId) {
      drafts.current.delete(tabId)
      if (disposition === 'current')
        setAwaiting({ tabId, fromUrl: tab?.url ?? '', text: display ?? target, sawLoading: false })
    }
    inputRef.current?.blur()
    void window.aqua.nav.go(target, { disposition, ctrlEnter })
  }

  const pick = (index: number, disposition: Disposition): void => {
    window.clearTimeout(blurTimer.current)
    const row = result?.suggestions[index]
    if (row) submit(row.url, disposition, false, row.kind === 'search' ? row.title : row.url)
  }

  const moveSelection = (delta: number): void => {
    if (!result || result.suggestions.length === 0) return
    if (!suggestionsPopup.open) {
      suggestionsPopup.show()
      return
    }
    // Wraps around: up from the first row goes to the last, and down from the last to the first.
    const count = result.suggestions.length
    const next = (((selected + delta) % count) + count) % count
    completion.current = null
    setSelected(next)
    const row = result.suggestions[next]
    const text =
      next === 0 && result.inlineCompletion
        ? typed.current + result.inlineCompletion
        : next === 0
          ? typed.current
          : row.fill
    selectRange(text.length, text.length)
    setValue(text)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'Enter': {
        event.preventDefault()
        const disposition: Disposition = event.altKey ? 'new-tab' : event.shiftKey ? 'new-window' : 'current'
        const ctrlEnter = event.ctrlKey || event.metaKey
        const text = event.currentTarget.value
        const row = suggestionsPopup.open && result && !ctrlEnter ? result.suggestions[selected] : undefined
        if (row) submit(row.url, disposition, false, row.kind === 'search' ? row.title : row.url)
        else submit(text, disposition, ctrlEnter)
        break
      }
      case 'Escape':
        event.preventDefault()
        if (suggestionsPopup.open) {
          closeSuggestions()
          if (valueRef.current !== typed.current) setValue(typed.current)
        } else if (editedRef.current) {
          revert()
        } else {
          event.currentTarget.blur()
          window.aqua.ui.focusContent()
        }
        break
      case 'ArrowDown':
      case 'ArrowUp':
        if (result && result.suggestions.length > 0) {
          event.preventDefault()
          moveSelection(event.key === 'ArrowDown' ? 1 : -1)
        }
        break
    }
  }

  // ─── Bookmarks ─────────────────────────────────────────────────────────────
  const canBookmark = !!tab && /^(https?|file):/.test(tab.url)
  const openBookmarkBubble = async (): Promise<void> => {
    if (!tab || !/^(https?|file):/.test(tab.url)) return
    const exists = bookmarksStore.get().some((b) => b.url === tab.url)
    if (!exists) {
      await window.aqua.bookmarks.add({ url: tab.url, title: tab.title, favicon: tab.favicon })
      setStarPop(true)
    }
    bookmarkBubble.show()
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────
  const engine = SEARCH_ENGINES[settings.searchEngine]
  const editing = focused && edited
  const shownUrl = awaiting ? awaiting.text : urlText
  const display = !focused && !edited && shownUrl ? toDisplayUrl(shownUrl) : null
  const chip = securityChip(tab, editing || (focused && !urlText))

  return (
    <div
      ref={boxRef}
      className={cx('omnibox', focused && 'focused')}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
    >
      <button
        ref={chipRef}
        className={cx(
          'omnibox-chip',
          chip.label && 'labelled',
          chip.tone === 'danger' && 'danger',
          siteInfo.open && 'pressed'
        )}
        title={chip.title}
        aria-label={chip.title}
        disabled={!chip.interactive}
        {...siteInfo.anchorProps}
      >
        {chip.icon === 'aqua' ? <AquaMark size={16} /> : <Icon icon={chip.icon} size={16} />}
        {chip.label && <span className="omnibox-chip-label">{chip.label}</span>}
      </button>

      <div className="omnibox-field">
        <input
          ref={inputRef}
          className={cx('omnibox-input', display && 'masked')}
          value={value}
          placeholder={`Search ${engine.name} or type a URL`}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Address and search bar"
          aria-autocomplete="both"
          aria-expanded={suggestionsPopup.open}
          role="combobox"
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          onMouseDown={() => {
            if (!focusedRef.current) selectAllOnMouseUp.current = true
          }}
          onMouseUp={(e) => {
            if (!selectAllOnMouseUp.current) return
            selectAllOnMouseUp.current = false
            const input = e.currentTarget
            if (input.selectionStart === input.selectionEnd) {
              e.preventDefault()
              input.select()
            }
          }}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={(e) => {
            composing.current = false
            requestSuggestions(e.currentTarget.value, false)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            const input = e.currentTarget
            void window.aqua.ui.contextMenu({
              kind: 'omnibox',
              hasSelection: input.selectionStart !== input.selectionEnd,
              canUndo: editedRef.current
            })
          }}
          onDragStart={(e) => e.preventDefault()}
        />
        {display && (
          <div className="omnibox-display" aria-hidden>
            {display.scheme && <span className="dim">{display.scheme}</span>}
            <span className="host">{display.host}</span>
            {display.rest && <span className="dim">{display.rest}</span>}
          </div>
        )}
      </div>

      {!editing && tab && (
        <div className="omnibox-actions">
          {tab.blockedPopups > 0 && (
            <button
              className="omnibox-action"
              title={`Pop-up blocked (${tab.blockedPopups}). Click to open it.`}
              aria-label="Open blocked pop-up"
              onClick={() => void window.aqua.tabs.openBlockedPopup(tab.id)}
            >
              <Icon icon={Ban} />
            </button>
          )}
          {tab.zoomFactor !== 1 && (
            <button
              className="omnibox-action"
              title={`Zoom: ${Math.round(tab.zoomFactor * 100)}% - click to reset`}
              aria-label="Reset zoom"
              onClick={() => void window.aqua.ui.command('page.zoom-reset')}
            >
              <Icon icon={tab.zoomFactor > 1 ? ZoomIn : ZoomOut} />
            </button>
          )}
          {canBookmark && (
            <button
              ref={starRef}
              className={cx('omnibox-action', bookmarked && 'on', starPop && 'pop')}
              title={bookmarked ? 'Edit bookmark' : 'Bookmark this tab (Ctrl+D)'}
              aria-label={bookmarked ? 'Edit bookmark' : 'Bookmark this tab'}
              aria-pressed={bookmarked}
              {...bookmarkBubble.anchorProps}
              onAnimationEnd={() => setStarPop(false)}
            >
              <Icon icon={Star} />
            </button>
          )}
        </div>
      )}

      {suggestionsPopup.open && result && result.suggestions.length > 0 && (
        <Popup
          anchorRef={boxRef}
          align="start"
          offset={4}
          matchAnchorWidth
          focus={false}
          role="listbox"
          label="Suggestions"
          onDismiss={closeSuggestions}
        >
          <div className="suggestions">
            {result.suggestions.map((s, i) => (
              <SuggestionRow
                key={`${s.kind}:${s.url}`}
                suggestion={s}
                query={resultQuery}
                selected={i === selected}
                onHover={() => setSelected(i)}
                onPick={(disposition) => pick(i, disposition)}
              />
            ))}
          </div>
        </Popup>
      )}

      {siteInfo.open && tab && <SiteInfoPopup anchorRef={chipRef} tab={tab} onClose={siteInfo.close} />}
      {bookmarkBubble.open && tab && (
        <BookmarkBubble anchorRef={starRef.current ? starRef : boxRef} tab={tab} onClose={bookmarkBubble.close} />
      )}
    </div>
  )
}

interface ChipInfo {
  icon: LucideIcon | 'aqua'
  label?: string
  title: string
  tone?: 'danger'
  interactive: boolean
}

function securityChip(tab: TabState | null, searching: boolean): ChipInfo {
  if (!tab || searching) return { icon: Search, title: 'Search', interactive: false }
  if (tab.error && tab.security !== 'cert-error')
    return { icon: Info, title: 'View site information', interactive: true }
  switch (tab.security) {
    case 'secure':
      return { icon: Lock, title: 'Connection is secure. View site information', interactive: true }
    case 'insecure':
      return {
        icon: TriangleAlert,
        label: 'Not secure',
        title: 'Your connection to this site is not secure',
        interactive: true
      }
    case 'cert-error':
      return { icon: TriangleAlert, label: 'Not secure', title: 'Certificate error', tone: 'danger', interactive: true }
    case 'internal':
      return internalPageOf(tab.url) === 'newtab'
        ? { icon: Search, title: 'Search', interactive: false }
        : { icon: 'aqua', label: 'Aqua', title: 'Aqua internal page', interactive: true }
    case 'file':
      return { icon: FileIcon, label: 'File', title: 'Local or shared file', interactive: true }
    default:
      return { icon: Info, title: 'View site information', interactive: true }
  }
}

const SuggestionRow = memo(function SuggestionRow({
  suggestion,
  query,
  selected,
  onHover,
  onPick
}: {
  suggestion: Suggestion
  query: string
  selected: boolean
  onHover: () => void
  onPick: (disposition: Disposition) => void
}) {
  const icon = (() => {
    switch (suggestion.kind) {
      case 'search':
        return <Icon icon={Search} />
      case 'bookmark':
        return <Icon icon={Star} />
      case 'history':
        return suggestion.favicon ? <Favicon src={suggestion.favicon} /> : <Icon icon={Clock} />
      case 'internal':
        return <Favicon src={null} url={suggestion.url} />
      default:
        return <Icon icon={Globe} />
    }
  })()

  return (
    <div
      className={cx('suggestion', selected && 'selected')}
      role="option"
      aria-selected={selected}
      onMouseMove={selected ? undefined : onHover}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        onPick(e.altKey ? 'new-tab' : 'current')
      }}
      onAuxClick={(e) => {
        if (e.button === 1) onPick('background-tab')
      }}
    >
      <span className="suggestion-icon">{icon}</span>
      <span className="suggestion-text">
        <span className="suggestion-title">
          <Highlight text={suggestion.title} query={query} />
        </span>
        {suggestion.displayUrl && suggestion.kind !== 'url' && suggestion.kind !== 'search' && (
          <>
            <span className="suggestion-sep">-</span>
            <span className="suggestion-url">{suggestion.displayUrl}</span>
          </>
        )}
        {suggestion.displayUrl && (suggestion.kind === 'search' || suggestion.kind === 'url') && (
          <>
            <span className="suggestion-sep">-</span>
            <span className="suggestion-hint">{suggestion.displayUrl}</span>
          </>
        )}
      </span>
    </div>
  )
})

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase()
  if (!q) return <>{text}</>
  const at = text.toLowerCase().indexOf(q)
  if (at === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  )
}
