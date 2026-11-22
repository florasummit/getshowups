// Website import of sites whose pages are drawn in the browser by JavaScript (app shells, e.g. a Vite/React single-page
// app like getshowups.com itself), and sitemap validation. The importer never runs scripts: it only recognises the shell,
// keeps what the HTML does say (title, description, structured data) and explains the rest to the owner.
// Mocked fetch, no network.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { crawlSite, extractPage, isXmlSitemap, reviewFlags, suggestContent } from '../server/site-import.js'
import { LIMITS } from '../server/website.js'

// The shape getshowups.com serves today (Vite build): metadata in <head>, an empty #root and a <noscript> line.
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Spa Pools — Weekly pool care in Charleston</title>
    <meta name="description" content="Weekly pool cleaning and repairs in Charleston." />
    <meta property="og:title" content="Spa Pools" />
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc123.css">
  </head>
  <body>
    <noscript>Spa Pools requires JavaScript to display this page.</noscript>
    <div id="root"></div>
  </body>
</html>`
const enc = (s) => new TextEncoder().encode(s)

let fetched, routes, origFetch
beforeEach(() => {
  fetched = []
  routes = {}
  origFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const u = new URL(String(input))
    fetched.push(u.pathname)
    if (u.hostname !== 'spa.example') throw new Error(`unexpected fetch ${u}`)
    const r = routes[u.pathname]
    if (r) return new Response(r.body, { headers: { 'content-type': r.type } })
    // A single-page app answers EVERY address with its shell (status 200), including /sitemap.xml.
    return new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
})
afterEach(() => {
  globalThis.fetch = origFetch
})

test('app shell: recognised, metadata kept; nothing in the HTML is invented', () => {
  const p = extractPage(SHELL, 'https://spa.example/')
  assert.equal(p.appShell, true)
  assert.equal(p.title, 'Spa Pools — Weekly pool care in Charleston')
  assert.equal(p.description, 'Weekly pool cleaning and repairs in Charleston.')
  assert.deepEqual([p.headings, p.text, p.links, p.images], [[], [], [], []])
  assert.ok(!JSON.stringify(p).includes('requires JavaScript'), 'the <noscript> line is never content')
  // Other frameworks' mount points, and a body with only a <noscript> message.
  for (const body of ['<div id="__next"></div>', '<div id="app"></div>', '<main id="root"> </main>', '<app-root></app-root>', '<noscript>Enable JavaScript</noscript>']) {
    assert.equal(extractPage(`<html><head><title>T</title><script src="/a.js"></script></head><body>${body}</body></html>`, 'https://spa.example/').appShell, true, body)
  }
})

test('app shell detection is conservative: anything readable, or no external script, means a normal page', () => {
  const doc = (body, head = '<script src="/a.js"></script>') => `<html><head><title>T</title>${head}</head><body>${body}</body></html>`
  const cases = {
    'server-rendered content inside the mount point': doc('<div id="root"><h1>Pool care</h1><p>Weekly visits.</p></div>'),
    'visible text outside any paragraph': doc('<div id="root"></div><footer>© Spa Pools, Charleston</footer>'),
    'a link': doc('<div id="root"></div><a href="/about"></a>'),
    'an image': doc('<div id="root"></div><img src="https://cdn.example/a.jpg">'),
    'a phone link': doc('<div id="root"></div><a href="tel:+18435550100"></a>'),
    'only inline scripts': doc('<div id="root"></div>', '<script>window.x = 1</script>'),
    'no mount point and no noscript': doc('<div class="wrap"></div>'),
    'no body element': '<title>T</title><script src="/a.js"></script>',
  }
  for (const [name, html] of Object.entries(cases)) assert.equal('appShell' in extractPage(html, 'https://spa.example/'), false, name)
})

test('crawl of a client-rendered site: one page, clientRendered, one clear flag instead of "empty page"; robots still honoured', async () => {
  routes['/robots.txt'] = { body: 'User-agent: *\nAllow: /\nDisallow: /dashboard', type: 'text/plain' }
  const r = await crawlSite('https://spa.example/')
  assert.equal(r.ok, true)
  assert.equal(r.clientRendered, true)
  assert.deepEqual(r.pages.map((p) => p.path), ['/'])
  assert.deepEqual(r.skipped, [])
  assert.deepEqual(fetched, ['/', '/robots.txt', '/sitemap.xml'], 'no new requests: home, robots, the usual sitemap check')
  assert.deepEqual(reviewFlags(r), [{ kind: 'client_rendered' }])
  const s = suggestContent(r, LIMITS)
  assert.equal(s.content.intro, 'Weekly pool cleaning and repairs in Charleston.', 'the description is still offered')
  assert.ok(!s.content.services?.length, 'nothing invented')

  routes['/robots.txt'] = { body: 'User-agent: *\nDisallow: /', type: 'text/plain' }
  assert.deepEqual(await crawlSite('https://spa.example/'), { ok: false, error: 'robots_disallowed' })
})

test('fake sitemaps (an HTML page at /sitemap.xml) are ignored; real XML sitemaps are used', async () => {
  const home = '<html><head><title>Home</title></head><body><h1>Spa Pools</h1><p>Weekly pool care.</p></body></html>'
  const about = '<html><head><title>About</title></head><body><h1>About us</h1><p>Family owned.</p></body></html>'
  routes['/'] = { body: home, type: 'text/html' }
  routes['/robots.txt'] = { body: 'User-agent: *\nAllow: /', type: 'text/plain' }
  routes['/about'] = { body: about, type: 'text/html' }
  // An HTML page that happens to contain <loc> text: not a sitemap, so /secret is never discovered or fetched.
  routes['/sitemap.xml'] = { body: '<!doctype html><html><body><p><loc>https://spa.example/secret</loc></p></body></html>', type: 'text/html' }
  let r = await crawlSite('https://spa.example/')
  assert.deepEqual(r.pages.map((p) => p.path), ['/'])
  assert.ok(!fetched.includes('/secret'))
  assert.equal('clientRendered' in r, false)
  assert.deepEqual(reviewFlags(r), [], 'a normal page with text raises no flag')

  fetched.length = 0
  routes['/sitemap.xml'] = { body: '<?xml version="1.0"?><urlset><url><loc>https://spa.example/about</loc></url></urlset>', type: 'text/plain' }
  r = await crawlSite('https://spa.example/')
  assert.deepEqual(r.pages.map((p) => p.path), ['/', '/about'], 'an XML sitemap served with a wrong content type still counts')

  assert.equal(isXmlSitemap('application/xml', enc('<urlset></urlset>')), true)
  assert.equal(isXmlSitemap('text/xml; charset=utf-8', enc('\uFEFF  <?xml version="1.0"?><sitemapindex/>')), true)
  assert.equal(isXmlSitemap('text/html', enc('<sitemapindex></sitemapindex>')), true)
  assert.equal(isXmlSitemap('text/html; charset=utf-8', enc(SHELL)), false, 'the app shell answering /sitemap.xml')
  assert.equal(isXmlSitemap('application/xml', enc('<!DOCTYPE html><html></html>')), false, 'HTML with an xml content type')
  assert.equal(isXmlSitemap('', enc('')), false)
})

test('an empty page that is not an app shell still gets the plain "empty page" flag', () => {
  const r = { pages: [extractPage('<html><head><title>Form</title></head><body><form></form></body></html>', 'https://spa.example/form')], skipped: [] }
  assert.deepEqual(reviewFlags(r), [{ kind: 'empty_page', path: '/form' }])
})
