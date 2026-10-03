import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SETTINGS, mergeStoredSettings, sanitizeSettings } from '../main/services/settings.ts'

test('unknown keys and invalid values fall back to the defaults', () => {
  const settings = sanitizeSettings({
    theme: 'purple',
    darkStyle: 'neon',
    ntpFont: 'comic',
    ntpBackground: 'url(https://tracker.example/pixel.png)',
    ntpAutoShortcuts: 'yes',
    injected: true
  })
  assert.deepEqual(settings, DEFAULT_SETTINGS)
})

test('New Tab and theme choices round-trip', () => {
  const settings = sanitizeSettings({
    theme: 'dark',
    darkStyle: 'slate',
    ntpGreeting: true,
    ntpFont: 'condensed',
    ntpAutoShortcuts: false,
    ntpBackground: 'gradient:dusk'
  })
  assert.equal(settings.darkStyle, 'slate')
  assert.equal(settings.ntpGreeting, true)
  assert.equal(settings.ntpFont, 'condensed')
  assert.equal(settings.ntpAutoShortcuts, false)
  assert.equal(settings.ntpBackground, 'gradient:dusk')
})

test('“pure black” from earlier versions becomes the Midnight theme', () => {
  assert.equal(sanitizeSettings({ oledBlack: true }).darkStyle, 'midnight')
  assert.equal(sanitizeSettings({ oledBlack: false }).darkStyle, 'classic')
  assert.equal(sanitizeSettings({ themeAccent: 'oled' }).theme, 'dark')
})

test('the vault’s old choice survives a theme hint that doesn’t mention it', () => {
  // Before the unlock only the hint is known: dark theme, default (classic) style.
  const beforeUnlock = { ...structuredClone(DEFAULT_SETTINGS), theme: 'dark' as const }
  assert.equal(mergeStoredSettings(beforeUnlock, { oledBlack: true }).darkStyle, 'midnight')
  // Once a style has been picked in this version, it wins over the old flag.
  assert.equal(mergeStoredSettings(beforeUnlock, { oledBlack: true, darkStyle: 'slate' }).darkStyle, 'slate')
  // Without anything stored, the hint stands.
  const slate = { ...beforeUnlock, darkStyle: 'slate' as const }
  assert.equal(mergeStoredSettings(slate, {}).darkStyle, 'slate')
})

test('profiles from before the first-run welcome never see it; a new vault’s progress is kept', () => {
  // An existing vault's stored settings have no onboarding key at all.
  assert.equal(mergeStoredSettings(DEFAULT_SETTINGS, { searchEngine: 'google' }).onboardingCompleted, true)
  // A vault created since: false until the last step, true after it.
  assert.equal(mergeStoredSettings(DEFAULT_SETTINGS, { onboardingCompleted: false }).onboardingCompleted, false)
  assert.equal(sanitizeSettings({ onboardingCompleted: true }).onboardingCompleted, true)
  assert.equal(sanitizeSettings({ onboardingCompleted: 'no' }).onboardingCompleted, true)
})
