// Renders a website from validated content + design choices (server/site-design.js). Safe components
// only: every value is escaped, there are no scripts, fonts and photos are self-hosted. Responsive,
// accessible (landmarks, contrast-checked palettes, focus styles, reduced motion) and fast (system-free
// fonts with swap, responsive images, one inline stylesheet).
import { FONTS, PALETTES, stockById } from './site-design.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
// Statement layout: only a short lead is set in display type. A long first paragraph keeps its first sentence as the
// statement and continues as body text (same words, just split), so it never becomes a wall of large type.
const statementText = (about) => {
  const [first, ...rest] = String(about || '').split(/\n{2,}/)
  const m = first.length > 160 && first.match(/^(.{20,200}?[.!?])\s+(\S[\s\S]*)$/)
  return m ? [m[1], m[2], ...rest].join('\n\n') : String(about || '')
}
const para = (s) =>
  String(s || '')
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('')
const ld = (o) => JSON.stringify(o).replace(/</g, '\\u003c')

// Image reference → { src, srcset, alt, stock }.
export function imageFor(ref) {
  if (!ref) return null
  if (ref.startsWith('asset:')) return { src: `/site-assets/${ref.slice(6)}`, alt: '' }
  const s = stockById(ref.slice(6))
  return s ? { src: `/site-stock/${s.file}`, srcset: `/site-stock/${s.id}-sm.jpg 900w, /site-stock/${s.file} 1600w`, alt: s.alt, stock: true } : null
}
const imgTag = (im, { cls = '', sizes = '100vw', eager = false } = {}) =>
  im
    ? `<img class="${cls}" src="${im.src}"${im.srcset ? ` srcset="${im.srcset}" sizes="${sizes}"` : ''} alt="${esc(im.alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`
    : ''

const RADIUS = { sharp: ['2px', '2px', '4px'], soft: ['10px', '12px', '18px'], round: ['999px', '22px', '30px'] }

function css(p, f, shape) {
  const [btn, card, media] = RADIUS[shape] || RADIUS.soft
  const fontFace = [...new Set([f.headFile, f.bodyFile])]
    .map((file) => `@font-face{font-family:"${file}";src:url(/site-fonts/${file}.woff2) format("woff2");font-weight:100 900;font-display:swap}`)
    .join('')
  return `${fontFace}
:root{--bg:${p.bg};--surface:${p.surface};--ink:${p.ink};--muted:${p.muted};--accent:${p.accent};--on-accent:${p.onAccent};--line:${p.line};
--head:"${f.headFile}",ui-sans-serif,system-ui,sans-serif;--body:"${f.bodyFile}",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
--r-btn:${btn};--r-card:${card};--r-media:${media};--track:${f.tracking};--hw:${f.headWeight}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.65 var(--body);-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}
a{color:inherit}
h1,h2,h3{font-family:var(--head);font-weight:var(--hw);letter-spacing:var(--track);line-height:1.04;margin:0;text-wrap:balance}
p{margin:0}
.wrap{width:min(1180px,100% - 40px);margin-inline:auto}
.eyebrow{font-size:.78rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.5em;min-height:52px;padding:0 26px;border-radius:var(--r-btn);font-weight:600;font-size:1rem;text-decoration:none;border:1.5px solid transparent;transition:transform .15s ease,filter .15s ease}
.btn:hover{transform:translateY(-1px);filter:brightness(1.06)}
.btn-main{background:var(--accent);color:var(--on-accent)}
.btn-line{border-color:currentColor;color:var(--ink)}
svg{flex:none}.btn svg{width:18px;height:18px}.sv-tile .foot svg,.sv-row .arrow svg,.quick svg{width:20px;height:20px}
a:focus-visible,.btn:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
/* header */
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;gap:28px;min-height:72px}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--head);font-weight:var(--hw);font-size:1.2rem;letter-spacing:var(--track);text-decoration:none;margin-right:auto}
.brand img{height:42px;width:auto;max-width:170px;object-fit:contain}
.nav{display:flex;gap:26px;font-size:.95rem}.nav a{text-decoration:none;color:var(--muted)}.nav a:hover{color:var(--ink)}
.top .btn{min-height:44px;padding:0 20px}
.tel{font-weight:600;text-decoration:none;white-space:nowrap}
/* hero */
.hero{position:relative;overflow:hidden}
.hero h1{font-size:clamp(2.5rem,6.2vw,5.2rem)}
.lede{font-size:clamp(1.08rem,1.6vw,1.3rem);color:var(--muted);max-width:34em;margin-top:22px}
.cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:34px}
.facts{display:flex;flex-wrap:wrap;gap:10px 26px;margin-top:34px;font-size:.92rem;color:var(--muted)}
.facts span{display:inline-flex;align-items:center;gap:8px}.facts i{width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block}
.hero--split .wrap{display:grid;grid-template-columns:1.05fr .95fr;gap:64px;align-items:center;padding:86px 0 96px}
.hero--split .media{position:relative}
.hero--split .media img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:var(--r-media)}
.hero--split .media:after{content:"";position:absolute;inset:auto -18px -18px auto;width:46%;height:46%;border-radius:var(--r-media);background:var(--surface);z-index:-1}
.hero--immersive{min-height:min(86vh,820px);display:grid;align-items:end;color:#fff;background:var(--ink)}
.hero--immersive .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.hero--immersive:before{content:"";position:absolute;inset:0;z-index:1;background:linear-gradient(180deg,rgba(0,0,0,.3) 0%,rgba(0,0,0,.42) 45%,rgba(0,0,0,.78) 100%)}
.hero--immersive .wrap{position:relative;z-index:2;padding:160px 0 84px}
.hero--immersive .lede,.hero--immersive .facts,.hero--immersive .eyebrow{color:rgba(255,255,255,.86)}
.hero--immersive .btn-line{color:#fff}
.hero--immersive.noimg{background:linear-gradient(135deg,var(--accent),var(--ink));min-height:auto}
.hero--stacked .wrap{text-align:center;padding:96px 0 0}
.hero--stacked .lede{margin-inline:auto}.hero--stacked .cta,.hero--stacked .facts{justify-content:center}
.hero--stacked .media{margin-top:64px}.hero--stacked .media img{width:100%;aspect-ratio:21/9;object-fit:cover;border-radius:var(--r-media)}
.hero--typographic .wrap{padding:110px 0 100px;display:grid;grid-template-columns:1.5fr 1fr;gap:56px;align-items:end}
.hero--typographic h1{font-size:clamp(2.8rem,7.4vw,6.4rem)}
.hero--typographic .orb{position:absolute;right:-12vw;top:-18vw;width:52vw;height:52vw;max-width:760px;max-height:760px;border-radius:50%;background:radial-gradient(circle at 30% 30%,var(--surface),transparent 70%);z-index:-1}
.quick{border-top:1px solid var(--line)}
.quick a{display:flex;justify-content:space-between;gap:12px;padding:16px 0;border-bottom:1px solid var(--line);text-decoration:none;font-weight:600}
.quick a span{color:var(--accent)}
/* sections */
section.s{padding:104px 0}
section.s.alt{background:var(--surface)}
.s-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:end;gap:20px;margin-bottom:48px}
.s-head h2{font-size:clamp(2rem,4vw,3.2rem);max-width:15em}
.s-head p{color:var(--muted);max-width:30em}
/* services */
.sv-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}
.sv-card{display:flex;flex-direction:column;gap:12px;padding:30px;border:1px solid var(--line);border-radius:var(--r-card);background:var(--bg)}
.alt .sv-card{background:var(--bg)}
.sv-card .n{font-family:var(--head);font-size:.9rem;color:var(--accent);font-weight:700}
.sv-card h3{font-size:1.45rem}
.sv-card p{color:var(--muted)}
.price{display:inline-block;align-self:flex-start;padding:4px 12px;border-radius:var(--r-btn);background:var(--surface);font-size:.88rem;font-weight:600}
.alt .price{background:var(--bg)}
.sv-card .go{margin-top:auto;padding-top:10px;font-weight:600;text-decoration:none;color:var(--accent)}
.sv-rows{border-top:1px solid var(--line)}
.sv-row{display:grid;grid-template-columns:72px 1.1fr 1.4fr auto;gap:28px;align-items:center;padding:30px 0;border-bottom:1px solid var(--line);text-decoration:none}
.sv-row .n{font-family:var(--head);font-size:1.4rem;color:var(--accent);font-weight:700}
.sv-row h3{font-size:clamp(1.35rem,2.4vw,1.9rem)}
.sv-row p{color:var(--muted)}
.sv-row .end{display:flex;align-items:center;gap:16px;justify-self:end;font-weight:600;white-space:nowrap}
.sv-row .arrow{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;border:1.5px solid var(--line);transition:background .15s}
.sv-row:hover .arrow{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.sv-tiles{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.sv-tile{position:relative;display:flex;flex-direction:column;justify-content:space-between;gap:36px;min-height:240px;padding:36px;border-radius:var(--r-card);background:var(--surface);text-decoration:none}
.sv-tile:nth-child(4n+1),.sv-tile:nth-child(4n+4){background:var(--accent);color:var(--on-accent)}
.sv-tile:nth-child(4n+1) p,.sv-tile:nth-child(4n+4) p{color:inherit;opacity:.85}
.sv-tile h3{font-size:clamp(1.6rem,2.8vw,2.3rem)}
.sv-tile p{color:var(--muted);margin-top:10px;max-width:28em}
.sv-tile .foot{display:flex;justify-content:space-between;align-items:center;font-weight:600}
/* about */
.ab-split{display:grid;grid-template-columns:1fr 1fr;gap:72px;align-items:center}
.ab-split img{width:100%;aspect-ratio:5/4;object-fit:cover;border-radius:var(--r-media)}
.ab-text h2{font-size:clamp(2rem,4vw,3rem);margin-bottom:24px}
.ab-text p+p{margin-top:16px}.ab-text p{color:var(--muted);font-size:1.08rem}
.ab-statement{padding:20px 0}
.ab-statement p{font-family:var(--head);font-weight:var(--hw);letter-spacing:var(--track);font-size:clamp(1.7rem,3.6vw,2.9rem);line-height:1.18;max-width:24em}
.ab-statement p+p{font-family:var(--body);font-weight:400;letter-spacing:0;font-size:1.1rem;line-height:1.6;color:var(--muted);margin-top:24px;max-width:40em}
.band{background:var(--accent);color:var(--on-accent)}
.band .ab-statement p+p{color:inherit;opacity:.85}
.facts-list{list-style:none;padding:0;margin:28px 0 0;display:grid;gap:12px}
.facts-list li{display:flex;gap:12px}.facts-list li:before{content:"";flex:none;width:8px;height:8px;margin-top:.6em;border-radius:50%;background:var(--accent)}
/* gallery */
.gallery{display:grid;grid-template-columns:repeat(6,1fr);gap:14px}
.gallery img{width:100%;height:100%;object-fit:cover;border-radius:var(--r-card);aspect-ratio:1}
.gallery img:nth-child(1){grid-column:span 3;grid-row:span 2;aspect-ratio:auto}
.gallery img:nth-child(n+2){grid-column:span 3}
.gallery img:nth-child(n+4){grid-column:span 2}
/* process */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;counter-reset:s}
.step{padding:30px;border-radius:var(--r-card);border:1px solid var(--line);background:var(--bg)}
.step b{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:var(--accent);color:var(--on-accent);font-family:var(--head);margin-bottom:22px}
.step h3{font-size:1.3rem;margin-bottom:8px}.step p{color:var(--muted)}
/* area + closing */
.close{display:grid;grid-template-columns:1.2fr 1fr;gap:56px;align-items:center}
.close h2{font-size:clamp(2.2rem,4.6vw,3.8rem)}
.close .box{padding:34px;border-radius:var(--r-card);background:var(--bg);border:1px solid var(--line)}
.close .box dt{font-size:.8rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.close .box dd{margin:4px 0 20px;font-weight:600;font-size:1.1rem}
footer{padding:36px 0 110px;font-size:.88rem;color:var(--muted);border-top:1px solid var(--line)}
footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}
footer a{color:inherit}
.bar{position:fixed;inset:auto 0 0 0;z-index:6;display:none;gap:10px;padding:10px 14px calc(10px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(10px);border-top:1px solid var(--line)}
.bar .btn{flex:1;min-height:48px}
.preview-note{margin:0;padding:8px 16px;background:#fff6dd;color:#6b4800;font:500 .85rem/1.4 ui-sans-serif,system-ui,sans-serif;text-align:center}
a[aria-disabled]{cursor:default}
@media (max-width:900px){
 .nav{display:none}
 .hero--split .wrap,.hero--typographic .wrap,.ab-split,.close{grid-template-columns:1fr;gap:40px}
 .hero--split .wrap{padding:48px 0 64px}.hero--split .media img{aspect-ratio:4/3}.hero--split .media:after{display:none}
 .hero--typographic .wrap{padding:64px 0}
 .hero--immersive{min-height:640px}.hero--immersive .wrap{padding:120px 0 48px}
 .hero--stacked .wrap{padding-top:56px}.hero--stacked .media{margin-top:40px}.hero--stacked .media img{aspect-ratio:4/3}
 section.s{padding:72px 0}
 .sv-row{grid-template-columns:44px 1fr;gap:6px 16px}.sv-row p,.sv-row .end{grid-column:2}.sv-row .end{justify-self:start}
 .sv-tiles,.steps{grid-template-columns:1fr}
 .gallery{grid-template-columns:1fr 1fr}.gallery img:nth-child(n){grid-column:span 1;grid-row:auto;aspect-ratio:1}
 .top .tel,.top .btn{display:none}
 .bar{display:flex}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.btn{transition:none}.btn:hover{transform:none}}`
}

const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
const PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>'

export function renderDesigned(biz, c, { canonical, bookUrl, privacyUrl = '/privacy', preview = false, year = new Date().getUTCFullYear() } = {}) {
  const d = c.design
  const p = PALETTES[d.palette]
  const f = FONTS[d.fonts]
  const visit = biz.appointmentMode === 'at_customer'
  const cta = visit ? 'Book a visit' : 'Book a time'
  const digits = String(biz.phone || '').replace(/\D/g, '')
  const tel = digits.length === 10 ? `tel:+1${digits}` : null
  const link = (href) => (preview ? 'aria-disabled="true"' : `href="${esc(href)}"`)
  const anchor = (id) => (preview ? 'aria-disabled="true"' : `href="#${id}"`)
  const title = c.seoTitle || `${biz.name} | ${c.headline}`
  const description = c.seoDescription || c.intro.slice(0, 160)
  // The owner's own main photo always wins over a chosen stock photo. With a no-photo hero it moves to About.
  const own = c.hero ? `asset:${c.hero}` : null
  // The logo is shown in the header, never as a photo: a design that placed it as the hero or About image (older
  // generations could) falls back to the design's other photo for the hero, so the page still leads with an image.
  const logoRef = c.logo ? `asset:${c.logo}` : null
  const photo = (ref) => (ref && ref !== logoRef ? ref : null)
  const heroRef = photo(d.heroImage) ?? (d.heroImage && d.hero !== 'typographic' ? photo(d.aboutImage) : null)
  const aboutRef = photo(d.aboutImage) === heroRef && !photo(d.heroImage) ? null : photo(d.aboutImage)
  const heroIm = imageFor(own && d.hero !== 'typographic' ? own : heroRef)
  const aboutIm = imageFor(own && d.hero === 'typographic' ? own : aboutRef)
  const ownPhotos = (c.photos || []).map((id) => imageFor(`asset:${id}`))
  const industryLine = [c.services[0]?.name, c.area].filter(Boolean).join(' · ')
  const buttons = (alt = 'btn-line') =>
    `<div class="cta"><a class="btn btn-main" ${link(bookUrl)}>${cta} ${ARROW}</a>${tel ? `<a class="btn ${alt}" ${link(tel)}>${PHONE} ${esc(biz.phone)}</a>` : ''}</div>`
  const factsRow = `<div class="facts">${c.area ? `<span><i></i>Serving ${esc(c.area)}</span>` : ''}<span><i></i>Book online in about a minute</span></div>`

  const heroText = `<p class="eyebrow">${esc(industryLine || biz.name)}</p><h1>${esc(c.headline)}</h1><p class="lede">${esc(c.intro)}</p>${buttons(d.hero === 'immersive' ? 'btn-line' : 'btn-line')}${factsRow}`
  let hero
  if (d.hero === 'split') {
    hero = `<section class="hero hero--split"><div class="wrap"><div>${heroText}</div>${heroIm ? `<div class="media">${imgTag(heroIm, { sizes: '(max-width:900px) 100vw, 45vw', eager: true })}</div>` : `<div class="media"><div style="aspect-ratio:4/5;border-radius:var(--r-media);background:linear-gradient(150deg,var(--surface),var(--accent))"></div></div>`}</div></section>`
  } else if (d.hero === 'immersive') {
    hero = `<section class="hero hero--immersive${heroIm ? '' : ' noimg'}">${imgTag(heroIm, { cls: 'bg', eager: true })}<div class="wrap">${heroText}</div></section>`
  } else if (d.hero === 'stacked') {
    hero = `<section class="hero hero--stacked"><div class="wrap">${heroText}${heroIm ? `<div class="media">${imgTag(heroIm, { eager: true })}</div>` : ''}</div></section>`
  } else {
    const quick = c.services.slice(0, 4).map((s) => `<a ${link(bookUrl)}>${esc(s.name)} <span>${ARROW}</span></a>`).join('')
    hero = `<section class="hero hero--typographic"><div class="orb" aria-hidden="true"></div><div class="wrap"><div>${heroText}</div>${quick ? `<nav class="quick" aria-label="Services">${quick}</nav>` : ''}</div></section>`
  }

  const num = (i) => String(i + 1).padStart(2, '0')
  const servicesBody =
    d.services === 'rows'
      ? `<div class="sv-rows">${c.services.map((s, i) => `<a class="sv-row" ${link(bookUrl)}><span class="n">${num(i)}</span><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p><span class="end">${s.price ? esc(s.price) : ''}<span class="arrow">${ARROW}</span></span></a>`).join('')}</div>`
      : d.services === 'tiles'
        ? `<div class="sv-tiles">${c.services.map((s) => `<a class="sv-tile" ${link(bookUrl)}><div><h3>${esc(s.name)}</h3>${s.description ? `<p>${esc(s.description)}</p>` : ''}</div><div class="foot"><span>${s.price ? esc(s.price) : cta}</span>${ARROW}</div></a>`).join('')}</div>`
        : `<div class="sv-cards">${c.services.map((s, i) => `<div class="sv-card"><span class="n">${num(i)}</span><h3>${esc(s.name)}</h3>${s.price ? `<span class="price">${esc(s.price)}</span>` : ''}${s.description ? `<p>${esc(s.description)}</p>` : ''}<a class="go" ${link(bookUrl)}>${cta} →</a></div>`).join('')}</div>`

  const facts = c.highlights?.length ? `<ul class="facts-list">${c.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''
  const blocks = {
    services: (alt) =>
      c.services.length
        ? `<section class="s${alt}" id="services" aria-labelledby="h-services"><div class="wrap"><div class="s-head"><h2 id="h-services">Services</h2><p>Choose what you need and pick a time that works for you.</p></div>${servicesBody}</div></section>`
        : '',
    about: (alt) => {
      if (!c.about && !facts) return ''
      if (d.about === 'statement') return `<section class="s band" id="about" aria-labelledby="h-about"><div class="wrap ab-statement"><h2 id="h-about" class="eyebrow" style="color:inherit;opacity:.8;margin-bottom:24px">About ${esc(biz.name)}</h2>${para(statementText(c.about))}${facts}</div></section>`
      if (d.about === 'split' && aboutIm) return `<section class="s${alt}" id="about" aria-labelledby="h-about"><div class="wrap ab-split">${imgTag(aboutIm, { sizes: '(max-width:900px) 100vw, 50vw' })}<div class="ab-text"><h2 id="h-about">About ${esc(biz.name)}</h2>${para(c.about)}${facts}</div></div></section>`
      return `<section class="s${alt}" id="about" aria-labelledby="h-about"><div class="wrap"><div class="ab-text" style="max-width:760px"><h2 id="h-about">About ${esc(biz.name)}</h2>${para(c.about)}${facts}</div></div></section>`
    },
    gallery: (alt) =>
      ownPhotos.length ? `<section class="s${alt}" aria-labelledby="h-work"><div class="wrap"><div class="s-head"><h2 id="h-work">Our work</h2></div><div class="gallery">${ownPhotos.map((im) => imgTag(im, { sizes: '(max-width:900px) 50vw, 33vw' })).join('')}</div></div></section>` : '',
    process: (alt) =>
      `<section class="s${alt}" aria-labelledby="h-how"><div class="wrap"><div class="s-head"><h2 id="h-how">How booking works</h2></div><div class="steps"><div class="step"><b>1</b><h3>Tell us what you need</h3><p>A few quick details so we come prepared.</p></div><div class="step"><b>2</b><h3>Pick a time</h3><p>Choose from real open times on our calendar.</p></div><div class="step"><b>3</b><h3>${visit ? 'We come to you' : 'Come in'}</h3><p>${visit ? 'We arrive at the time you booked.' : 'We see you at the time you booked.'}</p></div></div></div></section>`,
  }
  // Alternate section backgrounds, counting only sections that actually render.
  let alt = false
  const body = d.sections
    .map((s) => {
      const html = blocks[s](alt ? '' : ' alt')
      if (html && !html.includes('class="s band"')) alt = !alt
      return html
    })
    .join('')
  const closing = `<section class="s alt" id="contact" aria-labelledby="h-book"><div class="wrap close"><div><p class="eyebrow">${esc(biz.name)}</p><h2 id="h-book" style="margin-top:14px">${visit ? 'Ready when you are.' : 'Book your time today.'}</h2>${buttons()}</div><dl class="box">${c.area ? `<dt>Service area</dt><dd>${esc(c.area)}</dd>` : ''}${tel ? `<dt>Phone</dt><dd><a ${link(tel)} style="text-decoration:none">${esc(biz.phone)}</a></dd>` : ''}<dt>Booking</dt><dd>Online, any time</dd></dl></div></section>`

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: biz.name,
    description,
    ...(canonical && { url: canonical }),
    ...(tel && { telephone: `+1${digits}` }),
    ...(c.area && { areaServed: c.area }),
  }
  const headFont = `/site-fonts/${f.headFile}.woff2`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
${preview ? '<meta name="robots" content="noindex">' : canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}${heroIm && canonical ? `<meta property="og:image" content="${esc(new URL(heroIm.src, canonical).href)}">` : ''}
<meta name="theme-color" content="${p.bg}">${p.dark ? '<meta name="color-scheme" content="dark">' : ''}
<link rel="preload" href="${headFont}" as="font" type="font/woff2" crossorigin>
<style>${css(p, f, d.shape)}</style>
${preview ? '' : `<script type="application/ld+json">${ld(schema)}</script>`}
</head><body>
${preview ? '<p class="preview-note">Preview. Only you can see this.</p>' : ''}
<header class="top"><div class="wrap">
<a class="brand" ${anchor('top')}>${c.logo ? `<img src="/site-assets/${c.logo}" alt="${esc(biz.name)}">` : esc(biz.name)}</a>
<nav class="nav" aria-label="Sections">${c.services.length ? `<a ${anchor('services')}>Services</a>` : ''}${c.about ? `<a ${anchor('about')}>About</a>` : ''}<a ${anchor('contact')}>Contact</a></nav>
${tel ? `<a class="tel" ${link(tel)}>${esc(biz.phone)}</a>` : ''}<a class="btn btn-main" ${link(bookUrl)}>${cta}</a>
</div></header>
<main id="top">${hero}${body}${closing}</main>
<footer><div class="wrap"><span>© ${year} ${esc(biz.name)}${c.area ? ` · ${esc(c.area)}` : ''}</span><span><a ${link(privacyUrl)}>Privacy</a> · Website by GetShowUps</span></div></footer>
<nav class="bar" aria-label="Quick actions">${tel ? `<a class="btn btn-line" ${link(tel)}>Call</a>` : ''}<a class="btn btn-main" ${link(bookUrl)}>${cta}</a></nav>
</body></html>`
}
