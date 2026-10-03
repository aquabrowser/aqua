import { useEffect, useState } from 'react'
import {
  Ban,
  CloudOff,
  FileQuestion,
  Link2Off,
  ShieldAlert,
  TriangleAlert,
  WifiOff,
  type LucideIcon
} from 'lucide-react'
import type { TabState } from '@shared/types'
import { NEW_TAB_URL } from '@shared/url'
import { Icon } from '../components/Icon'
import { cx } from '../lib/format'

type ErrorKind =
  | 'offline'
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'reset'
  | 'empty'
  | 'redirects'
  | 'certificate'
  | 'blocked'
  | 'file'
  | 'scheme'
  | 'generic'

interface Copy {
  icon: LucideIcon
  title: string
  body: (host: string) => string
  tips?: string[]
  /** Retry automatically when the network comes back. */
  autoRetry?: boolean
  danger?: boolean
}

function kindOf(code: number): ErrorKind {
  if (code <= -200 && code > -300) return 'certificate'
  switch (code) {
    case -106:
    case -21:
      return 'offline'
    case -105:
    case -137:
      return 'dns'
    case -102:
      return 'refused'
    case -7:
    case -118:
      return 'timeout'
    case -100:
    case -101:
    case -104:
    case -109:
      return 'reset'
    case -324:
      return 'empty'
    case -310:
      return 'redirects'
    case -20:
    case -27:
      return 'blocked'
    case -6:
      return 'file'
    case -300:
    case -301:
    case -302:
      return 'scheme'
    default:
      return 'generic'
  }
}

const COPY: Record<ErrorKind, Copy> = {
  offline: {
    icon: WifiOff,
    title: 'You’re offline',
    body: () => 'Aqua can’t reach the internet. The page reloads by itself once you’re back online.',
    tips: ['Check network cables, modem and router', 'Reconnect to Wi-Fi'],
    autoRetry: true
  },
  dns: {
    icon: CloudOff,
    title: 'This site can’t be reached',
    body: (host) => `Couldn’t find the server for ${host}.`,
    tips: ['Check the address for typos', 'Check your internet connection', 'Check your DNS or proxy settings'],
    autoRetry: true
  },
  refused: {
    icon: Link2Off,
    title: 'This site can’t be reached',
    body: (host) => `${host} refused to connect.`,
    tips: ['Check that the server is running', 'Check your proxy and firewall settings']
  },
  timeout: {
    icon: CloudOff,
    title: 'This site can’t be reached',
    body: (host) => `${host} took too long to respond.`,
    tips: ['Check your internet connection', 'Try again in a moment'],
    autoRetry: true
  },
  reset: {
    icon: Link2Off,
    title: 'This site can’t be reached',
    body: () => 'The connection was interrupted.',
    tips: ['Check your internet connection', 'Check your proxy and firewall settings'],
    autoRetry: true
  },
  empty: {
    icon: TriangleAlert,
    title: 'This page isn’t working',
    body: (host) => `${host} didn’t send any data.`
  },
  redirects: {
    icon: TriangleAlert,
    title: 'This page isn’t working',
    body: (host) => `${host} redirected you too many times.`,
    tips: ['Try clearing cookies for this site in Settings → Privacy']
  },
  certificate: {
    icon: ShieldAlert,
    title: 'Your connection isn’t private',
    body: (host) =>
      `Attackers might be trying to steal your information from ${host} (for example, passwords, messages or credit cards).`,
    danger: true
  },
  blocked: {
    icon: Ban,
    title: 'This page has been blocked',
    body: (host) => `The request to ${host} was blocked.`
  },
  file: {
    icon: FileQuestion,
    title: 'Your file couldn’t be accessed',
    body: () => 'It may have been moved, edited or deleted.'
  },
  scheme: {
    icon: TriangleAlert,
    title: 'This address isn’t supported',
    body: () => 'Aqua can’t open this kind of address.'
  },
  generic: {
    icon: TriangleAlert,
    title: 'This page isn’t working',
    body: (host) => `${host || 'The page'} couldn’t be loaded.`
  }
}

export function ErrorPage({ tab }: { tab: TabState }) {
  const error = tab.error!
  const kind = kindOf(error.code)
  const copy = COPY[kind]
  const [advanced, setAdvanced] = useState(false)
  const [details, setDetails] = useState(false)

  let host = error.url
  try {
    host = new URL(error.url).host || error.url
  } catch {
    /* keep raw */
  }

  const reload = (): void => void window.aqua.tabs.reload(tab.id)

  // Network errors retry by themselves once the connection returns (as Chrome does).
  const tabId = tab.id
  const autoRetry = !!copy.autoRetry
  useEffect(() => {
    if (!autoRetry) return
    const onOnline = (): void => void window.aqua.tabs.reload(tabId)
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [tabId, autoRetry])

  const backToSafety = (): void => {
    if (tab.canGoBack) void window.aqua.ui.command('nav.back')
    else void window.aqua.nav.go(NEW_TAB_URL)
  }

  return (
    <div className="page">
      <div className="error-page">
        <div className="error-body">
          <div className={cx('error-icon', copy.danger && 'danger')}>
            <Icon icon={copy.icon} size={28} stroke={1.6} />
          </div>
          <h1>{copy.title}</h1>
          <p>{copy.body(host)}</p>
          {copy.tips && (
            <>
              <p style={{ marginTop: 16 }}>Try:</p>
              <ul>
                {copy.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </>
          )}
          <div className="error-code">{error.name}</div>

          {kind === 'certificate' ? (
            <>
              <div className="error-actions">
                <button className="btn primary" onClick={backToSafety}>
                  Back to safety
                </button>
                <button className="btn ghost" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
                  {advanced ? 'Hide advanced' : 'Advanced'}
                </button>
              </div>
              {advanced && (
                <div className="error-details">
                  <p style={{ margin: '0 0 12px' }}>
                    {host} normally uses encryption to protect your information. This time, the certificate it sent
                    can’t be trusted - it may be expired, self-signed, or issued for another site.
                  </p>
                  <button className="btn danger small" onClick={() => void window.aqua.nav.proceedUnsafe(tab.id)}>
                    Proceed to {host} (unsafe)
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="error-actions">
              <button className="btn primary" onClick={reload} disabled={tab.loading} autoFocus>
                {tab.loading ? 'Retrying…' : 'Reload'}
              </button>
              <button className="btn ghost" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
                {details ? 'Hide details' : 'Details'}
              </button>
            </div>
          )}
          {details && (
            <div className="error-details">
              Aqua tried to load <strong style={{ userSelect: 'text' }}>{error.url}</strong> and the network stack
              reported <code>{error.name}</code> (code {error.code}).
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
