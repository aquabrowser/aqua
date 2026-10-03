import { useEffect, useState, type RefObject } from 'react'
import {
  Bell,
  Camera,
  ChevronRight,
  Clipboard,
  FileText,
  Info,
  Lock,
  MapPin,
  Mic,
  Music,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import type { PermissionKind, SiteInfo, TabState } from '@shared/types'
import { AquaMark, Icon } from '../components/Icon'
import { Popup } from '../components/Popup'
import { formatDate } from '../lib/format'

const PERMISSION_LABELS: Record<PermissionKind, { label: string; icon: LucideIcon }> = {
  camera: { label: 'Camera', icon: Camera },
  microphone: { label: 'Microphone', icon: Mic },
  geolocation: { label: 'Location', icon: MapPin },
  notifications: { label: 'Notifications', icon: Bell },
  midi: { label: 'MIDI devices', icon: Music },
  'clipboard-read': { label: 'Clipboard', icon: Clipboard }
}

function formatFingerprint(fp: string): string {
  // Electron reports "sha256/<base64>"; show it as colon-separated hex like other browsers.
  const match = /^sha256\/(.+)$/.exec(fp)
  if (!match) return fp
  try {
    const bytes = atob(match[1])
    return [...bytes].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join(':')
  } catch {
    return fp
  }
}

export function SiteInfoPopup({
  anchorRef,
  tab,
  onClose
}: {
  anchorRef: RefObject<HTMLElement | null>
  tab: TabState
  onClose: () => void
}) {
  const [info, setInfo] = useState<SiteInfo | null>(null)
  const [showCert, setShowCert] = useState(false)

  useEffect(() => {
    let alive = true
    void window.aqua.site.info(tab.id).then((i) => alive && setInfo(i))
    return () => {
      alive = false
    }
  }, [tab.id, tab.url, tab.security])

  // Navigating away invalidates what the popup describes.
  const [openedFor] = useState(tab.url)
  useEffect(() => {
    if (tab.url !== openedFor) onClose()
  }, [tab.url, openedFor, onClose])

  if (!info) return null

  const status = describe(info)
  const cert = info.certificate

  return (
    <Popup anchorRef={anchorRef} align="start" width={340} onDismiss={onClose} label="Site information">
      <div className="popup-header">
        <div className="popup-title">{info.host || info.url}</div>
      </div>
      <div className="site-status">
        <div className={`site-status-icon ${status.tone}`}>
          {status.icon === 'aqua' ? <AquaMark size={18} /> : <Icon icon={status.icon} size={18} />}
        </div>
        <div>
          <div className="site-status-title">{status.title}</div>
          <div className="site-status-body">{status.body}</div>
        </div>
      </div>

      {cert && (
        <>
          <div className="popup-divider" />
          <button className="disclosure" aria-expanded={showCert} onClick={() => setShowCert((v) => !v)}>
            <Icon icon={FileText} />
            <span>Certificate {info.security === 'secure' ? 'is valid' : 'details'}</span>
            <Icon icon={ChevronRight} />
          </button>
          {showCert && (
            <dl className="kv">
              <dt>Issued to</dt>
              <dd>
                {cert.subject}
                {cert.subjectOrg && <div style={{ color: 'var(--text-2)' }}>{cert.subjectOrg}</div>}
              </dd>
              <dt>Issued by</dt>
              <dd>
                {cert.issuer}
                {cert.issuerOrg && <div style={{ color: 'var(--text-2)' }}>{cert.issuerOrg}</div>}
              </dd>
              <dt>Valid from</dt>
              <dd>{formatDate(cert.validFrom)}</dd>
              <dt>Expires</dt>
              <dd>{formatDate(cert.validTo)}</dd>
              <dt>SHA-256</dt>
              <dd className="mono">{formatFingerprint(cert.fingerprint)}</dd>
            </dl>
          )}
        </>
      )}

      {info.permissions.length > 0 && (
        <>
          <div className="popup-divider" />
          <div className="popup-section" style={{ paddingBottom: 0, color: 'var(--text-2)' }}>
            Permissions
          </div>
          {info.permissions.map((p) => {
            const meta = PERMISSION_LABELS[p.permission]
            return (
              <div key={p.permission} className="permission-row">
                <Icon icon={meta.icon} />
                <span className="menu-label">{meta.label}</span>
                <span className="permission-state">{p.decision === 'allow' ? 'Allowed' : 'Blocked'}</span>
                <button
                  className="btn small ghost"
                  onClick={() =>
                    void window.aqua.site
                      .resetPermission(p.origin, p.permission)
                      .then(() => window.aqua.site.info(tab.id))
                      .then(setInfo)
                  }
                >
                  Reset
                </button>
              </div>
            )
          })}
        </>
      )}

      <div className="popup-footer">
        <button
          className="link-button"
          onClick={() => {
            onClose()
            void window.aqua.nav.go('aqua://settings/privacy', { disposition: 'new-tab' })
          }}
        >
          Site settings
        </button>
      </div>
    </Popup>
  )
}

function describe(info: SiteInfo): { icon: LucideIcon | 'aqua'; tone: string; title: string; body: string } {
  switch (info.security) {
    case 'secure':
      return {
        icon: Lock,
        tone: 'secure',
        title: 'Connection is secure',
        body: 'Information you send to this site, like passwords or card numbers, is encrypted in transit.'
      }
    case 'insecure':
      return {
        icon: TriangleAlert,
        tone: 'warning',
        title: 'Connection is not secure',
        body: 'Don’t enter sensitive information on this site. Others on the network could see or change it.'
      }
    case 'cert-error':
      return {
        icon: TriangleAlert,
        tone: 'danger',
        title: 'Certificate is not valid',
        body: 'You chose to continue despite a certificate error. The connection may be intercepted.'
      }
    case 'internal':
      return { icon: 'aqua', tone: '', title: 'Aqua page', body: 'You’re viewing a secure page built into Aqua.' }
    case 'file':
      return {
        icon: FileText,
        tone: '',
        title: 'Local file',
        body: 'This page is stored on your computer or a shared drive.'
      }
    default:
      return {
        icon: Info,
        tone: '',
        title: 'Site information',
        body: 'This page doesn’t come from a website on the internet.'
      }
  }
}
