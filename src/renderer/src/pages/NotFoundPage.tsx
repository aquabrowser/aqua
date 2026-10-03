import { NotFoundPageContent } from './CrashPage'

export function NotFoundPage({ url }: { url: string }) {
  return (
    <div className="page">
      <div className="error-page">
        <NotFoundPageContent url={url} />
      </div>
    </div>
  )
}
