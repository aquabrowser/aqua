import type { CSSProperties } from 'react'
import type { NtpFontStyle } from '@shared/ntp'

/** Inline style for text in one of the New Tab page's clock fonts. */
export function fontStyle(font: NtpFontStyle): CSSProperties {
  return {
    fontFamily: font.family,
    fontWeight: font.weight,
    letterSpacing: font.tracking,
    fontStretch: font.stretch
  }
}
