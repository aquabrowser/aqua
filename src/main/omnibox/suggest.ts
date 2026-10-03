import type { SearchEngineId, Suggestion, SuggestResult } from '../../shared/types'
import { SEARCH_ENGINES, searchUrl } from '../../shared/search'
import { formatUrlForDisplay } from '../../shared/url'
import type { BookmarksService } from '../services/bookmarks'
import type { HistoryService, UrlStats } from '../services/history'
import { classifyInput } from './classify'

const MAX_ROWS = 7
/** Minimum score for a history row to be promoted to the default (inline-autocompleted) match. */
const INLINE_THRESHOLD = 1150

const INTERNAL_PAGES: Array<{ url: string; title: string; keywords: string[] }> = [
  { url: 'aqua://settings', title: 'Settings', keywords: ['settings', 'preferences', 'options'] },
  { url: 'aqua://history', title: 'History', keywords: ['history'] },
  { url: 'aqua://downloads', title: 'Downloads', keywords: ['downloads'] },
  { url: 'aqua://newtab', title: 'New Tab', keywords: ['newtab'] }
]

interface Candidate {
  url: string
  title: string
  favicon: string | null
  display: string
  score: number
  kind: Suggestion['kind']
}

function displayKey(url: string): string {
  return formatUrlForDisplay(url).replace(/\/$/, '')
}

function textScore(url: string, display: string, title: string, q: string): number {
  const d = display.toLowerCase()
  const host = d.split(/[/?#]/, 1)[0]
  if (d.startsWith(q)) return q.length <= host.length ? 1100 : 1000
  if (url.toLowerCase().startsWith(q)) return 950
  if (host.split('.').some((label) => label.startsWith(q))) return 800
  const t = title.toLowerCase()
  if (t.split(/[\s\-_|:·–/,.()]+/).some((w) => w && w.startsWith(q))) return 700
  if (q.length >= 3 && d.includes(q)) return 500
  if (q.length >= 3 && t.includes(q)) return 450
  return 0
}

function frecency(row: UrlStats, now: number): number {
  const ageDays = (now - row.lastVisit) / 86_400_000
  const recency = ageDays < 1 ? 120 : ageDays < 7 ? 60 : ageDays < 30 ? 20 : 0
  return Math.min(300, Math.log2(row.visits + 1) * 60) + Math.min(200, row.typed * 40) + recency
}

export function suggest(
  input: string,
  deps: { history: HistoryService; bookmarks: BookmarksService; engine: SearchEngineId }
): SuggestResult {
  const text = input.trim()
  if (!text) return { input, suggestions: [], inlineCompletion: null }

  const q = text.toLowerCase()
  const now = Date.now()
  const candidates = new Map<string, Candidate>()

  const offer = (c: Candidate): void => {
    const existing = candidates.get(c.url)
    if (!existing || existing.score < c.score) candidates.set(c.url, c)
  }

  for (const row of deps.history.stats()) {
    const display = displayKey(row.url)
    const base = textScore(row.url, display, row.title, q)
    if (!base) continue
    // Shorter URLs win ties: the site root is a better default than a deep link.
    const score = base + frecency(row, now) - Math.min(80, display.length * 0.6)
    offer({ url: row.url, title: row.title, favicon: row.favicon, display, score, kind: 'history' })
  }

  for (const bm of deps.bookmarks.list()) {
    const display = displayKey(bm.url)
    const base = textScore(bm.url, display, bm.title, q)
    if (!base) continue
    const score = base + 150 - Math.min(80, display.length * 0.6)
    offer({ url: bm.url, title: bm.title, favicon: bm.favicon, display, score, kind: 'bookmark' })
  }

  for (const page of INTERNAL_PAGES) {
    const matches = page.url.startsWith(q) || (q.length >= 3 && page.keywords.some((k) => k.startsWith(q)))
    if (matches)
      offer({ url: page.url, title: page.title, favicon: null, display: page.url, score: 760, kind: 'internal' })
  }

  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score)

  // Inline autocompletion only for plain forward typing of a URL prefix.
  let inline: Candidate | null = null
  if (!/\s/.test(text)) {
    inline =
      ranked.find(
        (c) => c.kind !== 'internal' && c.score >= INLINE_THRESHOLD && c.display.toLowerCase().startsWith(q)
      ) ?? null
  }

  const typed = classifyInput(text)
  const engine = SEARCH_ENGINES[deps.engine]
  const typedRows: Suggestion[] = []
  if (typed.type === 'search') {
    typedRows.push({
      kind: 'search',
      url: searchUrl(deps.engine, typed.query),
      title: typed.query,
      displayUrl: `${engine.name} Search`,
      fill: text
    })
  } else {
    typedRows.push({
      kind: 'url',
      url: typed.url,
      title: formatUrlForDisplay(typed.url),
      displayUrl: typed.type === 'external' ? 'Open in external application' : '',
      fill: text
    })
    typedRows.push({
      kind: 'search',
      url: searchUrl(deps.engine, text),
      title: text,
      displayUrl: `${engine.name} Search`,
      fill: text
    })
  }

  const toRow = (c: Candidate): Suggestion => ({
    kind: c.kind,
    url: c.url,
    title: c.title || c.display,
    displayUrl: c.display,
    fill: c.display,
    favicon: c.favicon
  })

  const rows: Suggestion[] = []
  const seen = new Set<string>()
  const push = (s: Suggestion): void => {
    if (seen.has(s.url) || rows.length >= MAX_ROWS) return
    seen.add(s.url)
    rows.push(s)
  }
  if (inline) push(toRow(inline))
  typedRows.forEach(push)
  ranked.forEach((c) => push(toRow(c)))

  return {
    input,
    suggestions: rows,
    inlineCompletion: inline ? inline.display.slice(text.length) || null : null
  }
}
