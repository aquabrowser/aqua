import { memo, useEffect, useState } from 'react'
import { Download, Globe, History, Settings, FileQuestion } from 'lucide-react'
import { internalPageOf } from '@shared/url'
import { AquaMark, Icon } from './Icon'

interface FaviconProps {
  src: string | null | undefined
  /** Page URL, used to pick built-in icons for internal pages. */
  url?: string
  size?: number
}

export const Favicon = memo(function Favicon({ src, url, size = 16 }: FaviconProps) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])

  const page = url ? internalPageOf(url) : null
  if (page === 'newtab') return <AquaMark size={size} monochrome className="favicon-fallback" />
  if (page === 'settings') return <Icon icon={Settings} size={size} className="favicon-fallback" />
  if (page === 'history') return <Icon icon={History} size={size} className="favicon-fallback" />
  if (page === 'downloads') return <Icon icon={Download} size={size} className="favicon-fallback" />
  if (page === 'unknown') return <Icon icon={FileQuestion} size={size} className="favicon-fallback" />

  if (!src || failed) return <Icon icon={Globe} size={size} className="favicon-fallback" />
  return (
    <img
      className="favicon"
      src={src}
      width={size}
      height={size}
      alt=""
      draggable={false}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
})
