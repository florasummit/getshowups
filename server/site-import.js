// Website import: reads a business's EXISTING public website (any platform; Squarespace is the first real case) so
// its content can start the GetShowUps draft instead of the owner retyping it.
//
// Safety and respect:
//   - Public pages only: plain GET of HTML pages, no cookies, no logins, no JS execution, no private endpoints.
//   - robots.txt is honoured for our user agent (falling back to the * group); sitemap first, then the home page links.
//   - Same site only for pages (the hostname the owner typed, with or without www); every URL, including redirect
//     targets, must pass normalizeWebsiteUrl (public hostnames only: no IPs, localhost or private names).
//   - Bounded: ≤ MAX_PAGES pages, ≤ PAGE_BYTES per page, ≤ 3 redirects, timeouts, small concurrency.
//   - Everything read is UNTRUSTED DATA: it is stored as plain text, never as instructions, and it reaches a website
//     only through validateContent (claims filter, limits) after the owner reviews and applies it.
import { normalizeWebsiteUrl } from './url.js'
import { INDUSTRIES, industryKey } from './site-design.js'
import { legalSections } from './site-starter.js'

export const USER_AGENT = 'GetShowUpsSiteImport/1.0 (+https://getshowups.com; imports a site at the owner request)'
const UA_TOKEN = 'getshowupssiteimport'
export const MAX_PAGES = 12
const PAGE_BYTES = 4_000_000 // builder platforms inline a lot of markup
const IMAGE_BYTES = 1_000_000
const TIMEOUT = 8000
const MAX_TEXT = 40
const MAX_BLOCK = 600
const MAX_IMAGES = 24

// ---------- robots.txt ----------
// Groups of consecutive User-agent lines share the rules that follow. Our token's group wins, else '*'.
export function parseRobots(text) {
  const groups = []
  let current = null
  let lastWasAgent = false
  const sitemaps = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }))
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
    } else {
      lastWasAgent = false
      if (key === 'sitemap') sitemaps.push(value)
      else if ((key === 'allow' || key === 'disallow') && current) current.rules.push({ allow: key === 'allow', path: value })
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && UA_TOKEN.includes(a))) || groups.find((g) => g.agents.includes('*'))
  return { rules: mine ? mine.rules.filter((r) => r.path !== '' || !r.allow) : [], sitemaps }
}

const ruleRe = (p) => new RegExp(`^${p.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$')}`)
// Longest matching rule wins; Allow wins ties; an empty Disallow allows everything.
export function robotsAllows(robots, pathAndQuery) {
  let best = null
  for (const r of robots.rules) {
    if (r.path === '') continue
    if (ruleRe(r.path).test(pathAndQuery) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r
  }
  return !best || best.allow
}

// ---------- fetching ----------
const sameSite = (a, b) => a.replace(/^www\./, '') === b.replace(/^www\./, '')

async function readCapped(res, max) {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

// GET a public URL. siteHost: when set, every hop must stay on that site (pages). Returns { ok, url, type, bytes } or
// { ok: false, error }.
// Test-only (Playwright): SITE_IMPORT_MOCK_ORIGIN, honoured only for http://127.0.0.1:port, serves fake sites at
// <origin>/__site/<host><path>. The URL rules above still apply to the real URL.
const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/
let mockOrigin = null
export const setImportMock = (origin) => {
  mockOrigin = typeof origin === 'string' && MOCK_RE.test(origin) ? origin : null
}
const target = (u) => (mockOrigin ? `${mockOrigin}/__site/${u.hostname}${u.pathname}${u.search}` : u.href)

export async function fetchPublic(url, { siteHost = null, maxBytes = PAGE_BYTES, accept = 'text/html' } = {}) {
  let current = url
  for (let hop = 0; hop <= 3; hop++) {
    const [err, safe] = normalizeWebsiteUrl(current)
    if (err) return { ok: false, error: 'unsafe_url' }
    const u = new URL(safe)
    if (siteHost && !sameSite(u.hostname, siteHost)) return { ok: false, error: 'left_site' }
    let res
    try {
      res = await fetch(target(u), { method: 'GET', redirect: 'manual', headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(TIMEOUT) })
    } catch {
      return { ok: false, error: 'unreachable' }
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u).href
      continue
    }
    if (!res.ok) return { ok: false, error: `http_${res.status}` }
    const bytes = await readCapped(res, maxBytes)
    if (!bytes) return { ok: false, error: 'too_large' }
    return { ok: true, url: u.href, type: (res.headers.get('content-type') || '').toLowerCase(), bytes }
  }
  return { ok: false, error: 'too_many_redirects' }
}

// ---------- extraction (no DOM in Workers; a tolerant tag scanner is enough for content) ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™' }
export const decode = (s) =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
const text = (html) => decode(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim()
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null
}
const abs = (href, base) => {
  try {
    return new URL(href, base).href
  } catch {
    return null
  }
}
const PRICE_RE = /\$\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:\/|per)\s?(?:hr|hour|visit|month|mo|week|wk|service|clean|cleaning|treatment))?/gi

export function extractPage(html, pageUrl) {
  const src = String(html)
  // Structured data first (it lives in script tags, which are removed below).
  const jsonLd = []
  for (const m of src.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const v = JSON.parse(m[1])
      jsonLd.push(...(Array.isArray(v) ? v : v['@graph'] || [v]))
    } catch {
      /* ignore invalid structured data */
    }
  }
  const body = src.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
  const meta = (name) => {
    for (const m of body.matchAll(/<meta\b[^>]*>/gi)) {
      const t = m[0]
      if ((attr(t, 'name') || attr(t, 'property') || '').toLowerCase() === name) return (attr(t, 'content') || '').trim() || null
    }
    return null
  }
  const title = text((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')
  const headings = []
  for (const m of body.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = text(m[2])
    if (t && t.length <= 200) headings.push({ level: Number(m[1][1]), text: t })
  }
  const blocks = []
  const seen = new Set()
  for (const m of body.matchAll(/<(p|li|blockquote|h[1-4])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = text(m[2]).slice(0, MAX_BLOCK)
    if (t.length < 2 || seen.has(t)) continue
    seen.add(t)
    blocks.push({ tag: m[1].toLowerCase(), text: t })
    if (blocks.length >= MAX_TEXT * 2) break
  }
  const links = []
  const contacts = { phones: new Set(), emails: new Set() }
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${m[1]}>`, 'href') || ''
    if (/^tel:/i.test(href)) contacts.phones.add(href.slice(4).replace(/[^\d+]/g, ''))
    else if (/^mailto:/i.test(href)) contacts.emails.add(href.slice(7).split('?')[0].toLowerCase())
    else {
      const url = abs(href, pageUrl)
      if (url && /^https?:/.test(url)) links.push({ url: url.split('#')[0], text: text(m[2]).slice(0, 80) })
    }
  }
  const images = []
  const imgSeen = new Set()
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const t = m[0]
    const raw = attr(t, 'data-src') || attr(t, 'data-image') || attr(t, 'src') || (attr(t, 'srcset') || '').split(',')[0].trim().split(/\s+/)[0]
    const url = raw && abs(raw, pageUrl)
    if (!url || !/^https:/.test(url) || /\.svg(\?|$)/i.test(url) || imgSeen.has(url)) continue
    imgSeen.add(url)
    const dims = (attr(t, 'data-image-dimensions') || '').match(/(\d+)x(\d+)/)
    images.push({ url, alt: (attr(t, 'alt') || '').slice(0, 150), width: dims ? Number(dims[1]) : Number(attr(t, 'width')) || null, height: dims ? Number(dims[2]) : Number(attr(t, 'height')) || null })
    if (images.length >= MAX_IMAGES) break
  }
  const found = headings.length || blocks.length || links.length || images.length || contacts.phones.size || contacts.emails.size
  const appShell = isAppShell(src, body, found)
  const prices = []
  for (const b of blocks) for (const p of b.text.match(PRICE_RE) || []) prices.push({ price: p.replace(/\s+/g, ' '), context: b.text.slice(0, 200) })
  const business = jsonLd.find((x) => /LocalBusiness|Organization|Service|Store|HomeAndConstructionBusiness/i.test(String(x?.['@type'] || '')))
  return {
    url: pageUrl,
    path: new URL(pageUrl).pathname,
    title,
    description: meta('description') || meta('og:description'),
    image: meta('og:image'),
    canonical: (body.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i) || [])[0] ? attr(body.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i)[0], 'href') : null,
    headings: headings.slice(0, 30),
    text: blocks.slice(0, MAX_TEXT),
    images,
    links: links.slice(0, 80),
    prices: prices.slice(0, 20),
    phones: [...contacts.phones].slice(0, 3),
    emails: [...contacts.emails].slice(0, 3),
    ...(appShell ? { appShell: true } : {}),
    business: business
      ? {
          name: typeof business.name === 'string' ? business.name.slice(0, 120) : null,
          telephone: typeof business.telephone === 'string' ? business.telephone.slice(0, 40) : null,
          priceRange: typeof business.priceRange === 'string' ? business.priceRange.slice(0, 20) : null,
          areaServed: typeof business.areaServed === 'string' ? business.areaServed.slice(0, 120) : null,
          locality: typeof business.address?.addressLocality === 'string' ? business.address.addressLocality.slice(0, 60) : null,
          region: typeof business.address?.addressRegion === 'string' ? business.address.addressRegion.slice(0, 30) : null,
        }
      : null,
  }
}

// A page drawn in the browser by JavaScript (an "app shell", e.g. a Vite/React single-page app): the HTML itself has
// nothing readable, it loads an external script, and its body is only an empty mount point or a <noscript> message.
// Conservative: any heading, text, link, image, phone or email, or any visible body text, means it is not one. The
// script is never run; this only lets us tell the owner why nothing could be read.
const MOUNT_RE = /<(div|main)\b[^>]*\bid\s*=\s*["']?(root|app|__next|__nuxt|svelte)["']?[^>]*>\s*<\/\1>|<app-root\b[^>]*>\s*<\/app-root>/i
function isAppShell(src, body, found) {
  if (found || !/<script\b[^>]*\bsrc\s*=/i.test(src)) return false
  const inner = (body.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [])[1]
  if (inner === undefined || text(inner)) return false
  return MOUNT_RE.test(inner) || /<noscript\b/i.test(src)
}

// A real XML sitemap, not an HTML page answering at that address (single-page apps return their shell for every path).
export function isXmlSitemap(type, bytes) {
  const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart()
  if (/^<(!doctype\s+html|html)\b/i.test(head)) return false
  return /xml/.test(type || '') || /^<(\?xml|urlset|sitemapindex)\b/i.test(head)
}

const locs = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]))

// ---------- the import ----------
async function inBatches(items, size, fn) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

// Returns { ok, source, pages[], skipped[], robotsBlocked } or { ok: false, error }.
export async function crawlSite(input) {
  const [err, url] = normalizeWebsiteUrl(input)
  if (err) return { ok: false, error: err }
  const start = new URL(url)
  const home = await fetchPublic(start.origin + '/', { siteHost: start.hostname })
  if (!home.ok) return { ok: false, error: home.error === 'unsafe_url' ? 'unsafe_url' : 'unreachable' }
  const origin = new URL(home.url).origin
  const host = new URL(home.url).hostname
  const robotsRes = await fetchPublic(`${origin}/robots.txt`, { siteHost: host, maxBytes: 200_000, accept: 'text/plain' })
  const robots = parseRobots(robotsRes.ok ? new TextDecoder().decode(robotsRes.bytes) : '')
  const allowed = (u) => {
    const x = new URL(u)
    return robotsAllows(robots, x.pathname + x.search)
  }
  if (!allowed(home.url)) return { ok: false, error: 'robots_disallowed' }

  // Candidate pages: sitemap(s) first, then the home page's own links. Same site only, no query strings, no files.
  const candidates = new Set()
  for (const sm of [...robots.sitemaps, `${origin}/sitemap.xml`].slice(0, 3)) {
    const r = await fetchPublic(sm, { siteHost: host, maxBytes: 1_000_000, accept: 'application/xml,text/xml' })
    if (r.ok && isXmlSitemap(r.type, r.bytes)) for (const loc of locs(new TextDecoder().decode(r.bytes))) candidates.add(loc)
    if (candidates.size) break
  }
  const homePage = extractPage(new TextDecoder().decode(home.bytes), home.url)
  for (const l of homePage.links) candidates.add(l.url)
  const pageUrls = []
  const skipped = []
  for (const c of candidates) {
    let u
    try {
      u = new URL(c)
    } catch {
      continue
    }
    if (!sameSite(u.hostname, host) || u.search || /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|xml|txt)$/i.test(u.pathname)) continue
    // Shop, account and search pages are not website content.
    if (/^\/(cart|checkout|account|login|search|commerce)(\/|$)/i.test(u.pathname)) continue
    const norm = `${origin}${u.pathname.replace(/\/+$/, '') || '/'}`
    if (norm === `${origin}/` || pageUrls.includes(norm)) continue
    if (!allowed(norm)) {
      skipped.push({ url: norm, reason: 'robots' })
      continue
    }
    pageUrls.push(norm)
  }
  const toFetch = pageUrls.slice(0, MAX_PAGES - 1)
  for (const u of pageUrls.slice(MAX_PAGES - 1)) skipped.push({ url: u, reason: 'page_limit' })
  const pages = [homePage]
  const fetched = await inBatches(toFetch, 4, async (u) => ({ u, r: await fetchPublic(u, { siteHost: host }) }))
  for (const { u, r } of fetched) {
    if (!r.ok) skipped.push({ url: u, reason: r.error })
    else if (!r.type.includes('html')) skipped.push({ url: u, reason: 'not_a_page' })
    else {
      const page = extractPage(new TextDecoder().decode(r.bytes), r.url)
      // The same page under two addresses (e.g. / and /home): keep the first.
      const sig = (p) => p.title + '|' + p.headings.map((h) => h.text).join('|') + '|' + p.text.length
      if (pages.some((p) => sig(p) === sig(page))) skipped.push({ url: u, reason: 'duplicate' })
      else pages.push(page)
    }
  }
  // clientRendered: the home page is an app shell, so only its title/description (and structured data) were readable.
  return { ok: true, source: origin, platform: detectPlatform(home), pages, skipped, ...(homePage.appShell ? { clientRendered: true } : {}) }
}

function detectPlatform(home) {
  const h = new TextDecoder().decode(home.bytes.slice(0, 200_000))
  if (/squarespace/i.test(h)) return 'squarespace'
  if (/wix\.com|wixstatic/i.test(h)) return 'wix'
  if (/wp-content|wordpress/i.test(h)) return 'wordpress'
  if (/godaddy|websites\.godaddy|img1\.wsimg/i.test(h)) return 'godaddy'
  if (/shopify/i.test(h)) return 'shopify'
  if (/webflow/i.test(h)) return 'webflow'
  return 'other'
}

// ---------- from import to a draft suggestion ----------
const GENERIC = /^(home|services?|our services|about( us)?|contact( us)?|welcome|menu|faq|gallery|reviews?|request service|book now|get in touch|careers|privacy policy|terms)$/i
const firstSentences = (s, max) => {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…'
}
const pageLike = (pages, re) => pages.find((p) => re.test(p.path) || re.test(p.title || ''))

// A suggested draft from the import. Only text that appears on the owner's site; nothing invented. The caller passes it
// through validateContent (claims filter + limits) before anything is saved.
export function suggestContent(result, LIMITS, { site = null, fresh = false } = {}) {
  const pages = result.pages
  const home = pages[0]
  // The same classification as the old-address plan: a salon's "Menu", a clinic's "Treatments" or a "Pricing" page is
  // the services page; "About us" / "Our story" is the about page.
  const about = pages.find((p) => p !== home && pageKind(p) === 'about') || pageLike(pages, /about/i)
  const services = pages.find((p) => p !== home && pageKind(p) === 'services') || pageLike(pages, /service/i)
  const paras = (p) => (p?.text || []).filter((b) => b.tag === 'p' && b.text.length >= 40).map((b) => b.text)
  const h1 = home.headings.find((h) => h.level === 1)?.text || home.headings[0]?.text || ''
  const out = {}
  if (h1 && h1.length <= LIMITS.headline) out.headline = h1
  const intro = home.description || paras(home)[0]
  if (intro) out.intro = firstSentences(intro, LIMITS.intro)
  const aboutText = paras(about).join('\n\n')
  if (aboutText) out.about = firstSentences(aboutText, LIMITS.about)
  // Services: headings on the services page (not generic ones), each with the text that follows it and a price only
  // if that text states one.
  const list = []
  const svc = services || home
  for (const h of svc.headings.filter((x) => x.level >= 2 && !GENERIC.test(x.text) && x.text.length <= LIMITS.serviceName)) {
    // The blocks after the heading up to the next heading: a short block that is mostly a price is the price
    // ("$150+", "$350+ extras excluded"); the first real paragraph is the description.
    const i = svc.text.findIndex((b) => b.text === h.text && /^h/.test(b.tag))
    const after = []
    for (const b of svc.text.slice(i + 1)) {
      if (/^h/.test(b.tag)) break
      after.push(b.text)
    }
    if (i < 0) continue
    const priceBlock = after.find((t) => t.length <= LIMITS.price && PRICE_RE.test(t) && ((PRICE_RE.lastIndex = 0), true))
    PRICE_RE.lastIndex = 0
    const description = after.find((t) => t !== priceBlock && t.length >= 30)
    list.push({ name: h.text, price: priceBlock || '', description: description ? firstSentences(description, LIMITS.serviceText) : '' })
    if (list.length >= LIMITS.services) break
  }
  if (list.length) out.services = list
  if (home.title && home.title.length <= LIMITS.seoTitle) out.seoTitle = home.title
  if (home.description && home.description.length <= LIMITS.seoDescription) out.seoDescription = home.description
  const biz = pages.map((p) => p.business).find(Boolean)
  if (biz?.areaServed) out.area = biz.areaServed.slice(0, LIMITS.area)
  // Photos the owner can choose from: content images, largest first, de-duplicated by URL.
  const seen = new Set()
  const photos = pages
    .flatMap((p) => p.images)
    .filter((i) => !seen.has(i.url) && seen.add(i.url))
    .filter((i) => !/logo|icon|favicon/i.test(i.url + ' ' + i.alt) && (!i.width || i.width >= 500))
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))
    .slice(0, 12)
  // Old page addresses → the closest place on the new site, so links and search results keep working after the domain
  // moves. `addresses` is the full plan the owner reviews (incl. addresses kept as they are).
  // Pages first (they depend only on what kinds of pages the old site had), then the address plan against the site
  // the owner will have: today's site, or for a business without one (`fresh`), the site this import builds (home +
  // the pages offered from its content). The apply step re-plans against the site actually saved.
  const offers = pageOffers(result, out, planAddresses(result, null), site)
  const target = site || (fresh ? { pages: [{ slug: '' }, ...offers.filter((p) => p.source !== 'starter').map((p) => ({ slug: p.slug }))] } : null)
  const addresses = planAddresses(result, target)
  out.redirects = addresses.filter((a) => !a.kept).map((a) => ({ from: a.from, to: a.to }))
  return { content: out, photos, addresses, pages: offers }
}

// Pages the import can create on the new website (server/site-starter.js builds them). Each offer says where its
// content comes from; a page the new site already has is shown, not offered again (never replaced).
function pageOffers(result, content, addresses, site) {
  const have = new Set((site?.pages || []).map((p) => p.slug))
  const had = (kinds) => addresses.some((a) => kinds.includes(a.kind))
  const policyPage = result.pages.find((p) => pageKind(p) === 'privacy' && /privacy/i.test(`${p.path} ${p.title}`))
  const policy = policyPage ? legalSections(policyPage) : null
  const offers = []
  if (content.services?.length) offers.push({ kind: 'services', slug: 'services', source: 'imported', count: content.services.length })
  if (content.about) offers.push({ kind: 'about', slug: 'about', source: 'imported' })
  if (had(['contact', 'request'])) offers.push({ kind: 'contact', slug: 'contact', source: 'records' })
  if (policy?.ok) offers.push({ kind: 'privacy', slug: 'privacy', source: 'imported', path: policyPage.path, words: policy.words })
  else offers.push({ kind: 'privacy', slug: 'privacy', source: 'starter', ...(policyPage ? { path: policyPage.path, problem: policy?.reason || 'empty' } : { missing: true }) })
  return offers.map((o) => ({ ...o, exists: have.has(o.slug) }))
}

// ---------- old addresses ----------
// What an old page is, from its own address first, then its real title (a leftover template title like "Contact 3" is
// ignored) and headings. Order matters: the most specific kinds first.
const KINDS = [
  ['privacy', /privacy|terms|cookie|legal/],
  ['careers', /career|jobs?\b|hiring|join (the|our)\b.*team|work with us|openings/],
  ['faq', /\bfaqs?\b|questions/],
  ['area', /service-?areas?|areas-we-serve|locations|where-we-work/],
  // Asking for service/a time → booking is the closest place; general contact/quote → a Contact page when there is one.
  ['request', /request|book|schedule|appointment/],
  ['contact', /contact|quote|estimate|reach us|get in touch/],
  ['services', /servic|pricing|prices?\b|rates|packages|what-we-do|treatments|menu|maintenance|cleaning|repair|installation/],
  ['about', /about|team|who-we|who we are|our story|story\b/],
  ['home', /^\/(home|index(\.html?)?)$/],
]
const PLACEHOLDER_TITLE = /^(contact|page|new page|blank|untitled|copy of .*)\s*\d*$/i
const titleOf = (p) => String(p.title || '').split(/\s+[—–|-]\s+/)[0].trim()
export function pageKind(p) {
  const path = p.path.toLowerCase()
  for (const [kind, re] of KINDS) if (re.test(path)) return kind
  const title = titleOf(p)
  const words = [PLACEHOLDER_TITLE.test(title) ? '' : title, ...(p.headings || []).slice(0, 3).map((h) => h.text)].join(' ').toLowerCase()
  for (const [kind, re] of KINDS) if (kind !== 'home' && re.test(words)) return kind
  return 'other'
}
// Pages of the new (AI-designed) site that stand in for each kind, by the slugs the page templates use.
const KIND_SLUGS = { about: ['about'], contact: ['contact'], privacy: ['privacy', 'privacy-policy'], services: ['services'], faq: ['faq'], area: ['service-area'], home: [''] }
// Page types the owner can add in the editor to keep an address (src/dashboard/site-templates.js PAGE_TYPES).
const ADDABLE = { about: 'About', contact: 'Contact', privacy: 'Privacy', services: 'Services', faq: 'Questions', area: 'Service area' }

// site: the current draft's content.site (AI-designed; pages by slug) or null (template site: fixed sections).
export function planAddresses(result, site = null) {
  const slugs = new Set((site?.pages || []).map((p) => p.slug))
  const clean = (path) => path.toLowerCase().replace(/\/+$/, '')
  const old = result.pages
    .filter((p) => p.path !== '/')
    .map((p) => ({ from: clean(p.path), kind: pageKind(p), label: (PLACEHOLDER_TITLE.test(titleOf(p)) ? p.headings?.[0]?.text : titleOf(p)) || p.headings?.[0]?.text || clean(p.path), empty: !(p.text || []).length }))
    .concat(result.skipped.filter((x) => x.reason === 'duplicate').map((x) => ({ from: clean(new URL(x.url).pathname), kind: 'home', label: 'Home (duplicate address)', empty: false })))
    .filter((a, i, all) => a.from && /^\/[a-z0-9][a-z0-9._~/-]{0,119}$/.test(a.from) && all.findIndex((x) => x.from === a.from) === i)
    .slice(0, 30)
  return old.map((a) => {
    const base = { from: a.from, kind: a.kind, label: a.label.slice(0, 80), ...(a.empty ? { empty: true } : {}) }
    // Same address on the new site: nothing to redirect, the old link simply keeps working.
    if (site && slugs.has(a.from.slice(1))) return { ...base, kept: true, to: a.from }
    if (a.kind === 'home') return { ...base, to: '/' }
    if (a.kind === 'request') return { ...base, to: 'book' }
    const page = site && (KIND_SLUGS[a.kind] || []).find((s) => s && slugs.has(s))
    if (page) return { ...base, to: `/${page}` }
    if (!site && ['services', 'about'].includes(a.kind)) return { ...base, to: `/#${a.kind}` } // template sites have these sections
    if (a.kind === 'contact') return { ...base, to: 'book', ...(site ? { add: ADDABLE.contact } : {}) }
    // Nothing similar yet: the home page, saying which page would keep this address (if the editor can add one).
    return { ...base, to: '/', ...(site && ADDABLE[a.kind] ? { add: ADDABLE[a.kind] } : { nomatch: true }) }
  })
}

// Downloads one image the owner picked (public https, any host the page referenced; capped and byte-checked by the
// caller's saveAsset). Squarespace CDN images are requested at a web size.
export async function fetchImage(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return { ok: false, error: 'invalid_url' }
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'unsafe_url' }
  // Squarespace's CDN serves web sizes on request: step down until the photo fits the upload limit.
  const sizes = /squarespace-cdn\.com$/.test(u.hostname) && !u.searchParams.has('format') ? ['1500w', '1000w', '750w'] : [null]
  let r
  for (const size of sizes) {
    if (size) u.searchParams.set('format', size)
    r = await fetchPublic(u.href, { maxBytes: IMAGE_BYTES, accept: 'image/jpeg,image/png,image/webp' })
    if (r.ok || r.error !== 'too_large') break
  }
  return r.ok ? { ok: true, bytes: r.bytes } : r
}

// Things the owner should look at before using the content (shown with the import; nothing is changed automatically).
export function reviewFlags(result) {
  const flags = []
  // One clear explanation instead of an "empty page" line per app-shell page.
  if (result.clientRendered) flags.push({ kind: 'client_rendered' })
  for (const p of result.pages) {
    if (!p.headings.length && !p.text.length && !p.appShell) flags.push({ kind: 'empty_page', path: p.path })
    if (/^(new page|page \d+|untitled|contact \d+)\b/i.test(p.title.split(/\s+[—|-]\s+/)[0])) flags.push({ kind: 'placeholder_title', path: p.path, title: p.title.slice(0, 80) })
  }
  // The same service with different prices on different pages.
  const byName = new Map()
  for (const p of result.pages) for (const x of p.prices) {
    const key = x.context.split(/[$:]/)[0].trim().toLowerCase().slice(0, 40)
    if (!key) continue
    if (!byName.has(key)) byName.set(key, new Set())
    byName.get(key).add(x.price)
  }
  for (const [name, set] of byName) if (set.size > 1) flags.push({ kind: 'price_conflict', name, prices: [...set].slice(0, 4) })
  return flags.slice(0, 20)
}

const MAX_RESULT = 400_000
// Keeps the stored result within a safe size by trimming the longest text first.
export function compactResult(r) {
  const out = { ...r, pages: r.pages.map((p) => ({ ...p, links: p.links.slice(0, 30) })) }
  while (JSON.stringify(out).length > MAX_RESULT) {
    const p = out.pages.reduce((a, b) => (JSON.stringify(a.text).length >= JSON.stringify(b.text).length ? a : b))
    if (p.text.length <= 3) break
    p.text = p.text.slice(0, Math.ceil(p.text.length / 2))
    p.truncated = true // never imported as a legal page (it would be incomplete)
  }
  return out
}

// ---------- content review (offered to the owner, never applied on our own) ----------
// possible_typo: a word that is another word ON THE SAME SITE with two neighbouring letters swapped ("Cleanign" when the
//   site also says "Cleaning"). The correction comes only from the owner's own text.
// unrelated_copy: a service description about indoor house cleaning on a business that isn't a cleaning business (typical
//   leftover template text). The only fix offered is to leave that description out; nothing is written for them.
const swapped = (a, b) => {
  if (a.length !== b.length || a === b) return false
  const d = [...a].map((ch, i) => (ch === b[i] ? -1 : i)).filter((i) => i >= 0)
  return d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]]
}
const INDOOR = /\b(house|houses|room|rooms|carpets?|kitchens?|bathrooms?|every corner|maids?|dusting|laundry|spotless sanctuary)\b/i
const matchCase = (src, word) => (src[0] === src[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word)

export function contentFixes(content, result) {
  const siteText = result.pages.flatMap((p) => [p.title, ...p.headings.map((h) => h.text), ...p.text.map((b) => b.text)]).join(' ')
  const counts = new Map()
  for (const w of siteText.toLowerCase().match(/[a-z]{5,}/g) || []) counts.set(w, (counts.get(w) || 0) + 1)
  const vocab = [...counts.keys()]
  const fields = [
    ['headline', content.headline],
    ['intro', content.intro],
    ['about', content.about],
    ['seoTitle', content.seoTitle],
    ['seoDescription', content.seoDescription],
    ...(content.services || []).flatMap((x, i) => [[`services.${i}.name`, x.name], [`services.${i}.description`, x.description]]),
  ]
  const fixes = []
  const seen = new Set()
  for (const [field, text] of fields) {
    for (const w of String(text || '').match(/[A-Za-z]{5,}/g) || []) {
      const lw = w.toLowerCase()
      if (seen.has(field + lw)) continue
      // Only towards the spelling the site uses more often (never "correct" the common word into the rare one).
      const right = vocab.find((v) => swapped(lw, v) && counts.get(v) > (counts.get(lw) || 0))
      if (right) {
        seen.add(field + lw)
        fixes.push({ kind: 'possible_typo', field, from: w, to: matchCase(w, right) })
      }
    }
  }
  const industry = industryKey({ description: siteText.slice(0, 4000), name: '' })
  // Described as something else, on a business that isn't a cleaning business: indoor house cleaning, or cleaning work
  // that never mentions the business's own trade (e.g. "cleaning packages… deep seasonal scrub" on a pool service).
  const topic = INDUSTRIES[industry]?.re
  ;(content.services || []).forEach((x, i) => {
    const d = x.description || ''
    const indoor = industry !== 'cleaning' && INDOOR.test(d)
    const offTopic = industry !== 'cleaning' && topic && !topic.test(d) && /\b(clean|cleaning|scrub|tidy|dusting|sparkl\w*)\b/i.test(d)
    if (d && (indoor || offTopic)) fixes.push({ kind: 'unrelated_copy', field: `services.${i}.description`, service: x.name, excerpt: d.slice(0, 120), reason: indoor ? 'indoor_cleaning' : 'off_topic' })
  })
  return fixes.slice(0, 20).map((f, id) => ({ id, ...f }))
}

// Applies the chosen fixes to a copy of the suggested content.
export function applyFixes(content, fixes, chosen) {
  const out = { ...content, services: (content.services || []).map((x) => ({ ...x })) }
  const set = (field, fn) => {
    const [top, i, key] = field.split('.')
    if (top === 'services') out.services[Number(i)][key] = fn(out.services[Number(i)][key])
    else out[top] = fn(out[top])
  }
  for (const f of fixes.filter((x) => chosen.includes(x.id))) {
    if (f.kind === 'possible_typo') set(f.field, (v) => String(v).replace(new RegExp(`\\b${f.from}\\b`, 'g'), f.to))
    if (f.kind === 'unrelated_copy') set(f.field, () => '')
  }
  return out
}
