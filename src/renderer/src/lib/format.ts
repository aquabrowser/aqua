const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[i]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "just now", "5 minutes ago", "yesterday", "3 days ago", then a date. */
export function formatAgo(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return relative.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return relative.format(-hours, 'hour')
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  if (days < 30) return relative.format(-days, 'day')
  return formatDate(ts)
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "Today", "Yesterday", weekday for the last week, then a full date. */
export function dayLabel(ts: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  const opts: Intl.DateTimeFormatOptions =
    diff < 7
      ? { weekday: 'long', month: 'long', day: 'numeric' }
      : { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
  return new Date(ts).toLocaleDateString(undefined, opts)
}

export function dayKey(ts: number): number {
  return startOfDay(ts)
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
