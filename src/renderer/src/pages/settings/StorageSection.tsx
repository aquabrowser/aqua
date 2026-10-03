import { useEffect, useState } from 'react'
import { Copy, FolderOpen, HardDrive, Lock, ShieldCheck, TriangleAlert, Usb } from 'lucide-react'
import type { StorageInfo } from '@shared/types'
import { Icon } from '../../components/Icon'
import { formatBytes } from '../../lib/format'
import { Row } from './controls'

function modeText(info: StorageInfo): { title: string; body: string; icon: typeof Usb } {
  if (info.mode === 'portable') {
    return {
      title: 'Portable',
      body:
        info.portableKind === 'single-file'
          ? 'Your data lives in the AquaData folder next to Aqua-Browser-Portable.exe, so it travels with the drive.'
          : 'Your data lives in the AquaData folder next to Aqua Browser.exe, so it travels with the drive.',
      icon: Usb
    }
  }
  if (info.mode === 'custom') {
    return { title: 'Custom location', body: 'Set with AQUA_USER_DATA_DIR when Aqua was started.', icon: HardDrive }
  }
  return { title: 'Installed', body: 'Your data lives in your Windows user profile.', icon: HardDrive }
}

export function StorageSection() {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    void window.aqua.storage.info().then((i) => alive && setInfo(i))
    return () => {
      alive = false
    }
  }, [])

  if (!info) return <h2>Storage</h2>
  const mode = modeText(info)

  const copy = (): void => {
    void navigator.clipboard.writeText(info.path).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <>
      <h2>Storage</h2>
      <div className="card">
        <div className="card-title">Where your data is</div>
        <div className="card-row">
          <span className="row-icon">
            <Icon icon={mode.icon} />
          </span>
          <div className="text">
            <div className="label">{mode.title}</div>
            <div className="hint">{mode.body}</div>
          </div>
        </div>
        <div className="card-row stacked">
          <div className="storage-path" title={info.path}>
            {info.path}
          </div>
          <div className="storage-actions">
            <button className="btn" onClick={() => void window.aqua.storage.open('profile')}>
              <Icon icon={FolderOpen} size={14} />
              Open data folder
            </button>
            <button className="btn ghost" onClick={copy}>
              <Icon icon={Copy} size={14} />
              {copied ? 'Copied' : 'Copy path'}
            </button>
          </div>
        </div>
        <Row label="Encrypted vault" hint="Tabs, history, cookies, site data, bookmarks and settings.">
          <span className="storage-size">{formatBytes(info.vaultBytes)}</span>
        </Row>
        <Row label="Filter lists" hint="Updates to the ad and tracker lists. Public data, nothing about you.">
          <span className="storage-size">{formatBytes(info.filterBytes)}</span>
        </Row>
        <Row label="Chromium’s own files" hint="Graphics shader caches and similar. No pages, cookies or history.">
          <span className="storage-size">{formatBytes(info.otherBytes)}</span>
        </Row>
      </div>

      <div className="card">
        <div className="card-title">Never on disk in readable form</div>
        <ul className="storage-facts">
          <li>
            <Icon icon={Lock} size={16} />
            <span>
              Cookies, site data and history exist in readable form only in memory while Aqua runs. On disk they are
              only ever in the encrypted vault.
            </span>
          </li>
          <li>
            <Icon icon={ShieldCheck} size={16} />
            <span>
              {info.mode === 'installed'
                ? 'Nothing about your browsing is written to %APPDATA% or %TEMP% in readable form.'
                : 'Aqua writes no browsing data to %APPDATA% or %TEMP% on this computer.'}
            </span>
          </li>
          {info.programDir && (
            <li>
              <Icon icon={HardDrive} size={16} />
              <span>
                The portable launcher unpacks Aqua’s program files to a temporary folder while it runs and deletes them
                when you quit. They contain no personal data.
              </span>
            </li>
          )}
        </ul>
        {info.otherProfile && (
          <div className="card-row stacked">
            <div className="storage-notice" role="note">
              <Icon icon={TriangleAlert} size={16} />
              <div className="text">
                <div className="label">Another Aqua profile is on this computer</div>
                <div className="hint">
                  An installed copy of Aqua keeps its profile in{' '}
                  <span className="storage-path inline">{info.otherProfile}</span>. This copy doesn’t use it. It may
                  hold data from before encryption, so delete it if you no longer need it.
                </div>
              </div>
            </div>
            <div className="storage-actions">
              <button className="btn" onClick={() => void window.aqua.storage.open('other')}>
                <Icon icon={FolderOpen} size={14} />
                Show that folder
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
