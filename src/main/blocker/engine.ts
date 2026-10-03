import type { Config } from '@ghostery/adblocker'

/**
 * How the filter engine is built. Shared by the build worker and the tests so
 * both compile the lists exactly the same way.
 */
export const ENGINE_CONFIG: Partial<Config> = {
  loadNetworkFilters: true,
  loadCosmeticFilters: true,
  loadGenericCosmeticsFilters: true,
  loadCSPFilters: true,
  loadExceptionFilters: true,
  // uBO's lists use `!#if env_…` blocks; they are resolved against BLOCKER_ENV.
  loadPreprocessors: true,
  // Procedural selectors (`:has-text()`, `:upward()`…) need a DOM engine in the page; not used.
  loadExtendedSelectors: false,
  // HTML filtering (`##^`) rewrites response bodies, which Electron offers no way to do.
  enableHtmlFiltering: false,
  enableMutationObserver: true,
  guessRequestTypeFromUrl: false,
  integrityCheck: true
}

/**
 * The platform the lists should be evaluated for: they are uBlock Origin's,
 * running in Chromium, with user stylesheets available (Aqua injects its
 * element-hiding rules with the user origin, as uBO does).
 */
export function blockerEnv(): Map<string, boolean> {
  return new Map([
    ['ext_ublock', true],
    ['env_chromium', true],
    ['cap_user_stylesheet', true],
    ['cap_html_filtering', false],
    ['env_mv3', false],
    ['env_mobile', false],
    ['env_firefox', false],
    ['env_safari', false]
  ])
}
