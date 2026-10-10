import { extname } from 'path'

/**
 * Mark of the Web for a downloaded file: the Internet zone, so SmartScreen and
 * Office's Protected View check it before it runs. No HostUrl or ReferrerUrl:
 * the addresses would leave browsing history on disk next to the file.
 */
export const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n'

/**
 * Types Windows follows somewhere else when opened: a shortcut can point at a
 * program or a network share (which receives the user's credentials). Aqua
 * shows them in their folder instead of opening them.
 */
const OPENS_ELSEWHERE = new Set([
  '.lnk',
  '.url',
  '.website',
  '.scf',
  '.library-ms',
  '.search-ms',
  '.searchconnector-ms',
  '.settingcontent-ms',
  '.appref-ms'
])

/**
 * A file name Windows can store, without the bidirectional controls that
 * disguise an extension ("invoice‮fdp.exe" displays as "invoiceexe.pdf").
 */
export function safeFileName(filename: string): string {
  return (
    filename
      .replace(/[‎‏‪-‮⁦-⁩]/g, '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .trim() || 'download'
  )
}

export function opensElsewhere(path: string): boolean {
  return OPENS_ELSEWHERE.has(extname(path).toLowerCase())
}
