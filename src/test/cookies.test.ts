import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isExpired, sanitizeCookies, toSetDetails, toStored, type StoredCookie } from '../main/lib/cookies.ts'

const base = {
  name: 'sid',
  value: 'abc',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax' as const
}

test('a domain cookie keeps its domain; a host-only cookie is recreated without one', () => {
  const domain = toStored({ ...base, domain: '.example.com', hostOnly: false, session: false, expirationDate: 2e9 })
  assert.ok(domain)
  assert.deepEqual(toSetDetails(domain), {
    url: 'https://example.com/',
    name: 'sid',
    value: 'abc',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: 2e9
  })

  const hostOnly = toStored({ ...base, name: '__Host-token', domain: 'app.example.com', hostOnly: true, session: true })
  assert.ok(hostOnly)
  const details = toSetDetails(hostOnly)
  assert.equal(details.domain, undefined, '__Host- cookies must stay host-only')
  assert.equal(details.url, 'https://app.example.com/')
  assert.equal(details.expirationDate, undefined, 'session cookies stay session cookies')
})

test('insecure cookies are set over http, with their path', () => {
  const c = toStored({ ...base, secure: false, domain: 'shop.test', hostOnly: true, path: '/cart', session: true })
  assert.ok(c)
  assert.equal(toSetDetails(c).url, 'http://shop.test/cart')
})

test('expiry is checked in seconds; session cookies never expire here', () => {
  const now = 1_700_000_000
  const c = (expirationDate?: number): StoredCookie => ({
    name: 'a',
    value: '',
    domain: 'x.test',
    hostOnly: true,
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: 'unspecified',
    ...(expirationDate !== undefined ? { expirationDate } : {})
  })
  assert.equal(isExpired(c(now - 1), now), true)
  assert.equal(isExpired(c(now + 60), now), false)
  assert.equal(isExpired(c(), now), false)
})

test('the stored jar is checked field by field', () => {
  const good = { ...base, domain: 'a.test', hostOnly: true, expirationDate: 5 }
  const cookies = sanitizeCookies([
    good,
    { ...good, name: '' },
    { ...good, domain: 42 },
    { ...good, sameSite: 'bogus' },
    null,
    'x'
  ])
  assert.equal(cookies.length, 2)
  assert.equal(cookies[1].sameSite, 'unspecified')
  assert.deepEqual(sanitizeCookies({ not: 'a list' }), [])
})
