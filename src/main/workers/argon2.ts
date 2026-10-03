/**
 * Argon2id key derivation, isolated in a worker thread so the ~0.5 s of
 * memory-hard hashing never blocks the main process (and with it every
 * window's input handling).
 */
import { parentPort } from 'worker_threads'
import { argon2id } from 'hash-wasm'

interface Request {
  password: Uint8Array
  salt: Uint8Array
  memoryKiB: number
  iterations: number
  parallelism: number
}

parentPort?.once('message', async (request: Request) => {
  try {
    const key = await argon2id({
      password: request.password,
      salt: request.salt,
      memorySize: request.memoryKiB,
      iterations: request.iterations,
      parallelism: request.parallelism,
      hashLength: 32,
      outputType: 'binary'
    })
    parentPort?.postMessage({ key }, [key.buffer as ArrayBuffer])
  } catch (err) {
    parentPort?.postMessage({ error: err instanceof Error ? err.message : String(err) })
  } finally {
    request.password.fill(0)
  }
})
