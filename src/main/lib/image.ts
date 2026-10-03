/** The largest picture accepted as a New Tab background (it is kept, encrypted, in the vault). */
export const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024

/**
 * The image type of `bytes` from its signature - never from a file name or a
 * server's Content-Type, which can say anything. Null for anything else
 * (SVG included: it is a document that can carry script).
 */
export function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  const at = (i: number, ...values: number[]): boolean => values.every((v, k) => bytes[i + k] === v)
  if (bytes.length < 12) return null
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}
