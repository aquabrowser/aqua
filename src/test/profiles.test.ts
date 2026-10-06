import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  cleanProfileName,
  DEFAULT_ENTRY,
  MAX_PROFILES,
  profileIdFrom,
  roleArgs,
  roleDir,
  roleEntry,
  roleFromArgs,
  sanitizeRegistry,
  SHARED_ROOT_ENTRIES
} from '../main/lib/profiles.ts'

const work = { id: 'a1b2c3d4e5f6', name: 'Work', color: 'teal' as const }

test('the registry always starts with the default profile', () => {
  assert.deepEqual(sanitizeRegistry(null).profiles, [DEFAULT_ENTRY])
  assert.deepEqual(sanitizeRegistry({ profiles: [work] }).profiles, [DEFAULT_ENTRY, work])
  // A renamed default profile keeps its new name, wherever it was listed.
  const renamed = sanitizeRegistry({ profiles: [work, { id: 'default', name: 'Home', color: 'green' }] })
  assert.deepEqual(renamed.profiles[0], { id: 'default', name: 'Home', color: 'green' })
})

test('malformed, duplicate and path-like entries are dropped', () => {
  const registry = sanitizeRegistry({
    profiles: [
      work,
      { ...work, name: 'Copy' },
      { id: '../../evil', name: 'Escape', color: 'red' },
      { id: 'A1B2C3D4E5F6', name: 'Upper case', color: 'red' },
      { id: 'b1b2c3d4e5f6', name: '   ', color: 'red' },
      { id: 'c1b2c3d4e5f6', name: 'Odd colour', color: 'chartreuse' },
      'nonsense'
    ]
  })
  assert.deepEqual(
    registry.profiles.map((p) => [p.id, p.name, p.color]),
    [
      ['default', 'Personal', 'blue'],
      ['a1b2c3d4e5f6', 'Work', 'teal'],
      ['c1b2c3d4e5f6', 'Odd colour', 'blue']
    ]
  )
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: i.toString().padStart(12, '0'),
    name: `P${i}`,
    color: 'blue'
  }))
  assert.equal(sanitizeRegistry({ profiles: many }).profiles.length, MAX_PROFILES)
})

test('profile names are tidied and limited', () => {
  assert.equal(cleanProfileName('  Work \n stuff  '), 'Work stuff')
  assert.equal(cleanProfileName('\u0007'), null)
  assert.equal(cleanProfileName('x'.repeat(41)), null)
  assert.equal(cleanProfileName(42), null)
})

test('the command line picks the process role', () => {
  const registry = sanitizeRegistry({ profiles: [work] })
  assert.deepEqual(roleFromArgs(['aqua.exe'], registry), { kind: 'default' })
  assert.deepEqual(roleFromArgs(['aqua.exe', '--aqua-profile=a1b2c3d4e5f6'], registry), {
    kind: 'profile',
    id: 'a1b2c3d4e5f6'
  })
  assert.deepEqual(roleFromArgs(['aqua.exe', '--aqua-guest', '--aqua-profile=a1b2c3d4e5f6'], registry), {
    kind: 'guest'
  })
  // An unknown or deleted profile opens the default one instead of creating a folder.
  assert.deepEqual(roleFromArgs(['aqua.exe', '--aqua-profile=ffffffffffff'], registry), { kind: 'default' })
  assert.deepEqual(roleFromArgs(['aqua.exe', '--aqua-profile=../x'], registry), { kind: 'default' })
  for (const role of [{ kind: 'guest' } as const, { kind: 'profile', id: work.id } as const]) {
    assert.deepEqual(roleFromArgs(['aqua.exe', ...roleArgs(role)], registry), role)
  }
})

test('every role has a folder of its own, and the default profile keeps the root', () => {
  const root = join('E:', 'AquaData')
  assert.equal(roleDir(root, { kind: 'default' }), root)
  assert.equal(roleDir(root, { kind: 'profile', id: work.id }), join(root, 'Profiles', work.id))
  assert.equal(roleDir(root, { kind: 'guest' }), join(root, 'Guest'))
  // Wiping the default profile leaves the other profiles and the guest folder alone.
  for (const entry of ['Profiles', 'Guest', 'profiles.json']) assert.ok(SHARED_ROOT_ENTRIES.has(entry))
  const registry = sanitizeRegistry({ profiles: [work] })
  assert.equal(roleEntry(registry, { kind: 'guest' }), null)
  assert.equal(roleEntry(registry, { kind: 'profile', id: work.id })?.name, 'Work')
  assert.equal(roleEntry(registry, { kind: 'default' })?.name, 'Personal')
})

test('new profile ids are valid registry ids', () => {
  const id = profileIdFrom(new Uint8Array([1, 2, 3, 250, 251, 252, 9]))
  assert.equal(id, '010203fafbfc')
  assert.equal(sanitizeRegistry({ profiles: [{ id, name: 'New', color: 'blue' }] }).profiles[1]?.id, id)
})
