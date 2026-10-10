import assert from 'node:assert/strict'
import { test } from 'node:test'
import { opensElsewhere, safeFileName, ZONE_IDENTIFIER } from '../main/lib/download-safety.ts'
import { isSavableUrl, isWebUrl } from '../shared/url.ts'

test('download names lose the bidirectional controls that disguise an extension', () => {
  assert.equal(safeFileName('invoice\u202Efdp.exe'), 'invoicefdp.exe')
  assert.equal(safeFileName('a\u2066b\u2069c\u200F.txt'), 'abc.txt')
  assert.equal(safeFileName('re: report?.pdf'), 're_ report_.pdf')
  assert.equal(safeFileName('\u202E  '), 'download')
})

test('shortcuts and other files Windows follows elsewhere are shown, not opened', () => {
  for (const name of ['x.lnk', 'X.URL', 'a.scf', 'b.library-ms', 'c.search-ms', 'd.SettingContent-ms', 'e.website']) {
    assert.equal(opensElsewhere(`C:\\Downloads\\${name}`), true, name)
  }
  for (const name of ['report.pdf', 'setup.exe', 'photo.jpg', 'url.txt']) {
    assert.equal(opensElsewhere(`C:\\Downloads\\${name}`), false, name)
  }
})

test('the mark of the web names the Internet zone and no address', () => {
  assert.match(ZONE_IDENTIFIER, /^\[ZoneTransfer\]\r\nZoneId=3\r\n$/)
})

test('the page context menu opens only web addresses, and never saves from file:', () => {
  assert.equal(isWebUrl('https://example.com/a'), true)
  assert.equal(isWebUrl('http://example.com'), true)
  for (const url of [
    'file://attacker.example/share/x',
    'file:///C:/Windows/win.ini',
    'data:text/html,hi',
    'blob:https://a.example/1',
    'javascript:alert(1)',
    'ftp://example.com/',
    'not a url'
  ]) {
    assert.equal(isWebUrl(url), false, url)
  }
  assert.equal(isSavableUrl('data:image/png;base64,AAAA'), true)
  assert.equal(isSavableUrl('blob:https://a.example/1'), true)
  assert.equal(isSavableUrl('file://attacker.example/share/x'), false)
  assert.equal(isSavableUrl('FILE:///C:/x'), false)
})
