import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTOMATIC_BURST, DISMISS_QUIET_MS, DownloadGate, MAX_HELD } from '../main/browser/download-gate.ts'

test('the first download of a page is allowed; the next automatic one is asked about', () => {
  const gate = new DownloadGate()
  assert.equal(gate.decide(1000, 0), 'allow')
  assert.equal(gate.decide(1100, 0), 'ask')
})

test('each click or keypress allows one more download, never more', () => {
  const gate = new DownloadGate()
  assert.equal(gate.decide(1000, 900), 'allow')
  assert.equal(gate.decide(2000, 1900), 'allow', 'a new click')
  assert.equal(gate.decide(2001, 1900), 'ask', 'the same click again')
})

test('a flood waits for one answer, and only a bounded number of downloads can wait', () => {
  const gate = new DownloadGate()
  gate.decide(0, 0)
  const verdicts = Array.from({ length: 50 }, (_, i) => gate.decide(10 + i, 0))
  assert.equal(verdicts.filter((v) => v === 'ask').length, MAX_HELD)
  assert.equal(verdicts.filter((v) => v === 'deny').length, 50 - MAX_HELD)
})

test('"Allow" lets the page download freely, up to a burst limit that brings the question back', () => {
  const gate = new DownloadGate()
  gate.decide(0, 0)
  gate.decide(1, 0)
  gate.answer('allow', 2)
  for (let i = 0; i < AUTOMATIC_BURST; i++) assert.equal(gate.decide(10 + i, 0), 'allow')
  assert.equal(gate.decide(100, 0), 'ask', 'a page that never stops is asked again')
  assert.equal(gate.status, 'prompt')
})

test('the burst limit is per minute', () => {
  const gate = new DownloadGate()
  gate.decide(0, 0)
  gate.answer('allow', 0)
  for (let i = 0; i < AUTOMATIC_BURST; i++) gate.decide(i, 0)
  assert.equal(gate.decide(61_000, 0), 'allow')
})

test('"Block" refuses the rest of the page’s downloads - even after a click', () => {
  const gate = new DownloadGate()
  gate.decide(0, 0)
  gate.decide(1, 0)
  gate.answer('block', 2)
  assert.equal(gate.decide(10, 0), 'deny')
  assert.equal(gate.decide(20, 15), 'deny')
  gate.reset()
  assert.equal(gate.decide(30, 0), 'allow', 'a new page starts over')
})

test('dismissing the question quiets automatic downloads for a while', () => {
  const gate = new DownloadGate()
  gate.decide(0, 0)
  gate.decide(1, 0)
  gate.answer('dismiss', 1000)
  assert.equal(gate.decide(2000, 0), 'deny')
  assert.equal(gate.decide(1000 + DISMISS_QUIET_MS + 1, 0), 'ask')
  assert.equal(gate.decide(1000 + DISMISS_QUIET_MS + 2, 1000 + DISMISS_QUIET_MS + 2), 'allow', 'a click still works')
})
