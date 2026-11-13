// Website URL normalization (server/url.js): the one rule for website addresses owners type, for every business.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWebsiteUrl } from '../server/url.js'
import { normalizeHostname } from '../server/domains.js'

test('accepts bare domains, www, subdomains, paths and queries; https by default; explicit http(s) kept', () => {
  const ok = {
    'example.com': 'https://example.com',
    'www.example.com': 'https://www.example.com',
    'http://example.com': 'http://example.com',
    'https://example.com': 'https://example.com',
    '  https://example.com/  ': 'https://example.com/',
    'HTTPS://Example.com/Book': 'HTTPS://Example.com/Book',
    'shop.pools.example.co.uk/book?ref=gsu&x=1#top': 'https://shop.pools.example.co.uk/book?ref=gsu&x=1#top',
    'http://blog.example.com/a/b?c=d': 'http://blog.example.com/a/b?c=d',
    'example.com:8443/x': 'https://example.com:8443/x',
    'my-pool-co.com': 'https://my-pool-co.com',
    'bücher.de': 'https://bücher.de',
    'xn--bcher-kva.de': 'https://xn--bcher-kva.de',
    'poolthru.example': 'https://poolthru.example',
  }
  for (const [input, want] of Object.entries(ok)) assert.deepEqual(normalizeWebsiteUrl(input), [null, want], input)
})

test('existing valid saved URLs come back unchanged (re-saving never rewrites them)', () => {
  for (const saved of ['https://poolthru.example', 'https://www.salon.example/', 'https://pools.example/book?utm_source=x']) {
    assert.deepEqual(normalizeWebsiteUrl(saved), [null, saved])
    assert.deepEqual(normalizeWebsiteUrl(normalizeWebsiteUrl(saved)[1]), [null, saved], 'idempotent')
  }
})

test('rejects malformed input, other protocols and unsafe destinations', () => {
  const bad = {
    '': 'invalid_url',
    '   ': 'invalid_url',
    example: 'unsafe_url',
    'exa mple.com': 'invalid_url',
    'http:example.com': 'invalid_url',
    'https://': 'invalid_url',
    'https:///example.com': 'invalid_url',
    '//example.com': 'invalid_url',
    '/path/only': 'invalid_url',
    'example..com': 'invalid_url',
    '-bad-.com': 'invalid_url',
    'example.c0m': 'invalid_url',
    'https://example.com/<script>': 'invalid_url',
    ['x'.repeat(2050) + '.com']: 'invalid_url',
    'javascript:alert(1)': 'unsupported_protocol',
    'JavaScript:alert(1)': 'unsupported_protocol',
    'data:text/html,hi': 'unsupported_protocol',
    'ftp://example.com': 'unsupported_protocol',
    'file:///etc/passwd': 'unsupported_protocol',
    'mailto:owner@example.com': 'unsupported_protocol',
    'tel:5550100': 'invalid_url', // reads like host:port; refused either way
    'https://user:pass@example.com': 'unsafe_url',
    'https://owner@example.com': 'unsafe_url',
    localhost: 'unsafe_url',
    'localhost:3000': 'unsafe_url',
    'http://localhost:8788/x': 'unsafe_url',
    'app.localhost': 'unsafe_url',
    'printer.local': 'unsafe_url',
    'metadata.internal': 'unsafe_url',
    '127.0.0.1': 'unsafe_url',
    'http://127.1': 'unsafe_url',
    'http://2130706433': 'unsafe_url',
    'http://0x7f000001': 'unsafe_url',
    '10.0.0.5/admin': 'unsafe_url',
    'http://169.254.169.254/latest': 'unsafe_url',
    'http://[::1]/': 'unsafe_url',
    'https://[fd00::1]': 'unsafe_url',
  }
  for (const [input, code] of Object.entries(bad)) assert.deepEqual(normalizeWebsiteUrl(input), [code], JSON.stringify(input))
  for (const v of [null, undefined, 42, {}, []]) assert.equal(normalizeWebsiteUrl(v)[0] !== null, true)
})

test('own-domain field already takes the same four forms (hostname only)', () => {
  for (const input of ['example.com', 'www.example.com', 'http://www.example.com', 'https://www.example.com/book?x=1']) {
    assert.equal(normalizeHostname(input)[0], null, input)
  }
  assert.equal(normalizeHostname('https://www.example.com/x')[1].hostname, 'www.example.com')
})
