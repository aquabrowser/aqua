import type { ReactNode } from 'react'
import { Check, CircleAlert, type LucideIcon } from 'lucide-react'
import type { BrowserSettings } from '@shared/types'
import { Icon } from '../../components/Icon'

/** Building blocks shared by the Settings sections. */

const numberFormat = new Intl.NumberFormat()

export const update = (patch: Partial<BrowserSettings>): void => void window.aqua.settings.update(patch)

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${numberFormat.format(count)} ${count === 1 ? one : many}`
}

// ─── Controls ────────────────────────────────────────────────────────────────

export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card-row">
      <div className="text">
        <div className="label">{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: Array<{ value: T; label: string; icon?: LucideIcon }>
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
          {o.icon && <Icon icon={o.icon} size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function RadioList<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: Array<{ value: T; label: string; hint: string }>
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="radio-list" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          className="radio-row"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
        >
          <span className="radio-dot" aria-hidden />
          <span className="text">
            <span className="label">{o.label}</span>
            <span className="hint">{o.hint}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export function FormMessage({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }) {
  return (
    <div className={`form-message ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon icon={tone === 'error' ? CircleAlert : Check} size={14} />
      {children}
    </div>
  )
}
