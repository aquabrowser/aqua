/**
 * Compiles filter lists into a serialized engine. Parsing the default lists
 * takes about a second of CPU, so it runs here rather than in the main
 * process, whose event loop drives every window.
 */
import { readFileSync } from 'fs'
import { parentPort } from 'worker_threads'
import { FiltersEngine } from '@ghostery/adblocker'
import { ENGINE_CONFIG } from '../blocker/engine'

export interface BuildJob {
  /** Filter list files, concatenated in this order. */
  lists: string[]
  /** uBlock Origin's scriptlet and redirect resources (JSON). */
  resources: string | null
}

export type BuildResult =
  { ok: true; engine: Uint8Array; networkFilters: number; cosmeticFilters: number } | { ok: false; error: string }

parentPort?.once('message', (job: BuildJob) => {
  let result: BuildResult
  const transfer: ArrayBuffer[] = []
  try {
    const text = job.lists.map((file) => readFileSync(file, 'utf-8')).join('\n')
    const engine = FiltersEngine.parse(text, ENGINE_CONFIG)
    if (job.resources) engine.updateResources(readFileSync(job.resources, 'utf-8'), 'aqua')
    const { networkFilters, cosmeticFilters } = engine.getFilters()
    const bytes = engine.serialize()
    transfer.push(bytes.buffer as ArrayBuffer)
    result = { ok: true, engine: bytes, networkFilters: networkFilters.length, cosmeticFilters: cosmeticFilters.length }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  parentPort?.postMessage(result, transfer)
})
