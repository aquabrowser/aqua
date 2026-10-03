import { Monitor, Moon, Sun } from 'lucide-react'
import type { DarkStyle, WebsiteAppearance } from '@shared/types'
import { cx } from '../../lib/format'
import { env, useSettings } from '../../store'
import { Row, Segmented, Switch, update } from './controls'

type Preset = 'light' | DarkStyle

/** Each preset's own colours, so every preview shows that theme whatever the current one is. */
const PRESETS: ReadonlyArray<{
  id: Preset
  label: string
  hint: string
  colors: { frame: string; toolbar: string; page: string; line: string; accent: string; tab: string }
}> = [
  {
    id: 'light',
    label: 'Light',
    hint: 'Clean and bright',
    colors: {
      frame: '#e3e6ea',
      toolbar: '#ffffff',
      page: '#f6f7f9',
      line: '#d5dae0',
      accent: '#0891b2',
      tab: '#ffffff'
    }
  },
  {
    id: 'classic',
    label: 'Classic dark',
    hint: 'Soft neutral greys',
    colors: {
      frame: '#1b1c1f',
      toolbar: '#2a2b2f',
      page: '#1f2023',
      line: '#3a3b40',
      accent: '#3fb8d6',
      tab: '#2a2b2f'
    }
  },
  {
    id: 'midnight',
    label: 'Midnight',
    hint: 'Pure black, for OLED screens',
    colors: {
      frame: '#000000',
      toolbar: '#0e0e10',
      page: '#000000',
      line: '#232327',
      accent: '#3fb8d6',
      tab: '#0e0e10'
    }
  },
  {
    id: 'slate',
    label: 'Slate',
    hint: 'Cool blue-greys',
    colors: {
      frame: '#131920',
      toolbar: '#1c232d',
      page: '#161d26',
      line: '#2a3441',
      accent: '#3fb8d6',
      tab: '#1c232d'
    }
  }
]

/** A miniature Aqua window in a preset's colours. */
function Preview({ colors }: { colors: (typeof PRESETS)[number]['colors'] }) {
  return (
    <span className="theme-preview" style={{ background: colors.frame }} aria-hidden>
      <span className="theme-preview-tab" style={{ background: colors.tab }} />
      <span className="theme-preview-toolbar" style={{ background: colors.toolbar }}>
        <span className="theme-preview-field" style={{ background: colors.page }} />
      </span>
      <span className="theme-preview-page" style={{ background: colors.page }}>
        <span style={{ background: colors.accent, width: '34%' }} />
        <span style={{ background: colors.line, width: '72%' }} />
        <span style={{ background: colors.line, width: '56%' }} />
      </span>
    </span>
  )
}

export function AppearanceSection() {
  const s = useSettings()
  const matchSystem = s.theme === 'system'

  const pick = (id: Preset): void => {
    if (id === 'light') update({ theme: 'light' })
    // Following the system, a dark preset only changes which dark theme the night uses.
    else if (matchSystem) update({ darkStyle: id })
    else update({ theme: 'dark', darkStyle: id })
  }

  const inUse = (id: Preset): 'day' | 'night' | 'on' | null => {
    if (matchSystem) return id === 'light' ? 'day' : id === s.darkStyle ? 'night' : null
    if (s.theme === 'light') return id === 'light' ? 'on' : null
    return id === s.darkStyle ? 'on' : null
  }

  const followSystem = (on: boolean): void => {
    if (on) update({ theme: 'system' })
    else update({ theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' })
  }

  return (
    <>
      <h2>Appearance</h2>
      <div className="card">
        <div className="card-title">Theme</div>
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {PRESETS.map((preset) => {
            const state = inUse(preset.id)
            return (
              <button
                key={preset.id}
                className={cx('theme-card', state && 'selected')}
                role="radio"
                aria-checked={state !== null}
                onClick={() => pick(preset.id)}
              >
                <Preview colors={preset.colors} />
                <span className="theme-card-label">
                  {preset.label}
                  {(state === 'day' || state === 'night') && (
                    <span className="theme-card-tag">{state === 'day' ? 'Day' : 'Night'}</span>
                  )}
                </span>
                <span className="theme-card-hint">{preset.hint}</span>
              </button>
            )
          })}
        </div>
        <Row
          label="Match system"
          hint={
            matchSystem
              ? 'Light while your computer uses light mode, your dark theme when it uses dark mode.'
              : 'Follow your computer’s light or dark mode.'
          }
        >
          <Switch label="Match system" checked={matchSystem} onChange={followSystem} />
        </Row>
        <Row
          label="Show bookmarks bar"
          hint={`Toggle any time with ${env.platform === 'darwin' ? '⇧⌘B' : 'Ctrl+Shift+B'}.`}
        >
          <Switch
            label="Show bookmarks bar"
            checked={s.showBookmarksBar}
            onChange={(v) => update({ showBookmarksBar: v })}
          />
        </Row>
      </div>

      <div className="card">
        <div className="card-title">Websites</div>
        <Row
          label="Website appearance"
          hint="Which color scheme websites see. Sites without a dark theme stay as they are."
        >
          <Segmented<WebsiteAppearance>
            label="Website appearance"
            value={s.websiteAppearance}
            onChange={(v) => update({ websiteAppearance: v })}
            options={[
              { value: 'system', label: 'Match system', icon: Monitor },
              { value: 'dark', label: 'Force dark', icon: Moon },
              { value: 'light', label: 'Force light', icon: Sun }
            ]}
          />
        </Row>
      </div>
    </>
  )
}
