// Regenerates every raster brand asset from the canonical SVG sources in brand/ (brand/README.md):
//   brand/png/**, brand/social/**, and the web copies in public/ (favicon.svg/.ico, apple-touch-icon, manifest icons,
//   og-image), and stamps the icon version (?v=) on every link to them so browsers drop cached favicons. Run after changing brand/icon/*.svg or brand/logo/*.svg:  node scripts/build-brand.mjs
// Uses the Playwright Chromium the test suite already installs (no extra dependency). Output is committed.
import { chromium } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const B = (p) => join(ROOT, 'brand', p)
const svg = (p) => readFileSync(B(p), 'utf8').trim()
const sized = (s, w, h = w) => s.replace(/ width="[^"]*" height="[^"]*"/, '').replace('<svg ', `<svg width="${w}" height="${h}" `)
const out = (p, buf) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, buf)
}

const ICON = svg('icon/getshowups-icon.svg')
const SQUARE = svg('icon/getshowups-icon-square.svg')
const MARK_DARK = svg('icon/getshowups-mark-transparent-on-dark.svg')
const MARK_LIGHT = svg('icon/getshowups-mark-transparent-on-light.svg')
const LOGO_LIGHT = svg('logo/getshowups-logo-on-light.svg')
const LOGO_DARK = svg('logo/getshowups-logo-on-dark.svg')
const WORD_LIGHT = svg('logo/getshowups-wordmark-on-light.svg')
const WORD_DARK = svg('logo/getshowups-wordmark-on-dark.svg')
const wordW = Number(WORD_LIGHT.match(/viewBox="0 0 ([\d.]+) 28"/)[1])
const logoW = Number(LOGO_LIGHT.match(/viewBox="0 0 ([\d.]+) 28"/)[1])

const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 1 })
async function png(html, w, h, bg = 'transparent') {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<!doctype html><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${bg}}body{display:flex;align-items:center;justify-content:center}svg{display:block}</style>${html}`)
  return page.screenshot({ omitBackground: bg === 'transparent', type: 'png' })
}
// A maskable icon keeps its artwork inside the central 80% circle: the mark at 62% on a full-bleed square.
const maskable = (n) => `<div style="width:${n}px;height:${n}px;background:#111113;display:flex;align-items:center;justify-content:center">${sized(MARK_DARK, Math.round(n * 0.62))}</div>`

// Icons (rounded square, transparent corners) at every common size.
const icons = {}
for (const n of [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]) {
  icons[n] = await png(sized(ICON, n), n, n)
  out(B(`png/icon/getshowups-icon-${n}.png`), icons[n])
}
for (const n of [180, 512, 1024]) out(B(`png/icon/getshowups-icon-square-${n}.png`), await png(sized(SQUARE, n), n, n))
out(B('png/icon/getshowups-icon-maskable-512.png'), await png(maskable(512), 512, 512))
out(B('png/icon/getshowups-mark-transparent-on-dark-1024.png'), await png(sized(MARK_DARK, 1024), 1024, 1024))
out(B('png/icon/getshowups-mark-transparent-on-light-1024.png'), await png(sized(MARK_LIGHT, 1024), 1024, 1024))

// Full logo: transparent and on its background, high resolution (2400 px wide artwork).
const LW = 2400
const LH = Math.round((LW * 28) / logoW)
for (const [name, s, bg] of [['on-light', LOGO_LIGHT, '#FFFFFF'], ['on-dark', LOGO_DARK, '#101114']]) {
  out(B(`png/logo/getshowups-logo-${name}-transparent-${LW}w.png`), await png(sized(s, LW, LH), LW, LH))
  const pad = Math.round(LH * 0.6)
  out(B(`png/logo/getshowups-logo-${name}-background-${LW}w.png`), await png(sized(s, LW, LH), LW + pad * 2, LH + pad * 2, bg))
}

// The wordmark alone, high resolution.
const WH = Math.round((LW * 28) / wordW)
for (const [name, s, bg] of [['on-light', WORD_LIGHT, '#FFFFFF'], ['on-dark', WORD_DARK, '#101114']]) {
  out(B(`png/logo/getshowups-wordmark-${name}-transparent-${LW}w.png`), await png(sized(s, LW, WH), LW, WH))
  const pad = Math.round(WH * 0.6)
  out(B(`png/logo/getshowups-wordmark-${name}-background-${LW}w.png`), await png(sized(s, LW, WH), LW + pad * 2, WH + pad * 2, bg))
}

// Social sharing image (1200x630): the logo centred on the product's dark stage.
const og = await png(sized(LOGO_DARK, 720, Math.round((720 * 28) / logoW)), 1200, 630, '#101114')
out(B('social/getshowups-og-1200x630.png'), og)
out(B('social/getshowups-og-light-1200x630.png'), await png(sized(LOGO_LIGHT, 720, Math.round((720 * 28) / logoW)), 1200, 630, '#FFFFFF'))
await browser.close()

// favicon.ico: PNG-compressed entries (16, 32, 48), supported by every current browser.
function ico(list) {
  const head = Buffer.alloc(6 + 16 * list.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(list.length, 4)
  let offset = head.length
  list.forEach(([n, data], i) => {
    const e = 6 + 16 * i
    head.writeUInt8(n >= 256 ? 0 : n, e)
    head.writeUInt8(n >= 256 ? 0 : n, e + 1)
    head.writeUInt16LE(1, e + 4)
    head.writeUInt16LE(32, e + 6)
    head.writeUInt32LE(data.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...list.map(([, d]) => d)])
}
const icoBuf = ico([[16, icons[16]], [32, icons[32]], [48, icons[48]]])
out(B('png/icon/favicon.ico'), icoBuf)

// Web copies served from getshowups.com.
const pub = (p) => join(ROOT, 'public', p)
copyFileSync(B('icon/getshowups-icon.svg'), pub('favicon.svg'))
out(pub('favicon.ico'), icoBuf)
copyFileSync(B('png/icon/getshowups-icon-square-180.png'), pub('apple-touch-icon.png'))
copyFileSync(B('png/icon/getshowups-icon-192.png'), pub('icon-192.png'))
copyFileSync(B('png/icon/getshowups-icon-512.png'), pub('icon-512.png'))
copyFileSync(B('png/icon/getshowups-icon-maskable-512.png'), pub('icon-maskable-512.png'))
copyFileSync(B('social/getshowups-og-1200x630.png'), pub('og-image.png'))

// Cache-busting: browsers keep favicons for days keyed by URL, so every link carries ?v=<hash of the icon source>.
// The version changes only when the icon changes. index.html, the manifest and server pages (server/brand.js) use it.
const V = createHash('sha256').update(readFileSync(B('icon/getshowups-icon.svg'))).update(readFileSync(B('logo/getshowups-logo-on-dark.svg'))).digest('hex').slice(0, 10)
const stamp = (file, names) => {
  let s = readFileSync(file, 'utf8')
  for (const n of names) s = s.replace(new RegExp(`(/${n.replace('.', '\\.')})(\\?v=[0-9a-f]+)?(?=")`, 'g'), `$1?v=${V}`)
  writeFileSync(file, s)
}
stamp(join(ROOT, 'index.html'), ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'site.webmanifest', 'og-image.png'])
stamp(pub('site.webmanifest'), ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'])
writeFileSync(join(ROOT, 'server/brand.js'), `// Generated by scripts/build-brand.mjs: the brand icon version, appended as ?v= to icon links so browsers refetch\n// a changed favicon instead of showing a cached one. Do not edit by hand.\nexport const BRAND_ICON_VERSION = '${V}'\nexport const FAVICON_HREF = '/favicon.svg?v=${V}'\n`)
console.log(`brand assets written, icon version ${V}`)
