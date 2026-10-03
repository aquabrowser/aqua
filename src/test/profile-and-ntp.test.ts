import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { MAX_BACKGROUND_BYTES, sniffImage } from '../main/lib/image.ts'
import { resolveProfileLocation, type LocationInputs } from '../main/lib/profile-location.ts'
import { greetingFor, isNtpBackground, isNtpFont, ntpBackdrop, NTP_GRADIENTS, NTP_SOLIDS } from '../shared/ntp.ts'

const exeDir = resolve('/apps/Aqua Browser')
const inputs = (over: Partial<LocationInputs> = {}): LocationInputs => ({
  env: {},
  exeDir,
  isPackaged: true,
  isDirectory: () => false,
  isWritable: () => true,
  ...over
})

test('an installed copy keeps the default profile folder', () => {
  assert.deepEqual(resolveProfileLocation(inputs()), { mode: 'installed', portableKind: null, path: null })
})

test('the single-file portable build keeps its data next to the launcher', () => {
  const location = resolveProfileLocation(inputs({ env: { PORTABLE_EXECUTABLE_DIR: 'E:\\Tools' } }))
  assert.equal(location.mode, 'portable')
  assert.equal(location.portableKind, 'single-file')
  assert.equal(location.path, join('E:\\Tools', 'AquaData'))
})

test('the portable folder build is recognised by the AquaData folder beside the program', () => {
  const beside = join(exeDir, 'AquaData')
  const location = resolveProfileLocation(inputs({ isDirectory: (p) => p === beside }))
  assert.deepEqual(location, { mode: 'portable', portableKind: 'folder', path: beside })
  // Not in development (the Electron binary lives in node_modules), and not on a read-only drive.
  assert.equal(
    resolveProfileLocation(inputs({ isPackaged: false, isDirectory: (p) => p === beside })).mode,
    'installed'
  )
  assert.equal(
    resolveProfileLocation(inputs({ isDirectory: (p) => p === beside, isWritable: () => false })).mode,
    'installed'
  )
})

test('an explicit profile folder wins over everything', () => {
  const location = resolveProfileLocation(
    inputs({ env: { AQUA_USER_DATA_DIR: 'C:/test/profile', PORTABLE_EXECUTABLE_DIR: 'E:\\Tools' } })
  )
  assert.equal(location.mode, 'custom')
  assert.equal(location.path, resolve('C:/test/profile'))
})

test('a read-only drive falls back from the single-file build too', () => {
  const location = resolveProfileLocation(inputs({ env: { PORTABLE_EXECUTABLE_DIR: 'E:\\' }, isWritable: () => false }))
  assert.equal(location.mode, 'installed')
})

const bytes = (...values: number[]): Uint8Array => {
  const out = new Uint8Array(16)
  out.set(values)
  return out
}

test('pictures are recognised by their signature, not their name', () => {
  assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png')
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg')
  assert.equal(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'image/gif')
  assert.equal(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)), 'image/webp')
  // SVG (a document that can carry script), HTML, and anything too short are refused.
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
  assert.equal(sniffImage(new TextEncoder().encode('<!doctype html><html></html>')), null)
  assert.equal(sniffImage(bytes(0x89, 0x50).subarray(0, 4)), null)
  assert.ok(MAX_BACKGROUND_BYTES >= 4 * 1024 * 1024)
})

test('New Tab backgrounds and fonts are validated against the presets', () => {
  assert.equal(isNtpBackground('default'), true)
  assert.equal(isNtpBackground('image'), true)
  for (const b of NTP_SOLIDS) assert.equal(isNtpBackground(`solid:${b.id}`), true)
  for (const b of NTP_GRADIENTS) assert.equal(isNtpBackground(`gradient:${b.id}`), true)
  assert.equal(isNtpBackground('solid:nope'), false)
  assert.equal(isNtpBackground('url(javascript:alert(1))'), false)
  assert.equal(isNtpBackground(42), false)
  assert.equal(ntpBackdrop('gradient:aurora')?.dark, true)
  assert.equal(ntpBackdrop('solid:paper')?.dark, false)
  assert.equal(isNtpFont('serif'), true)
  assert.equal(isNtpFont('comic'), false)
})

test('the greeting follows the time of day', () => {
  assert.equal(greetingFor(7), 'Good morning')
  assert.equal(greetingFor(12), 'Good afternoon')
  assert.equal(greetingFor(19), 'Good evening')
  assert.equal(greetingFor(2), 'Good evening')
})
