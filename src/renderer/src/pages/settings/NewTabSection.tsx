import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { EyeOff, ImagePlus, LayoutGrid, Palette, Trash2 } from 'lucide-react'
import { NTP_FONTS, NTP_GRADIENTS, NTP_SOLIDS, type NtpBackdrop } from '@shared/ntp'
import type { NtpShortcuts } from '@shared/types'
import { Icon } from '../../components/Icon'
import { cx } from '../../lib/format'
import { fontStyle } from '../../lib/ntp'
import { ntpImageStore, useSettings, useStore, wantNtpImage } from '../../store'
import { FormMessage, Row, Segmented, Switch, update } from './controls'

function Swatch({
  label,
  background,
  selected,
  onPick,
  children
}: {
  label: string
  background?: string
  selected: boolean
  onPick: () => void
  children?: ReactNode
}) {
  return (
    <button
      className={cx('ntp-swatch', selected && 'selected')}
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      onClick={onPick}
      style={background ? { background } : undefined}
    >
      {children}
    </button>
  )
}

export function NewTabSection() {
  const s = useSettings()
  const image = useStore(ntpImageStore)
  const [time, setTime] = useState(() =>
    new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  )
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)

  useEffect(wantNtpImage, [])

  useEffect(() => {
    const timer = window.setInterval(
      () => setTime(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
      30_000
    )
    return () => window.clearInterval(timer)
  }, [])

  const backdrops: ReadonlyArray<{ group: 'solid' | 'gradient'; caption: string; items: readonly NtpBackdrop[] }> = [
    { group: 'solid', caption: 'Colours', items: NTP_SOLIDS },
    { group: 'gradient', caption: 'Gradients', items: NTP_GRADIENTS }
  ]

  const run = async (task: () => Promise<{ ok: true } | { ok: false; error: string } | null>): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await task()
      if (result && !result.ok) setMessage({ tone: 'error', text: result.error })
      else if (result) setMessage({ tone: 'success', text: 'Picture saved in your vault' })
    } finally {
      setBusy(false)
    }
  }

  const fromUrl = (event: FormEvent): void => {
    event.preventDefault()
    if (!url.trim()) return
    void run(async () => {
      const result = await window.aqua.ntp.imageFromUrl(url.trim())
      if (result.ok) setUrl('')
      return result
    })
  }

  return (
    <>
      <h2>New Tab page</h2>
      <div className="card">
        <div className="card-title">Clock</div>
        <Row label="Clock and date">
          <Switch label="Show clock and date" checked={s.ntpShowClock} onChange={(v) => update({ ntpShowClock: v })} />
        </Row>
        <Row label="Greeting" hint="“Good morning”, “Good afternoon” or “Good evening” above the clock.">
          <Switch label="Show greeting" checked={s.ntpGreeting} onChange={(v) => update({ ntpGreeting: v })} />
        </Row>
        <div className="card-row stacked">
          <div className="text">
            <div className="label">Font</div>
            <div className="hint">Fonts already on your computer, so nothing is downloaded.</div>
          </div>
          <div className="font-grid" role="radiogroup" aria-label="Clock font">
            {NTP_FONTS.map((font) => (
              <button
                key={font.id}
                className={cx('font-card', s.ntpFont === font.id && 'selected')}
                role="radio"
                aria-checked={s.ntpFont === font.id}
                disabled={!s.ntpShowClock && !s.ntpGreeting}
                onClick={() => update({ ntpFont: font.id })}
              >
                <span className="font-card-sample" style={fontStyle(font)}>
                  {time}
                </span>
                <span className="font-card-label">{font.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Shortcuts</div>
        <Row
          label="Shortcuts"
          hint={
            s.ntpShortcuts === 'hidden' ? 'Hidden. Your shortcuts are kept for when you want them back.' : undefined
          }
        >
          <Segmented<NtpShortcuts>
            label="Shortcuts"
            value={s.ntpShortcuts}
            onChange={(v) => update({ ntpShortcuts: v })}
            options={[
              { value: 'grid', label: 'Icon grid', icon: LayoutGrid },
              { value: 'hidden', label: 'Hidden', icon: EyeOff }
            ]}
          />
        </Row>
        <Row
          label="Suggest sites"
          hint={
            s.ntpAutoShortcuts
              ? 'Tiles you haven’t added are filled with the sites you visit most.'
              : 'Only the shortcuts you add are shown.'
          }
        >
          <Switch
            label="Suggest sites"
            checked={s.ntpAutoShortcuts}
            disabled={s.ntpShortcuts === 'hidden'}
            onChange={(v) => update({ ntpAutoShortcuts: v })}
          />
        </Row>
      </div>

      <div className="card">
        <div className="card-title">Background</div>
        <div className="card-row stacked">
          <div className="ntp-swatch-groups" role="radiogroup" aria-label="Background">
            {backdrops.map(({ group, caption, items }) => (
              <div key={group} className="ntp-swatch-group">
                <span className="ntp-swatch-caption">{caption}</span>
                <div className="ntp-swatches">
                  {group === 'solid' && (
                    <Swatch
                      label="Theme colour"
                      selected={s.ntpBackground === 'default'}
                      onPick={() => update({ ntpBackground: 'default' })}
                    >
                      <Icon icon={Palette} size={16} />
                    </Swatch>
                  )}
                  {items.map((b) => (
                    <Swatch
                      key={b.id}
                      label={`${b.label} (${group === 'solid' ? 'colour' : 'gradient'})`}
                      background={b.css}
                      selected={s.ntpBackground === `${group}:${b.id}`}
                      onPick={() => update({ ntpBackground: `${group}:${b.id}` })}
                    />
                  ))}
                </div>
              </div>
            ))}
            {image && (
              <div className="ntp-swatch-group">
                <span className="ntp-swatch-caption">Picture</span>
                <div className="ntp-swatches">
                  <Swatch
                    label="Your picture"
                    background={`center / cover no-repeat url("${image}")`}
                    selected={s.ntpBackground === 'image'}
                    onPick={() => update({ ntpBackground: 'image' })}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="card-row stacked">
          <div className="text">
            <div className="label">Your own picture</div>
            <div className="hint">
              Stored encrypted in your vault. A picture from the web is downloaded once, so the New Tab page never
              contacts that site.
            </div>
          </div>
          <div className="ntp-image-actions">
            <button className="btn" disabled={busy} onClick={() => void run(() => window.aqua.ntp.imageFromFile())}>
              <Icon icon={ImagePlus} size={14} />
              Choose a picture…
            </button>
            <form className="inline-form" onSubmit={fromUrl}>
              <input
                className="text-input"
                type="url"
                placeholder="https://example.com/picture.jpg"
                aria-label="Picture web address"
                value={url}
                disabled={busy}
                onChange={(e) => setUrl(e.target.value)}
              />
              <button className="btn" type="submit" disabled={busy || !url.trim()}>
                Use
              </button>
            </form>
            {image && (
              <button className="btn ghost" disabled={busy} onClick={() => void window.aqua.ntp.clearImage()}>
                <Icon icon={Trash2} size={14} />
                Remove picture
              </button>
            )}
          </div>
          {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
        </div>
      </div>
    </>
  )
}
