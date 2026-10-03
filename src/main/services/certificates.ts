import { app, type Certificate, type Session } from 'electron'
import type { CertificateInfo } from '../../shared/types'

const MAX_CACHED = 500

function toInfo(cert: Certificate): CertificateInfo {
  return {
    subject: cert.subject?.commonName || cert.subjectName,
    subjectOrg: cert.subject?.organizations?.join(', ') ?? '',
    issuer: cert.issuer?.commonName || cert.issuerName,
    issuerOrg: cert.issuer?.organizations?.join(', ') ?? '',
    validFrom: cert.validStart * 1000,
    validTo: cert.validExpiry * 1000,
    fingerprint: cert.fingerprint,
    serialNumber: cert.serialNumber
  }
}

/**
 * Observes TLS verification so the site-info popup can show the certificate
 * actually presented for a host, and manages user-approved certificate
 * exceptions ("Proceed anyway"), pinned to the exact certificate fingerprint.
 *
 * Verification itself stays with Chromium: the verify proc always answers -3
 * ("use Chromium's result"), it only records what it saw.
 */
export class CertificateService {
  private readonly byHost = new Map<string, { info: CertificateInfo; ok: boolean }>()
  /** host → fingerprint the user explicitly accepted (session-scoped, never persisted). */
  private readonly exceptions = new Map<string, string>()
  /** host → last certificate that failed verification, so "proceed" can pin it. */
  private readonly lastFailure = new Map<string, string>()

  attach(session: Session): void {
    session.setCertificateVerifyProc((request, callback) => {
      this.remember(request.hostname, toInfo(request.certificate), request.errorCode === 0)
      callback(-3)
    })
  }

  installAppHandler(): void {
    app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
      const host = safeHost(url)
      if (host && this.exceptions.get(host) === certificate.fingerprint) {
        event.preventDefault()
        callback(true)
        return
      }
      if (host) this.lastFailure.set(host, certificate.fingerprint)
      callback(false)
    })
  }

  get(host: string): { info: CertificateInfo; ok: boolean } | null {
    return this.byHost.get(host) ?? null
  }

  hasException(host: string): boolean {
    return this.exceptions.has(host)
  }

  /** Accepts the certificate that most recently failed for `host`. */
  allowException(host: string): boolean {
    const fingerprint = this.lastFailure.get(host)
    if (!fingerprint) return false
    this.exceptions.set(host, fingerprint)
    return true
  }

  private remember(host: string, info: CertificateInfo, ok: boolean): void {
    this.byHost.delete(host)
    this.byHost.set(host, { info, ok })
    if (this.byHost.size > MAX_CACHED) {
      const oldest = this.byHost.keys().next().value
      if (oldest !== undefined) this.byHost.delete(oldest)
    }
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}
