import { useLayoutEffect, useRef } from 'react'
import type { TabState } from '@shared/types'

/** Where the bar heads for each load milestone, and how long it takes to creep there. */
const TARGETS = {
  started: [0.55, 7000],
  committed: [0.8, 5000],
  'dom-ready': [0.93, 3000]
} as const

const CREEP = 'cubic-bezier(0.05, 0.75, 0.2, 1)'

/**
 * Chrome-style load indicator. Driven imperatively with transform/opacity
 * transitions only (compositor-only, no layout), so it stays smooth even while
 * the renderer is busy re-rendering the tab strip.
 */
export function ProgressBar({ tab }: { tab: TabState | null }) {
  const barRef = useRef<HTMLDivElement>(null)
  const phase = useRef<'idle' | 'running' | 'finishing'>('idle')
  const lastTabId = useRef<string | null>(null)
  const finishTimer = useRef<number>(0)

  const tabId = tab?.id ?? null
  const loading = !!tab && tab.loading && !tab.discarded
  const stage = tab?.loadStage ?? 'idle'

  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const jump = (scale: number, opacity: number): void => {
      el.style.transition = 'none'
      el.style.transform = `scaleX(${scale})`
      el.style.opacity = String(opacity)
      void el.offsetWidth // commit the jump before the next transition starts
    }

    if (lastTabId.current !== tabId) {
      lastTabId.current = tabId
      window.clearTimeout(finishTimer.current)
      jump(0, 0)
      phase.current = 'idle'
    }

    if (loading) {
      window.clearTimeout(finishTimer.current)
      if (phase.current !== 'running') {
        jump(0.02, 1)
        phase.current = 'running'
      }
      const [target, duration] = stage === 'idle' ? TARGETS.started : TARGETS[stage]
      el.style.transition = `transform ${duration}ms ${CREEP}, opacity 120ms linear`
      el.style.transform = `scaleX(${target})`
      el.style.opacity = '1'
    } else if (phase.current === 'running') {
      phase.current = 'finishing'
      el.style.transition = 'transform 220ms cubic-bezier(0.2, 0, 0, 1), opacity 260ms linear 180ms'
      el.style.transform = 'scaleX(1)'
      el.style.opacity = '0'
      finishTimer.current = window.setTimeout(() => {
        if (phase.current === 'finishing') {
          jump(0, 0)
          phase.current = 'idle'
        }
      }, 480)
    }
  }, [tabId, loading, stage])

  useLayoutEffect(() => () => window.clearTimeout(finishTimer.current), [])

  return (
    <div className="progress" role="progressbar" aria-hidden={!loading} aria-label="Page load progress">
      <div ref={barRef} className="progress-bar" />
    </div>
  )
}
