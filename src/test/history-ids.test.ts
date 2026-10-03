import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { uid } from '../main/lib/signal.ts'
import { HistoryService } from '../main/services/history.ts'
import { randomKey } from '../main/storage/crypto.ts'
import { VaultDatabase } from '../main/storage/database.ts'

const OPAQUE = /^h-[0-9a-f]{32}$/

function rowIds(file: string): string[] {
  const raw = new DatabaseSync(file, { readOnly: true })
  try {
    return (raw.prepare('SELECT id FROM history').all() as Array<{ id: string }>).map((r) => r.id)
  } finally {
    raw.close()
  }
}

/** Opens the profile the way the app does: services first, then the key. */
function openHistory(file: string, key: Buffer): { db: VaultDatabase; history: HistoryService } {
  const db = new VaultDatabase(file)
  const history = new HistoryService(db)
  db.unlock(key)
  return { db, history }
}

test('ids carry no timestamp', () => {
  const id = uid('h')
  assert.match(id, OPAQUE)
  assert.notEqual(uid('h'), id)
})

test('time-stamped history ids are rewritten as opaque ids, visits intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-history-'))
  const file = join(dir, 'aqua.db')
  const key = randomKey()
  try {
    const legacy = [
      {
        id: 'h-lmz8k2a1-x7q2pa',
        url: 'https://example.com/',
        title: 'Example',
        favicon: null,
        visitedAt: 1_700_000_000_000
      },
      {
        id: 'h-lmz8k9zz-4kd',
        url: 'https://example.org/a',
        title: 'A',
        favicon: null,
        visitedAt: 1_700_000_100_000,
        typed: true
      }
    ]
    const seed = new VaultDatabase(file)
    seed.unlock(key)
    seed.writeHistory(
      legacy.map((v) => ({ id: v.id, value: v })),
      []
    )
    seed.close()

    const first = openHistory(file, key)
    const ids = rowIds(file)
    assert.equal(ids.length, 2)
    for (const id of ids) assert.match(id, OPAQUE)
    const visits = first.history.query({})
    assert.deepEqual(
      visits.map((v) => [v.url, v.title, v.visitedAt]),
      [
        ['https://example.org/a', 'A', 1_700_000_100_000],
        ['https://example.com/', 'Example', 1_700_000_000_000]
      ]
    )
    assert.deepEqual(visits.map((v) => v.id).sort(), [...ids].sort())
    // Sealed under the new slot: a fresh read decrypts every row.
    assert.equal(first.db.readHistory().length, 2)
    first.history.flush()
    first.db.close()

    // Already migrated: a second unlock leaves the ids alone.
    const second = openHistory(file, key)
    assert.deepEqual(rowIds(file).sort(), [...ids].sort())
    second.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
