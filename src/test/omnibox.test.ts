import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyInput } from '../main/omnibox/classify.ts'

const url = (input: string, expected: string, opts = {}): void =>
  assert.deepEqual(classifyInput(input, opts), { type: 'url', url: expected }, input)
const search = (input: string, query = input.trim()): void =>
  assert.deepEqual(classifyInput(input), { type: 'search', query }, input)
const external = (input: string, expected: string): void =>
  assert.deepEqual(classifyInput(input), { type: 'external', url: expected }, input)

test('fully qualified URLs are loaded as-is', () => {
  url('https://github.com/trending', 'https://github.com/trending')
  url('http://example.com', 'http://example.com/')
  url('HTTPS://Example.COM/Path?q=1#h', 'https://example.com/Path?q=1#h')
  url('aqua://settings', 'aqua://settings')
  url('about:blank', 'about:blank')
  url('view-source:https://example.com', 'view-source:https://example.com')
})

test('domains without a scheme upgrade to https', () => {
  url('github.com/trending', 'https://github.com/trending')
  url('github.com', 'https://github.com/')
  url('www.bbc.co.uk', 'https://www.bbc.co.uk/')
  url('sub.domain.dev:8443/x?y=1', 'https://sub.domain.dev:8443/x?y=1')
  url('münchen.de', 'https://xn--mnchen-3ya.de/')
})

test('local and intranet hosts use http', () => {
  url('localhost', 'http://localhost/')
  url('localhost:3000', 'http://localhost:3000/')
  url('localhost:5173/app', 'http://localhost:5173/app')
  url('app.localhost:8080', 'http://app.localhost:8080/')
  url('127.0.0.1:8080', 'http://127.0.0.1:8080/')
  url('192.168.1.1', 'http://192.168.1.1/')
  url('[::1]:3000', 'http://[::1]:3000/')
  url('router:8080', 'http://router:8080/')
  url('intranet/wiki', 'http://intranet/wiki')
})

test('everything else is a search', () => {
  search('how to center a div')
  search('node.js')
  search('react')
  search('3.14')
  search('1.2')
  search('user@example.com')
  search('note: buy milk')
  search('  spaced query  ')
  search('?github.com', 'github.com')
})

test('dangerous schemes are never navigated', () => {
  search('javascript:alert(1)')
  search('aqua-ui://app/index.html')
})

test('custom schemes open externally', () => {
  external('mailto:someone@example.com', 'mailto:someone@example.com')
  external('zoommtg://zoom.us/join?confno=1', 'zoommtg://zoom.us/join?confno=1')
})

test('ctrl+enter wraps bare words', () => {
  url('google', 'https://www.google.com/', { ctrlEnter: true })
})

test('windows paths become file URLs', () => {
  url('C:\\Users\\me\\file.txt', 'file:///C:/Users/me/file.txt', { platform: 'win32' })
})
