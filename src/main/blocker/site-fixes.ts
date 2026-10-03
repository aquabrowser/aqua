/**
 * Aqua's own fixes for side effects of blocking that the filter lists leave
 * behind. They run only where blocking is on (a paused site is left alone),
 * in the page world before the page's scripts, like scriptlets.
 */

/**
 * YouTube sometimes shows "Experiencing interruptions? Find out why" when it
 * suspects an ad blocker, although the video plays fine. That snackbar comes
 * from the player and its button leads to YouTube's help centre; ordinary
 * snackbars ("Saved to Watch later", "Link copied") don't link there. Only
 * the help-centre ones are hidden, whatever the page's language.
 *
 * Self-contained: it is serialised and run in the page.
 */
function hideYouTubeInterruptionNotice(): void {
  const HELP_CENTRE = /^https?:\/\/support\.google\.com\/youtube/
  type Endpoint = { urlEndpoint?: { url?: string }; commandMetadata?: { webCommandMetadata?: { url?: string } } }
  type NoticeElement = HTMLElement & {
    data?: { actionButton?: { buttonRenderer?: { navigationEndpoint?: Endpoint } } }
  }

  const pointsToHelp = (el: NoticeElement): boolean => {
    const endpoint = el.data?.actionButton?.buttonRenderer?.navigationEndpoint
    return HELP_CENTRE.test(endpoint?.urlEndpoint?.url ?? endpoint?.commandMetadata?.webCommandMetadata?.url ?? '')
  }
  const update = (container: Element): void => {
    for (const el of Array.from(
      container.querySelectorAll<NoticeElement>(':scope > yt-notification-action-renderer')
    )) {
      if (pointsToHelp(el)) el.style.setProperty('display', 'none', 'important')
      else if (el.style.getPropertyValue('display') === 'none') el.style.removeProperty('display')
    }
  }
  // Only the popup container is watched: the rest of YouTube's DOM changes constantly.
  const watch = (container: Element): void => {
    new MutationObserver(() => update(container)).observe(container, {
      childList: true,
      subtree: true,
      characterData: true
    })
    update(container)
  }
  const existing = document.querySelector('ytd-popup-container')
  if (existing) return watch(existing)
  const boot = new MutationObserver(() => {
    const container = document.querySelector('ytd-popup-container')
    if (!container) return
    boot.disconnect()
    watch(container)
  })
  boot.observe(document, { childList: true, subtree: true })
}

const FIXES: ReadonlyArray<{ hosts: readonly string[]; script: () => void }> = [
  { hosts: ['youtube.com'], script: hideYouTubeInterruptionNotice }
]

const serialise = (fn: () => void): string => `(${fn.toString()})();`

/** Scripts to run in a frame of `hostname` (the host itself or any subdomain of a listed host). */
export function siteFixScripts(hostname: string): string[] {
  const host = hostname.toLowerCase()
  return FIXES.filter((fix) => fix.hosts.some((h) => host === h || host.endsWith(`.${h}`))).map((fix) =>
    serialise(fix.script)
  )
}
