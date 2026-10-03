import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appendErrorLog, ERROR_LOG_MAX_BYTES, formatErrorEntry, redactForLog } from '../main/lib/error-log.ts'

test('addresses and the home folder never reach the log; app paths and node ids stay', () => {
  const home = 'C:\\Users\\alice'
  const error = new Error(
    'ERR_ABORTED (-3) loading https://mail.example.com/inbox?id=42 from file:///D:/notes/plan.html'
  )
  error.stack =
    `${error.name}: ${error.message}\n` +
    `    at load (C:\\Users\\alice\\AppData\\Local\\Programs\\Aqua\\resources\\app.asar\\out\\main\\index.js:12:5)\n` +
    `    at openGuestWindow (node:electron/js2c/browser_init:1:115327)`
  const entry = redactForLog(formatErrorEntry('uncaughtException', error, new Date(0), 'Aqua 1.0.0'), home)
  assert.doesNotMatch(entry, /mail\.example\.com|plan\.html|alice/)
  assert.match(entry, /loading <url> from <url>/)
  assert.match(entry, /~\\AppData\\Local\\Programs\\Aqua\\resources\\app\.asar\\out\\main\\index\.js:12:5/)
  assert.match(entry, /node:electron\/js2c\/browser_init/)
  assert.match(entry, /^\[1970-01-01T00:00:00\.000Z\] uncaughtException \(Aqua 1\.0\.0\)/)
})

test('non-Error rejections are logged by value', () => {
  assert.match(formatErrorEntry('unhandledRejection', 'boom', new Date(0), 'v'), /Non-error value: boom/)
})

test('the log rolls over at its size limit, keeping two files at most', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-errlog-'))
  try {
    const big = 'x'.repeat(ERROR_LOG_MAX_BYTES - 10)
    appendErrorLog(dir, big)
    appendErrorLog(dir, 'second entry that does not fit\n')
    appendErrorLog(dir, 'third\n')
    assert.deepEqual(readdirSync(join(dir, 'logs')).sort(), ['main.log', 'main.old.log'])
    assert.equal(readFileSync(join(dir, 'logs', 'main.old.log'), 'utf8'), big)
    assert.equal(readFileSync(join(dir, 'logs', 'main.log'), 'utf8'), 'second entry that does not fit\nthird\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a log that cannot be written is skipped, never thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-errlog-'))
  try {
    writeFileSync(join(dir, 'logs'), 'a file where the folder should be')
    assert.equal(appendErrorLog(dir, 'entry'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
