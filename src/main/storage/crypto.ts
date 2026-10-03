import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

export const KEY_BYTES = 32
const FORMAT = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** Thrown when a ciphertext fails authentication (wrong key or tampered data). */
export class DecryptionError extends Error {}

/**
 * AES-256-GCM sealing. Layout: [format:1][nonce:12][tag:16][ciphertext].
 *
 * `aad` binds a ciphertext to where it is stored (table + key), so rows cannot
 * be swapped or replayed into another slot without failing authentication.
 */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf-8'))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([Buffer.from([FORMAT]), nonce, cipher.getAuthTag(), body])
}

export function unseal(key: Buffer, blob: Uint8Array, aad: string): Buffer {
  const data = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  if (data.length < 1 + NONCE_BYTES + TAG_BYTES || data[0] !== FORMAT) throw new DecryptionError('unsupported format')
  const nonce = data.subarray(1, 1 + NONCE_BYTES)
  const tag = data.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES)
  const body = data.subarray(1 + NONCE_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(aad, 'utf-8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new DecryptionError('authentication failed')
  }
}

export function sealJson(key: Buffer, value: unknown, aad: string): Buffer {
  return seal(key, Buffer.from(JSON.stringify(value), 'utf-8'), aad)
}

export function unsealJson<T>(key: Buffer, blob: Uint8Array, aad: string): T {
  const plain = unseal(key, blob, aad)
  try {
    return JSON.parse(plain.toString('utf-8')) as T
  } finally {
    plain.fill(0)
  }
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES)
}
