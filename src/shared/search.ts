import type { SearchEngineId } from './types'

export interface SearchEngine {
  id: SearchEngineId
  name: string
  /** `%s` is replaced by the URI-encoded query. */
  template: string
  description: string
}

export const SEARCH_ENGINES: Record<SearchEngineId, SearchEngine> = {
  duckduckgo: {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    template: 'https://duckduckgo.com/?q=%s',
    description: 'Private by default, no search history profiling'
  },
  google: {
    id: 'google',
    name: 'Google',
    template: 'https://www.google.com/search?q=%s',
    description: 'Largest index, personalised results'
  },
  brave: {
    id: 'brave',
    name: 'Brave Search',
    template: 'https://search.brave.com/search?q=%s',
    description: 'Independent index, no user profiling'
  },
  bing: {
    id: 'bing',
    name: 'Bing',
    template: 'https://www.bing.com/search?q=%s',
    description: 'Microsoft web search'
  },
  startpage: {
    id: 'startpage',
    name: 'Startpage',
    template: 'https://www.startpage.com/sp/search?query=%s',
    description: 'Google results through a privacy proxy'
  }
}

export function searchUrl(engine: SearchEngineId, query: string): string {
  return SEARCH_ENGINES[engine].template.replace('%s', encodeURIComponent(query))
}
