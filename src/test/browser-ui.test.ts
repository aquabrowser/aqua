import assert from 'node:assert/strict'
import { test } from 'node:test'
import { siteFixScripts } from '../main/blocker/site-fixes.ts'
import { droppedUrl } from '../shared/url.ts'

test('links and images dropped on the tab strip: only web addresses open', () => {
  assert.equal(droppedUrl('https://example.com/a?b=1', ''), 'https://example.com/a?b=1')
  assert.equal(droppedUrl('# comment\r\nhttps://img.example/cat.png\r\n', ''), 'https://img.example/cat.png')
  assert.equal(droppedUrl('', 'http://example.org'), 'http://example.org/')
  assert.equal(droppedUrl('javascript:alert(1)', 'javascript:alert(1)'), null)
  assert.equal(droppedUrl('file:///C:/Windows/win.ini', ''), null)
  assert.equal(droppedUrl('data:text/html,hi', ''), null)
  assert.equal(droppedUrl('', 'just some words'), null)
  assert.equal(droppedUrl('', ''), null)
})

test('site fixes apply to their site and its subdomains only', () => {
  assert.equal(siteFixScripts('www.youtube.com').length, 1)
  assert.equal(siteFixScripts('m.youtube.com').length, 1)
  assert.equal(siteFixScripts('youtube.com').length, 1)
  assert.equal(siteFixScripts('notyoutube.com').length, 0)
  assert.equal(siteFixScripts('example.com').length, 0)
  // Serialised for the page: a self-contained, immediately invoked function.
  assert.match(siteFixScripts('www.youtube.com')[0], /^\(function|^\(\(\)/)
  assert.match(siteFixScripts('www.youtube.com')[0], /\)\(\);$/)
})
