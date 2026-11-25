// The brand icon exists once (brand/icon/getshowups-icon.svg, Calendar + Growth, 2026-11-25). Every copy the product
// ships must be that icon: the React logo, the favicon, the full-logo SVGs, the generated PNG/ICO files and the page head.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const bytes = (p) => readFileSync(new URL(`../${p}`, import.meta.url))
const ICON = read('brand/icon/getshowups-icon.svg')
const paths = (s) => [...s.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1])
const ART = paths(ICON)

test('the canonical icon is the Calendar + Growth mark on the near-black rounded square', () => {
  assert.equal(ART.length, 3, 'calendar, binder rings, check-arrow')
  assert.match(ICON, /<rect width="32" height="32" rx="8" fill="#111113"\/>/)
  assert.equal((ICON.match(/stroke="#FF6A1A"/g) || []).length, 2)
  assert.match(ICON, /stroke="#FFFFFF" stroke-width="2.4"/)
  assert.doesNotMatch(ICON, /gradient|filter|shadow|opacity/i, 'flat colours only')
})

test('Logo.jsx draws exactly the canonical icon (same geometry, same strokes) and keeps the wordmark markup', () => {
  const jsx = read('src/components/Logo.jsx')
  assert.deepEqual(paths(jsx), ART)
  assert.match(jsx, /<rect width="32" height="32" rx="8" className="logo-bg" \/>/)
  assert.match(jsx, /viewBox="0 0 32 32" width="28" height="28"/)
  assert.match(jsx, /GetShow<span className="logo-accent">Ups<\/span>/)
})

test('every SVG variant and the favicon carry the same artwork', () => {
  assert.equal(read('public/favicon.svg'), ICON, 'public/favicon.svg is a copy (scripts/build-brand.mjs)')
  for (const f of ['icon/getshowups-icon-raised.svg', 'icon/getshowups-icon-square.svg', 'icon/getshowups-mark-transparent-on-dark.svg', 'icon/getshowups-mark-transparent-on-light.svg', 'logo/getshowups-logo-on-light.svg', 'logo/getshowups-logo-on-dark.svg']) {
    const s = read(`brand/${f}`)
    assert.deepEqual(paths(s).slice(0, 2), ART.slice(0, 2), f)
    assert.ok(paths(s).includes(ART[2]), f)
  }
})

test('the generated raster files exist and are real PNG/ICO files', () => {
  const PNG = '89504e470d0a1a0a'
  for (const f of ['public/apple-touch-icon.png', 'public/icon-192.png', 'public/icon-512.png', 'public/icon-maskable-512.png', 'public/og-image.png', 'brand/png/icon/getshowups-icon-1024.png', 'brand/png/logo/getshowups-logo-on-light-transparent-2400w.png', 'brand/social/getshowups-og-1200x630.png']) {
    assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f)
    assert.equal(bytes(f).subarray(0, 8).toString('hex'), PNG, f)
  }
  const ico = bytes('public/favicon.ico')
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 3, '16, 32 and 48 px')
  assert.deepEqual(ico, bytes('brand/png/icon/favicon.ico'))
})

test('the page head and manifest point at the brand files', () => {
  const html = read('index.html')
  for (const href of ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/site.webmanifest', 'https://getshowups.com/og-image.png']) assert.ok(html.includes(href), href)
  const m = JSON.parse(read('public/site.webmanifest'))
  assert.equal(m.name, 'GetShowUps')
  for (const i of m.icons) assert.ok(existsSync(new URL(`../public${i.src}`, import.meta.url)), i.src)
})
