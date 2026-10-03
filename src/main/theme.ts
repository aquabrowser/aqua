import { nativeTheme } from 'electron'
import type { BrowserSettings } from '../shared/types'

/**
 * Native-side colours that must match the CSS tokens in
 * `renderer/src/styles/tokens.css` (frame = tab strip background).
 */
const PALETTE = {
  light: { frame: '#e3e6ea', symbols: '#1f2328', content: '#ffffff', ui: '#f6f7f9' },
  classic: { frame: '#1b1c1f', symbols: '#e6e8eb', content: '#1f2023', ui: '#1f2023' },
  midnight: { frame: '#000000', symbols: '#e6e8eb', content: '#000000', ui: '#000000' },
  slate: { frame: '#131920', symbols: '#e1e7ef', content: '#161d26', ui: '#161d26' }
} as const

export type Palette = (typeof PALETTE)[keyof typeof PALETTE]

/**
 * `nativeTheme.themeSource` stays at "system" on purpose: it would also force
 * `prefers-color-scheme` on every website, and website appearance is a
 * separate setting (see `appearance.ts`). Aqua's own theme is applied by the
 * UI through `[data-theme]`, and natively through this palette.
 */
export function isDarkUi(settings: Pick<BrowserSettings, 'theme'>, isPrivate = false): boolean {
  return isPrivate || settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors)
}

/** Private windows are always dark, so they are never mistaken for regular ones. */
export function currentPalette(settings: Pick<BrowserSettings, 'theme' | 'darkStyle'>, isPrivate = false): Palette {
  if (!isDarkUi(settings, isPrivate)) return PALETTE.light
  return PALETTE[settings.darkStyle] ?? PALETTE.classic
}
