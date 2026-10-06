/** The colours a profile can have: its dot in the tab strip, the lock screen and the profile list. */
export const PROFILE_COLORS = ['blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'purple', 'gray'] as const
export type ProfileColor = (typeof PROFILE_COLORS)[number]

/** Readable on light and dark backgrounds alike. */
export const PROFILE_COLOR_VALUES: Record<ProfileColor, string> = {
  blue: '#3b82f6',
  teal: '#14b8a6',
  green: '#22c55e',
  amber: '#f59e0b',
  orange: '#f97316',
  red: '#ef4444',
  pink: '#ec4899',
  purple: '#a855f7',
  gray: '#8b95a5'
}
