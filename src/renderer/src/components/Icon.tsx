import { memo, type CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
import logo from '@brand/logo.svg'
import logoSmall from '@brand/logo-small.svg'

interface IconProps {
  icon: LucideIcon
  size?: number
  /** Stroke width in CSS pixels, independent of `size` (keeps 1:1 device-pixel lines). */
  stroke?: number
  className?: string
}

export const Icon = memo(function Icon({ icon: Glyph, size = 16, stroke = 1.6, className }: IconProps) {
  return (
    <Glyph size={size} strokeWidth={stroke} absoluteStrokeWidth className={className} aria-hidden focusable={false} />
  )
})

/**
 * The Aqua logo (resources/brand): the New Tab page's tab icon, the address bar chip of internal
 * pages, the site information popup and About. Small sizes use the small-size variant.
 */
export function AquaMark({
  size = 16,
  className,
  monochrome = false
}: {
  size?: number
  className?: string
  /** One colour, `currentColor`: the logo's shape used as a mask, so it matches the icons around it. */
  monochrome?: boolean
}) {
  const src = size <= 24 ? logoSmall : logo
  if (monochrome) {
    return (
      <span
        className={className ? `aqua-mark mono ${className}` : 'aqua-mark mono'}
        style={{ width: size, height: size, '--mark': `url("${src}")` } as CSSProperties}
        aria-hidden
      />
    )
  }
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
      className={className ? `aqua-mark ${className}` : 'aqua-mark'}
    />
  )
}
