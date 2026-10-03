import { useEffect, useRef, useState } from 'react'
import { EyeOff, KeyRound, MemoryStick, ShieldCheck, type LucideIcon } from 'lucide-react'
import type { SearchEngineId } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/search'
import { AquaMark, Icon } from '../components/Icon'
import { cx } from '../lib/format'
import { useSettings } from '../store'

/**
 * The first-run welcome, in three steps on the lock screen's surface:
 *   1. what Aqua does with your data (WelcomeIntro, in LockScreen's setup mode)
 *   2. the master password (LockScreen's vault setup)
 *   3. the search engine (OnboardingSearch, once the new vault is open)
 * The last step sets `onboardingCompleted`, so it all runs once per profile.
 */
export const ONBOARDING_STEPS = 3

export function OnboardingSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="onboarding-steps" aria-label={`Step ${current} of ${ONBOARDING_STEPS}`}>
      {Array.from({ length: ONBOARDING_STEPS }, (_, i) => (
        <span key={i} className={cx(i + 1 === current && 'current', i + 1 < current && 'done')} />
      ))}
    </div>
  )
}

const FACTS: Array<{ icon: LucideIcon; title: string; text: string }> = [
  {
    icon: KeyRound,
    title: 'One encrypted vault',
    text: 'History, bookmarks, tabs, cookies and settings are sealed with AES-256-GCM. Only your master password opens it.'
  },
  {
    icon: MemoryStick,
    title: 'Pages run in memory',
    text: 'Chromium writes no cookie database or site storage to disk. Cookies and first-party site data are kept in the vault.'
  },
  {
    icon: ShieldCheck,
    title: 'Blocker built in',
    text: 'Ads and trackers are blocked with uBlock Origin’s filter lists, in every window.'
  },
  {
    icon: EyeOff,
    title: 'No telemetry',
    text: 'No usage statistics, crash reports or update checks are sent.'
  }
]

/** Step 1: plain facts about where the data goes, before anything is asked. */
export function WelcomeIntro({ onContinue }: { onContinue: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <>
      <h1 className="lock-title">Welcome to Aqua</h1>
      <p className="lock-subtitle">A browser that keeps what it knows about you encrypted, on this device.</p>
      <ul className="onboarding-facts">
        {FACTS.map((f) => (
          <li key={f.title}>
            <span className="onboarding-fact-icon">
              <Icon icon={f.icon} size={16} stroke={1.7} />
            </span>
            <div>
              <strong>{f.title}</strong>
              <span>{f.text}</span>
            </div>
          </li>
        ))}
      </ul>
      <button ref={buttonRef} className="btn primary lock-submit" type="button" onClick={onContinue}>
        Continue
      </button>
      <OnboardingSteps current={1} />
    </>
  )
}

/** Step 3, over the browser once the new vault is open. */
export function OnboardingSearch({ leaving }: { leaving: boolean }) {
  const settings = useSettings()
  const [engine, setEngine] = useState<SearchEngineId>(settings.searchEngine)
  const [busy, setBusy] = useState(false)
  const startRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const frame = requestAnimationFrame(() => startRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [])

  const finish = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    await window.aqua.settings.update({ searchEngine: engine, onboardingCompleted: true })
  }

  return (
    <div
      className={cx('lock-screen', leaving && 'leaving')}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a search engine"
    >
      <div className="lock-titlebar" />
      <div className="lock-center">
        <div className="lock-panel wide">
          <div className="lock-mark">
            <AquaMark size={56} />
          </div>
          <h1 className="lock-title">Choose a search engine</h1>
          <p className="lock-subtitle">Used for searches typed in the address bar. You can change it in Settings.</p>
          <div className="engine-grid onboarding-engines" role="radiogroup" aria-label="Search engine">
            {Object.values(SEARCH_ENGINES).map((e) => (
              <button
                key={e.id}
                type="button"
                className="choice-card"
                role="radio"
                aria-checked={engine === e.id}
                onClick={() => setEngine(e.id)}
              >
                <strong>{e.name}</strong>
                <span>{e.description}</span>
              </button>
            ))}
          </div>
          <button
            ref={startRef}
            className="btn primary lock-submit"
            type="button"
            disabled={busy}
            onClick={() => void finish()}
          >
            Start browsing
          </button>
          <OnboardingSteps current={3} />
        </div>
      </div>
    </div>
  )
}
