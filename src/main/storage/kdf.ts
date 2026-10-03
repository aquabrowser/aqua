import { randomBytes } from 'crypto'
import { join } from 'path'
import { Worker } from 'worker_threads'

export interface KdfParams {
  algorithm: 'argon2id'
  version: 19
  memoryKiB: number
  iterations: number
  parallelism: number
  /** base64 */
  salt: string
}

/** 128 MiB, 4 passes, 4 lanes: ≈0.5 s on a current desktop CPU, far above OWASP's minimum. */
export function defaultKdfParams(): KdfParams {
  return {
    algorithm: 'argon2id',
    version: 19,
    memoryKiB: 128 * 1024,
    iterations: 4,
    parallelism: 4,
    salt: randomBytes(16).toString('base64')
  }
}

/**
 * Derives a 256-bit key from the master password in a worker thread. The
 * password is NFC-normalised so the same passphrase typed on different
 * keyboards / platforms derives the same key.
 */
export function deriveKey(password: string, params: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'argon2.js'))
    // Same bytes as Buffer.from(…, 'utf-8'), but in an ArrayBuffer of its own (a short Buffer is a
    // slice of a shared pool), so it can be transferred: the worker holds the only copy and zeroes it.
    const bytes = new TextEncoder().encode(password.normalize('NFC'))
    worker.once('message', (message: { key?: Uint8Array; error?: string }) => {
      void worker.terminate()
      // A view of the transferred buffer rather than a copy, so the caller's fill(0) clears the only one.
      if (message.key) resolve(Buffer.from(message.key.buffer, message.key.byteOffset, message.key.byteLength))
      else reject(new Error(message.error ?? 'key derivation failed'))
    })
    worker.once('error', (err) => {
      void worker.terminate()
      reject(err)
    })
    try {
      worker.postMessage(
        {
          password: bytes,
          salt: new Uint8Array(Buffer.from(params.salt, 'base64')),
          memoryKiB: params.memoryKiB,
          iterations: params.iterations,
          parallelism: params.parallelism
        },
        [bytes.buffer]
      )
    } catch (err) {
      // Not transferred, so this side still holds the password bytes.
      bytes.fill(0)
      void worker.terminate()
      reject(err)
    }
  })
}
