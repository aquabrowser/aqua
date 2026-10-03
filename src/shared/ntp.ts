/**
 * New Tab page looks: clock fonts and backgrounds. Shared by the settings
 * validator (main) and the page and settings UI (renderer).
 *
 * Fonts are ones Windows and macOS already have: nothing is downloaded.
 */

export type NtpFont = 'default' | 'bold' | 'serif' | 'mono' | 'condensed'

export interface NtpFontStyle {
  id: NtpFont
  label: string
  family: string
  weight: number
  /** Letter spacing of the 76px clock. */
  tracking: string
  /** `font-stretch` where the family has widths (Bahnschrift does). */
  stretch?: string
}

export const NTP_FONTS: readonly NtpFontStyle[] = [
  { id: 'default', label: 'Thin', family: 'var(--font-display)', weight: 200, tracking: '-2px' },
  { id: 'bold', label: 'Bold', family: 'var(--font-display)', weight: 650, tracking: '-3px' },
  {
    id: 'serif',
    label: 'Serif',
    family: "'Iowan Old Style', 'Palatino Linotype', Georgia, Cambria, serif",
    weight: 400,
    tracking: '-1.5px'
  },
  { id: 'mono', label: 'Mono', family: 'var(--font-mono)', weight: 300, tracking: '-3px' },
  {
    id: 'condensed',
    label: 'Condensed',
    family: "Bahnschrift, 'DIN Alternate', 'Arial Narrow', sans-serif",
    weight: 300,
    tracking: '-1px',
    stretch: 'condensed'
  }
]

export interface NtpBackdrop {
  id: string
  label: string
  /** CSS `background`. */
  css: string
  /** Dark backdrops show the page's text and tiles in their dark colours, whatever the theme. */
  dark: boolean
}

/** Minimal flat tones. */
export const NTP_SOLIDS: readonly NtpBackdrop[] = [
  { id: 'graphite', label: 'Graphite', css: '#1b1c20', dark: true },
  { id: 'slate', label: 'Slate', css: '#18202b', dark: true },
  { id: 'ink', label: 'Ink', css: '#0b0e17', dark: true },
  { id: 'moss', label: 'Moss', css: '#151e19', dark: true },
  { id: 'plum', label: 'Plum', css: '#211a25', dark: true },
  { id: 'paper', label: 'Paper', css: '#f2f0eb', dark: false }
]

/** Subtle dark gradients. */
export const NTP_GRADIENTS: readonly NtpBackdrop[] = [
  {
    id: 'aurora',
    label: 'Aurora',
    css: 'radial-gradient(80% 60% at 18% 8%, rgba(56, 178, 160, 0.3), transparent 62%), radial-gradient(70% 60% at 86% 18%, rgba(96, 108, 220, 0.26), transparent 62%), #0b0f16',
    dark: true
  },
  {
    id: 'dusk',
    label: 'Dusk',
    css: 'linear-gradient(160deg, #1a1e2d 0%, #281d31 55%, #121217 100%)',
    dark: true
  },
  {
    id: 'deep-sea',
    label: 'Deep sea',
    css: 'radial-gradient(120% 90% at 50% 0%, #0e3747 0%, #0a1922 46%, #06080c 100%)',
    dark: true
  },
  {
    id: 'ember',
    label: 'Ember',
    css: 'radial-gradient(100% 80% at 50% 100%, #3a1c13 0%, #1a1110 52%, #0c0a0a 100%)',
    dark: true
  }
]

/**
 * `default` (the theme's page colour), `solid:<id>`, `gradient:<id>`, or
 * `image` (the picture kept encrypted in the vault).
 */
export type NtpBackground = string

export function ntpBackdrop(value: NtpBackground): NtpBackdrop | null {
  const [kind, id] = value.split(':', 2)
  const list = kind === 'solid' ? NTP_SOLIDS : kind === 'gradient' ? NTP_GRADIENTS : null
  return list?.find((b) => b.id === id) ?? null
}

export function isNtpBackground(value: unknown): value is NtpBackground {
  return typeof value === 'string' && (value === 'default' || value === 'image' || ntpBackdrop(value) !== null)
}

export function isNtpFont(value: unknown): value is NtpFont {
  return typeof value === 'string' && NTP_FONTS.some((f) => f.id === value)
}

/** "Good morning" … by the hour. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  return 'Good evening'
}
