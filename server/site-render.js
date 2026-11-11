// One multi-tenant renderer for every business website: structured content in, a fast, accessible,
// script-free HTML page out (same output for getshowups.com/p/:id, a connected domain, and the
// owner's private preview). Every value is escaped; images come only from this business's uploads.
import { COLORS } from './website.js'
import { renderDesigned } from './site-designed.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const para = (s) =>
  String(s || '')
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('')
const img = (id) => `/site-assets/${id}`
// JSON-LD inside <script> must not be able to close the tag.
const ld = (o) => JSON.stringify(o).replace(/</g, '\\u003c')

// Ad/attribution parameters are carried to the booking page (allowlisted keys only).
const KEEP = /^(utm_(source|medium|campaign|term|content)|gclid|fbclid)$/
export function carryQuery(url) {
  const out = new URLSearchParams()
  for (const [k, v] of new URL(url).searchParams) if (KEEP.test(k) && v.length <= 200) out.set(k, v)
  const s = out.toString()
  return s ? `?${s}` : ''
}

const STYLE = (accent, template) => `
:root{--accent:${accent};--ink:#16181d;--muted:#5b616e;--line:#e6e8ec;--bg:#fff;--soft:#f5f6f8;--radius:14px;
--font:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
--head:${template === 'warm' ? "Georgia,'Iowan Old Style','Times New Roman',serif" : 'var(--font)'}}
${template === 'warm' ? ':root{--bg:#fbf8f3;--soft:#f3ede4;--line:#e7dfd3}' : ''}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:17px/1.6 var(--font);color:var(--ink);background:var(--bg)}
img{max-width:100%;display:block}
a{color:var(--accent)}
h1,h2,h3{font-family:var(--head);line-height:1.15;margin:0 0 .5em;letter-spacing:-.01em}
h1{font-size:clamp(2rem,6vw,3.25rem)}h2{font-size:clamp(1.5rem,4vw,2rem)}h3{font-size:1.125rem}
p{margin:0 0 1em}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
.top{border-bottom:1px solid var(--line);background:var(--bg)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:68px}
.brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:1.125rem;color:var(--ink);text-decoration:none}
.brand img{height:44px;width:auto;max-width:160px;object-fit:contain}
.top-actions{display:flex;gap:10px;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border-radius:999px;font-weight:600;text-decoration:none;border:2px solid var(--accent);font-size:1rem}
.btn-main{background:var(--accent);color:#fff}
.btn-alt{background:transparent;color:var(--accent)}
.top .btn{min-height:42px;padding:0 18px}
.phone-link{color:var(--ink);text-decoration:none;font-weight:600;white-space:nowrap}
.hero{padding:56px 0 48px}
.hero .wrap{display:grid;gap:32px;align-items:center}
.hero .lede{font-size:1.2rem;color:var(--muted);max-width:36em}
.hero-photo{border-radius:var(--radius);aspect-ratio:4/3;object-fit:cover;width:100%}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
${template === 'bold' ? '.hero{background:var(--accent);color:#fff}.hero .lede{color:rgba(255,255,255,.88)}.hero .btn-main{background:#fff;color:var(--accent);border-color:#fff}.hero .btn-alt{color:#fff;border-color:rgba(255,255,255,.7)}' : ''}
section.block{padding:48px 0;border-top:1px solid var(--line)}
.grid{display:grid;gap:16px}
.card{background:var(--soft);border-radius:var(--radius);padding:20px 22px;display:flex;flex-direction:column;gap:6px}
.card h3{margin:0}.price{font-weight:600;color:var(--muted);margin:0}.card p{margin:0;color:var(--muted)}
.card a{margin-top:auto;padding-top:8px;font-weight:600;text-decoration:none}
.facts{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.facts li{padding-left:28px;position:relative}
.facts li:before{content:'';position:absolute;left:4px;top:.55em;width:12px;height:12px;border-radius:50%;background:var(--accent)}
.photos{display:grid;gap:12px;grid-template-columns:repeat(2,1fr)}
.photos img{border-radius:10px;aspect-ratio:1;object-fit:cover;width:100%}
.steps{padding-left:1.2em;margin:0}.steps li{margin-bottom:6px}
.contact{background:var(--soft)}
.contact .wrap{display:grid;gap:24px}
.foot{padding:28px 0 96px;color:var(--muted);font-size:.875rem}
.foot a{color:var(--muted)}
.bar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:10px;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:var(--bg);border-top:1px solid var(--line)}
.bar .btn{flex:1}
.preview-note{background:#fff7e6;color:#7a4b00;text-align:center;font-size:.875rem;padding:8px 16px;margin:0;border-bottom:1px solid #f2d9a6}
a[aria-disabled]{cursor:default}
a:focus-visible,.btn:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
@media (min-width:760px){
 .hero{padding:88px 0 80px}.hero .wrap.has-photo{grid-template-columns:1.1fr 1fr}
 .grid{grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
 .photos{grid-template-columns:repeat(3,1fr)}
 .contact .wrap{grid-template-columns:1fr 1fr;align-items:center}
 .bar{display:none}.foot{padding-bottom:28px}
}
@media (max-width:759px){.top .btn,.top .phone-link{display:none}}
@media (prefers-reduced-motion:no-preference){.btn{transition:filter .15s}.btn:hover{filter:brightness(1.08)}}
`

// biz: { id, name, appointmentMode, phone }  content: website content  opts: { canonical, bookUrl, preview, year }
export function renderSite(biz, content, opts = {}) {
  // Designed sites (AI-chosen layout from the design system); older content keeps its exact current look.
  if (content.design) return renderDesigned(biz, content, opts)
  const { canonical, bookUrl, privacyUrl = '/privacy', preview = false, year = new Date().getUTCFullYear() } = opts
  const c = content
  const accent = COLORS[c.color] || COLORS.ocean
  const visit = biz.appointmentMode === 'at_customer'
  const cta = visit ? 'Book a visit' : 'Book a time'
  const digits = String(biz.phone || '').replace(/\D/g, '')
  const tel = digits.length === 10 ? `tel:+1${digits}` : null
  // In preview nothing navigates (no accidental bookings); the owner sees exactly the same layout.
  const link = (href) => (preview ? 'aria-disabled="true"' : `href="${esc(href)}"`)
  const title = c.seoTitle || `${biz.name} | ${c.headline}`
  const description = c.seoDescription || c.intro.slice(0, 160)
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: biz.name,
    description,
    ...(canonical && { url: canonical }),
    ...(tel && { telephone: `+1${digits}` }),
    ...(c.area && { areaServed: c.area }),
    ...(c.hero && canonical && { image: new URL(img(c.hero), canonical).href }),
  }
  const services = c.services.length
    ? `<section class="block" id="services" aria-labelledby="services-h"><div class="wrap">
<h2 id="services-h">Services</h2><div class="grid">${c.services
        .map(
          (s) => `<div class="card"><h3>${esc(s.name)}</h3>${s.price ? `<p class="price">${esc(s.price)}</p>` : ''}${s.description ? `<p>${esc(s.description)}</p>` : ''}<a ${link(bookUrl)}>${cta} →</a></div>`,
        )
        .join('')}</div></div></section>`
    : ''
  const about =
    c.about || c.highlights.length
      ? `<section class="block" id="about" aria-labelledby="about-h"><div class="wrap">
<h2 id="about-h">About ${esc(biz.name)}</h2>${para(c.about)}${c.highlights.length ? `<ul class="facts">${c.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}</div></section>`
      : ''
  const photos = c.photos.length
    ? `<section class="block" aria-label="Photos"><div class="wrap"><div class="photos">${c.photos.map((id) => `<img src="${img(id)}" alt="" loading="lazy" decoding="async">`).join('')}</div></div></section>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
${preview ? '<meta name="robots" content="noindex">' : canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}${c.hero && canonical ? `<meta property="og:image" content="${esc(new URL(img(c.hero), canonical).href)}">` : ''}
<meta name="theme-color" content="${accent}">
<style>${STYLE(accent, c.template)}</style>
${preview ? '' : `<script type="application/ld+json">${ld(schema)}</script>`}
</head><body>
${preview ? '<p class="preview-note">Preview. Only you can see this.</p>' : ''}
<header class="top"><div class="wrap">
<a class="brand" ${link('#top')}>${c.logo ? `<img src="${img(c.logo)}" alt="${esc(biz.name)}">` : esc(biz.name)}</a>
<div class="top-actions">${tel ? `<a class="phone-link" ${link(tel)}>${esc(biz.phone)}</a>` : ''}<a class="btn btn-main" ${link(bookUrl)}>${cta}</a></div>
</div></header>
<main id="top">
<section class="hero"><div class="wrap${c.hero ? ' has-photo' : ''}"><div>
<h1>${esc(c.headline)}</h1><p class="lede">${esc(c.intro)}</p>
<div class="actions"><a class="btn btn-main" ${link(bookUrl)}>${cta}</a>${tel ? `<a class="btn btn-alt" ${link(tel)}>Call ${esc(biz.phone)}</a>` : ''}</div>
</div>${c.hero ? `<img class="hero-photo" src="${img(c.hero)}" alt="" fetchpriority="high">` : ''}</div></section>
${services}${about}${photos}
<section class="block contact" id="contact" aria-labelledby="contact-h"><div class="wrap"><div>
<h2 id="contact-h">${visit ? 'Book a visit' : 'Book an appointment'}</h2>
<ol class="steps"><li>Tell us what you need.</li><li>Pick a time that works for you.</li><li>${visit ? 'We come to you at the booked time.' : 'Come in at the booked time.'}</li></ol>
${c.area ? `<p><strong>Service area:</strong> ${esc(c.area)}</p>` : ''}
</div><div><div class="actions"><a class="btn btn-main" ${link(bookUrl)}>${cta}</a>${tel ? `<a class="btn btn-alt" ${link(tel)}>Call ${esc(biz.phone)}</a>` : ''}</div></div></div></section>
</main>
<footer class="foot"><div class="wrap">© ${year} ${esc(biz.name)} · <a ${link(privacyUrl)}>Privacy</a> · Website by GetShowUps</div></footer>
<nav class="bar" aria-label="Quick actions">${tel ? `<a class="btn btn-alt" ${link(tel)}>Call</a>` : ''}<a class="btn btn-main" ${link(bookUrl)}>${cta}</a></nav>
</body></html>`
}

export function renderNotice(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:17px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#16181d;background:#f5f6f8;padding:24px}main{max-width:28em;text-align:center}h1{font-size:1.5rem;margin:0 0 .5em}p{color:#5b616e;margin:0}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`
}

// Strict headers: no scripts at all on business sites, images only from this origin.
export function htmlResponse(status, html, { preview = false, cache = 'public, max-age=60' } = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': preview ? 'private, no-store' : cache,
      'Content-Security-Policy': `default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors ${preview ? "'self'" : "'none'"}`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...(preview && { 'X-Robots-Tag': 'noindex' }),
    },
  })
}
