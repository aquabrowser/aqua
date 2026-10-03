/**
 * Whether a page may start a download, like Chromium's download request
 * limiter:
 *
 *   - The first download of a page is allowed.
 *   - After that, every click or keypress in the page allows one more.
 *   - A download without a fresh interaction is held and the user is asked
 *     once ("Download multiple files?"). Downloads arriving meanwhile wait
 *     for the same answer instead of asking again.
 *   - "Allow" lets the page download freely - but a page that keeps going
 *     (more than AUTOMATIC_BURST downloads a minute without interaction) is
 *     asked again. "Block" refuses the rest of the page's automatic
 *     downloads; dismissing the question refuses them for a short while.
 *
 * The state belongs to one page: the tab resets it when the user moves on to
 * another site. Pure logic (the clock is passed in) so it can be unit tested.
 */

export type DownloadVerdict = 'allow' | 'deny' | 'ask'
export type DownloadGateStatus = 'allow-one' | 'prompt' | 'allow-all' | 'block-all'

/** Automatic downloads per minute a page may make even after "Allow". */
export const AUTOMATIC_BURST = 10
const BURST_WINDOW_MS = 60_000
/** After the question is dismissed, automatic downloads are refused this long without asking again. */
export const DISMISS_QUIET_MS = 30_000
/** Downloads that can wait for one answer; any beyond are refused outright. */
export const MAX_HELD = 10

export class DownloadGate {
  private state: DownloadGateStatus = 'allow-one'
  /** Time of the last user input that has already been spent on a download. */
  private spentInput = 0
  private automatic: number[] = []
  private quietUntil = 0
  private held = 0
  private asking = false

  get status(): DownloadGateStatus {
    return this.state
  }

  /** `lastInput`: time of the user's latest click or keypress in the page (0 if none). */
  decide(now: number, lastInput: number): DownloadVerdict {
    if (this.state === 'block-all') return 'deny'
    const freshInput = lastInput > this.spentInput
    if (this.state === 'allow-one' || freshInput) {
      if (this.state === 'allow-one') this.state = 'prompt'
      this.spentInput = Math.max(this.spentInput, lastInput)
      return 'allow'
    }
    if (this.state === 'allow-all') {
      this.automatic = this.automatic.filter((t) => now - t < BURST_WINDOW_MS)
      if (this.automatic.length < AUTOMATIC_BURST) {
        this.automatic.push(now)
        return 'allow'
      }
      // A page that never stops downloading has to be allowed again.
      this.state = 'prompt'
      this.automatic = []
    }
    if (now < this.quietUntil) return 'deny'
    if (this.held >= MAX_HELD) return 'deny'
    this.held++
    return 'ask'
  }

  /** Whether a question is already open (further held downloads join it). */
  get isAsking(): boolean {
    return this.asking
  }

  markAsking(): void {
    this.asking = true
  }

  /** The user answered; applies to every download that was waiting. */
  answer(decision: 'allow' | 'block' | 'dismiss', now: number): void {
    this.asking = false
    this.held = 0
    if (decision === 'allow') {
      this.state = 'allow-all'
      this.automatic = []
    } else if (decision === 'block') {
      this.state = 'block-all'
    } else {
      this.quietUntil = now + DISMISS_QUIET_MS
    }
  }

  /** A new page: back to "first download allowed". */
  reset(): void {
    this.state = 'allow-one'
    this.automatic = []
    this.quietUntil = 0
    this.held = 0
    this.asking = false
  }
}
