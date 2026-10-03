import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HistoryService } from '../main/services/history.ts'
import { SiteStorageService } from '../main/services/site-storage.ts'
import { randomKey } from '../main/storage/crypto.ts'
import { VaultDatabase } from '../main/storage/database.ts'

/** Private state, read only to check that keys are really gone. */
const secret = (o: object, field: string): unknown => (o as Record<string, unknown>)[field]

/** A database in a temporary folder; closed and deleted after `body`, whatever it throws. */
function withDatabase(body: (db: VaultDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-lock-'))
  const db = new VaultDatabase(join(dir, 'aqua.db'))
  try {
    body(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('lock seals pending writes, then zeroes the data key and derived keys', () => {
  withDatabase((db) => {
    const key = randomKey()
    const history = new HistoryService(db)
    const sites = new SiteStorageService(db)
    db.unlock(key)
    const stored = secret(db, 'key') as Buffer

    history.addVisit('https://example.com/', 'Example', null, false) // queued for the next turn
    sites.save('https://example.com', { theme: 'dark' })
    const idKey = secret(sites, 'idKey') as Buffer
    assert.ok(idKey)

    db.lock()
    assert.equal(db.isUnlocked, false)
    assert.equal(secret(db, 'key'), null)
    assert.ok(
      stored.every((b) => b === 0),
      'data key zeroed'
    )
    assert.equal(secret(sites, 'idKey'), null)
    assert.ok(
      idKey.every((b) => b === 0),
      'derived id key zeroed'
    )

    // The queued visit was written before the key went; the id key is derived again on use.
    db.unlock(key)
    assert.equal(db.readHistory().length, 1)
    assert.deepEqual(new SiteStorageService(db).restore('https://example.com'), { theme: 'dark' })
  })
})

test('changes made while locked stay in memory and are written at the next unlock', () => {
  withDatabase((db) => {
    const key = randomKey()
    const doc = db.document<{ n: number }>('counter', {
      defaults: () => ({ n: 0 }),
      sanitize: (raw) => raw as { n: number }
    })
    db.unlock(key)
    doc.set({ n: 1 })
    db.lock()
    assert.deepEqual(doc.value, { n: 1 })

    doc.set({ n: 2 }) // locked: kept in memory, nothing can be sealed
    db.unlock(key)
    assert.deepEqual(doc.value, { n: 2 }, 'not reloaded from the file')
    assert.deepEqual(db.readDocument('counter'), { n: 2 }, 'written on unlock')
  })
})
