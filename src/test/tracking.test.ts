import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripTrackingParams } from '../shared/tracking.ts'

test('removes campaign and click identifiers, keeps everything else as-is', () => {
  assert.equal(
    stripTrackingParams('https://example.com/a?id=7&utm_source=news&utm_medium=email&q=a%20b+c'),
    'https://example.com/a?id=7&q=a%20b+c'
  )
  assert.equal(stripTrackingParams('https://shop.example/p?fbclid=IwAR0&gclid=Cj0'), 'https://shop.example/p')
  assert.equal(stripTrackingParams('https://x.example/?igshid=abc#section'), 'https://x.example/#section')
  assert.equal(stripTrackingParams('https://x.example/?mc_eid=1&keep=2&mc_eid=3'), 'https://x.example/?keep=2')
})

test('is case-insensitive and handles encoded names', () => {
  assert.equal(stripTrackingParams('https://x.example/?UTM_Source=a&b=1'), 'https://x.example/?b=1')
  assert.equal(stripTrackingParams('https://x.example/?utm%5Fsource=a&b=1'), 'https://x.example/?b=1')
})

test('never touches OAuth, session or callback parameters', () => {
  const oauth =
    'https://accounts.example/o/oauth2/auth?client_id=1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb%3Futm_source%3Dx&state=s&code=c&session=z'
  assert.equal(stripTrackingParams(oauth), null)
  assert.equal(
    stripTrackingParams('https://app.example/callback?code=abc&state=xyz&utm_campaign=spring'),
    'https://app.example/callback?code=abc&state=xyz'
  )
})

test('leaves URLs without tracking parameters and non-web URLs alone', () => {
  assert.equal(stripTrackingParams('https://example.com/?page=2'), null)
  assert.equal(stripTrackingParams('https://example.com/#?utm_source=x'), null)
  assert.equal(stripTrackingParams('mailto:a@example.com?utm_source=x'), null)
  assert.equal(stripTrackingParams('https://example.com/'), null)
})
