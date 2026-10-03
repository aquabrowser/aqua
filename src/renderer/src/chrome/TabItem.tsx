import {
  memo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { Frown, Volume2, VolumeX, X } from 'lucide-react'
import type { TabState } from '@shared/types'
import { formatUrlForDisplay, internalPageOf } from '@shared/url'
import { Favicon } from '../components/Favicon'
import { Icon } from '../components/Icon'
import { cx } from '../lib/format'

export interface TabItemProps {
  tab: TabState
  active: boolean
  entering: boolean
  closing: boolean
  /** Width the tab had when it was closed (see `.tab.closing`). */
  closingWidth?: number
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, tab: TabState) => void
  onClose: (tab: TabState, event: ReactMouseEvent) => void
  onToggleMute: (tab: TabState) => void
  onContextMenu: (tab: TabState) => void
  onEntered: (id: string) => void
}

function tooltip(tab: TabState): string {
  const page = internalPageOf(tab.url)
  const where = page ? '' : `\n${formatUrlForDisplay(tab.url)}`
  // One fact per line, as in a hover card: title, then status, then address.
  const audio = tab.muted ? '\nMuted' : tab.audible ? '\nPlaying audio' : ''
  const waiting = tab.hasPrompt ? '\nWaiting for your response' : ''
  return `${tab.title}${audio}${waiting}${where}`
}

export const TabItem = memo(function TabItem({
  tab,
  active,
  entering,
  closing,
  closingWidth,
  onPointerDown,
  onClose,
  onToggleMute,
  onContextMenu,
  onEntered
}: TabItemProps) {
  const showSpinner = tab.loading && !tab.discarded && !tab.crashed
  const hasAudio = tab.audible || tab.muted

  const icon = tab.crashed ? (
    <span className="tab-icon crashed">
      <Icon icon={Frown} />
    </span>
  ) : (
    <span className="tab-icon">
      {showSpinner ? (
        <span className={cx('spinner', tab.loadStage === 'started' && 'waiting')} />
      ) : (
        <Favicon src={tab.favicon} url={tab.url} />
      )}
      {tab.pinned && hasAudio && (
        <span className="tab-badge">
          <Icon icon={tab.muted ? VolumeX : Volume2} size={10} stroke={1.4} />
        </span>
      )}
      {tab.hasPrompt && !active && <span className="tab-attention" />}
    </span>
  )

  const stop = (event: { stopPropagation(): void }): void => event.stopPropagation()

  return (
    <div
      className={cx('tab', active && 'active', tab.pinned && 'pinned', entering && 'entering', closing && 'closing')}
      data-id={tab.id}
      style={closing ? ({ '--closing-w': `${closingWidth ?? 0}px` } as CSSProperties) : undefined}
      role="tab"
      aria-selected={active}
      title={tooltip(tab)}
      onPointerDown={closing ? undefined : (e) => onPointerDown(e, tab)}
      onMouseDown={(e) => e.button === 1 && e.preventDefault() /* no autoscroll on middle-click */}
      onAuxClick={(e) => {
        if (e.button === 1 && !tab.pinned) onClose(tab, e)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(tab)
      }}
      onAnimationEnd={(e) => {
        if (e.animationName === 'tab-open') onEntered(tab.id)
      }}
    >
      <div className="tab-bg" />
      <div className="tab-content">
        {icon}
        {!tab.pinned && <span className="tab-title">{tab.title}</span>}
        {!tab.pinned && hasAudio && (
          <button
            className={cx('tab-button audio', tab.muted && 'muted')}
            title={tab.muted ? 'Unmute tab' : 'Mute tab'}
            aria-label={tab.muted ? 'Unmute tab' : 'Mute tab'}
            onPointerDown={stop}
            onClick={(e) => {
              stop(e)
              onToggleMute(tab)
            }}
          >
            <Icon icon={tab.muted ? VolumeX : Volume2} size={14} />
          </button>
        )}
        {!tab.pinned && (
          <button
            className="tab-button close"
            title="Close tab"
            aria-label={`Close ${tab.title}`}
            onPointerDown={stop}
            onClick={(e) => {
              stop(e)
              onClose(tab, e)
            }}
          >
            <Icon icon={X} size={14} />
          </button>
        )}
      </div>
    </div>
  )
})
