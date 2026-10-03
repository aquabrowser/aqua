import assert from 'node:assert/strict'
import { test } from 'node:test'
import { persistsStorage, sanitizeStorageItems, siteOf, webOriginOf } from '../main/lib/site-storage.ts'

test('only http(s) origins are web origins', () => {
  assert.equal(webOriginOf('https://mail.example.com/inbox?x=1'), 'https://mail.example.com')
  assert.equal(webOriginOf('http://localhost:8080/'), 'http://localhost:8080')
  assert.equal(webOriginOf('null'), null)
  assert.equal(webOriginOf('about:blank'), null)
  assert.equal(webOriginOf('data:text/html,hi'), null)
  assert.equal(webOriginOf('file:///C:/x.html'), null)
})

test('sites follow the public suffix list', () => {
  assert.equal(siteOf('https://a.b.example.co.uk'), 'https://example.co.uk')
  assert.equal(siteOf('https://user.github.io'), 'https://user.github.io')
  assert.equal(siteOf('http://127.0.0.1:3000'), 'http://127.0.0.1')
  assert.notEqual(siteOf('http://example.com'), siteOf('https://example.com'))
})

test('first-party frames keep their storage; embedded third parties do not', () => {
  assert.equal(persistsStorage('https://example.com', 'https://example.com'), true)
  assert.equal(persistsStorage('https://accounts.example.com', 'https://www.example.com'), true)
  assert.equal(persistsStorage('https://ads.tracker.net', 'https://www.example.com'), false)
  assert.equal(persistsStorage('http://example.com', 'https://example.com'), false)
})

test('storage snapshots are validated', () => {
  assert.deepEqual({ ...sanitizeStorageItems({ a: '1', b: '' }) }, { a: '1', b: '' })
  assert.equal(sanitizeStorageItems({ a: 1 }), null)
  assert.equal(sanitizeStorageItems(['a']), null)
  assert.equal(sanitizeStorageItems(null), null)
  assert.equal(sanitizeStorageItems({ big: 'x'.repeat(6 * 1024 * 1024) }), null)
  // Keys like __proto__ are plain data, never prototype changes.
  const items = sanitizeStorageItems(JSON.parse('{"__proto__": "x", "k": "v"}'))
  assert.ok(items)
  assert.equal(items['__proto__'], 'x')
  assert.equal(Object.getPrototypeOf(items), null)
})
