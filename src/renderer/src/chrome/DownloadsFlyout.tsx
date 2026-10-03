import { memo, type RefObject } from 'react'
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  FolderOpen,
  Pause,
  Play,
  RotateCw,
  X,
  type LucideIcon
} from 'lucide-react'
import type { DownloadEntry } from '@shared/types'
import { Icon } from '../components/Icon'
import { Popup } from '../components/Popup'
import { cx, fileExtension, formatBytes, formatDuration, formatSpeed } from '../lib/format'
import { downloadsStore, useStore } from '../store'

const KIND_ICONS: Array<[RegExp, LucideIcon]> = [
  [/^(zip|rar|7z|tar|gz|bz2|xz|tgz|zst)$/, FileArchive],
  [/^(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic|tiff?)$/, FileImage],
  [/^(mp4|mkv|mov|webm|avi|m4v|wmv)$/, FileVideo],
  [/^(mp3|wav|flac|ogg|m4a|aac|opus)$/, FileAudio],
  [/^(js|ts|tsx|jsx|json|py|rs|go|java|c|cpp|h|cs|rb|php|sh|ps1|html|css|xml|yml|yaml)$/, FileCode],
  [/^(pdf|txt|md|doc|docx|rtf|odt|csv|xls|xlsx|ppt|pptx)$/, FileText]
]

export function FileKindIcon({ name, size = 18 }: { name: string; size?: number }) {
  const ext = fileExtension(name)
  const icon = KIND_ICONS.find(([re]) => re.test(ext))?.[1] ?? FileIcon
  return (
    <span className="file-icon">
      <Icon icon={icon} size={size} />
      {ext && ext.length <= 4 && <span className="ext">{ext}</span>}
    </span>
  )
}

/** One-line status used by both the flyout and the downloads page. */
export function downloadStatusText(d: DownloadEntry): string {
  const size =
    d.totalBytes > 0 ? `${formatBytes(d.receivedBytes)} of ${formatBytes(d.totalBytes)}` : formatBytes(d.receivedBytes)
  switch (d.status) {
    case 'progressing': {
      if (d.speed <= 0) return `${size} · Starting…`
      const eta = d.totalBytes > 0 ? ` · ${formatDuration((d.totalBytes - d.receivedBytes) / d.speed)} left` : ''
      return `${size} · ${formatSpeed(d.speed)}${eta}`
    }
    case 'paused':
      return `Paused · ${size}`
    case 'completed':
      return d.fileMissing ? 'Deleted' : formatBytes(d.totalBytes || d.receivedBytes)
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      return 'Failed · Network error'
  }
}

export const DownloadActions = memo(function DownloadActions({ d }: { d: DownloadEntry }) {
  const act = (action: Parameters<typeof window.aqua.downloads.action>[1]) => (e: { stopPropagation(): void }) => {
    e.stopPropagation()
    void window.aqua.downloads.action(d.id, action)
  }
  return (
    <div className="download-actions">
      {d.status === 'progressing' && (
        <button className="mini-button" title="Pause" aria-label="Pause" onClick={act('pause')}>
          <Icon icon={Pause} />
        </button>
      )}
      {d.status === 'paused' && (
        <button className="mini-button" title="Resume" aria-label="Resume" onClick={act('resume')}>
          <Icon icon={Play} />
        </button>
      )}
      {(d.status === 'interrupted' || d.status === 'cancelled') && (
        <button className="mini-button" title="Retry" aria-label="Retry" onClick={act('retry')}>
          <Icon icon={RotateCw} />
        </button>
      )}
      {d.status === 'completed' && !d.fileMissing && (
        <button className="mini-button" title="Show in folder" aria-label="Show in folder" onClick={act('show')}>
          <Icon icon={FolderOpen} />
        </button>
      )}
      {(d.status === 'progressing' || d.status === 'paused') && (
        <button className="mini-button" title="Cancel" aria-label="Cancel" onClick={act('cancel')}>
          <Icon icon={X} />
        </button>
      )}
    </div>
  )
})

export function DownloadProgress({ d }: { d: DownloadEntry }) {
  if (d.status !== 'progressing' && d.status !== 'paused') return null
  const indeterminate = d.totalBytes <= 0
  const fraction = indeterminate ? 0 : Math.min(1, d.receivedBytes / d.totalBytes)
  return (
    <div className={cx('download-progress', d.status === 'paused' && 'paused', indeterminate && 'indeterminate')}>
      <div style={indeterminate ? undefined : { transform: `scaleX(${fraction})` }} />
    </div>
  )
}

export function DownloadsFlyout({
  anchorRef,
  onClose
}: {
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const downloads = useStore(downloadsStore)
  const recent = downloads.slice(0, 6)
  return (
    <Popup anchorRef={anchorRef} align="end" width={380} onDismiss={onClose} label="Recent downloads">
      <div className="popup-header">
        <div className="popup-title">Recent downloads</div>
      </div>
      <div className="popup-scroll" style={{ paddingBottom: 4 }}>
        {recent.length === 0 && <div className="popup-empty">Files you download appear here</div>}
        {recent.map((d) => {
          const openable = d.status === 'completed' && !d.fileMissing
          return (
            <div
              key={d.id}
              className={cx('download-row', openable && 'clickable')}
              title={openable ? `Open ${d.filename}` : d.filename}
              onClick={openable ? () => void window.aqua.downloads.action(d.id, 'open') : undefined}
            >
              <FileKindIcon name={d.filename} />
              <div className="download-main">
                <div className={cx('download-name', (d.status === 'cancelled' || d.fileMissing) && 'struck')}>
                  {d.filename}
                </div>
                <div className={cx('download-meta', d.status === 'interrupted' && 'error')}>
                  {downloadStatusText(d)}
                </div>
                <DownloadProgress d={d} />
              </div>
              <DownloadActions d={d} />
            </div>
          )
        })}
      </div>
      <div className="popup-divider" />
      <div className="popup-footer" style={{ justifyContent: 'space-between' }}>
        <span className="popup-subtitle" style={{ paddingLeft: 6 }}>
          {downloads.length > recent.length ? `${downloads.length - recent.length} more` : ''}
        </span>
        <button
          className="link-button"
          onClick={() => {
            onClose()
            void window.aqua.ui.command('open.downloads')
          }}
        >
          Show all downloads
        </button>
      </div>
    </Popup>
  )
}
