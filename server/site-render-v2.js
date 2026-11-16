// Renders a validated v2 design (server/site-spec.js) to one HTML page. Primitives, not templates: the spec decides
// pages, section order and composition; this file only turns validated values into markup and CSS. Safety: every text
// is escaped, every value comes from the validated spec (enums, clamped numbers, checked colours), there is no script
// besides JSON-LD data, fonts and photos are self-hosted, links are booking / this site's pages / sections only.
// Responsive by construction (fluid type with clamp(), CSS grid that collapses on small screens); motion is CSS-only
// and off for people who prefer reduced motion.
import { FONTS } from './site-spec.js'
import { stockById } from './site-design.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const paras = (s) =>
  String(s || '')
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('')
const ld = (o) => JSON.stringify(o).replace(/</g, '\\u003c')

const ICON_PATHS = {
  water: 'M3 15c2 0 2-1.5 4.5-1.5S9.5 15 12 15s2.5-1.5 4.5-1.5S19 15 21 15M3 19c2 0 2-1.5 4.5-1.5S9.5 19 12 19s2.5-1.5 4.5-1.5S19 19 21 19M12 3s-4 4.5-4 7a4 4 0 0 0 8 0c0-2.5-4-7-4-7z',
  drop: 'M12 3s-6 6.5-6 11a6 6 0 0 0 12 0c0-4.5-6-11-6-11z',
  leaf: 'M5 19c0-8 5-13 15-14-1 10-6 15-14 15M5 19l7-7',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  snow: 'M12 2v20M4 6l16 12M20 6L4 18M9 3l3 3 3-3M9 21l3-3 3 3',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  check: 'M4 12l5 5L20 6',
  'map-pin': 'M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12zM12 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  phone: 'M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z',
  home: 'M3 11l9-7 9 7M5 10v10h14V10',
  wrench: 'M14 6a4 4 0 0 0 5 5l-9 9a2.1 2.1 0 0 1-3-3l9-9a4 4 0 0 1-2-2z',
  brush: 'M4 20c3 0 4-1 4-3a2 2 0 0 1 2-2l9-9-2-2-9 9a2 2 0 0 1-2 2c-2 0-2 1-2 5z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  thermometer: 'M10 4a2 2 0 0 1 4 0v10a4 4 0 1 1-4 0z',
  chat: 'M4 5h16v11H8l-4 4z',
  truck: 'M3 6h11v9H3zM14 9h4l3 3v3h-7M7 18a1.5 1.5 0 1 0 0 .1M17 18a1.5 1.5 0 1 0 0 .1',
  heart: 'M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
}
const icon = (name) => (ICON_PATHS[name] ? `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICON_PATHS[name]}"/></svg>` : '')

function image(ref, { alt = '', cls = '', sizes = '100vw', eager = false } = {}) {
  if (!ref) return ''
  const lazy = eager ? 'fetchpriority="high"' : 'loading="lazy"'
  if (ref.startsWith('asset:')) return `<img class="${cls}" src="/site-assets/${ref.slice(6)}" alt="${esc(alt)}" ${lazy} decoding="async">`
  const s = stockById(ref.slice(6))
  return s ? `<img class="${cls}" src="/site-stock/${s.file}" srcset="/site-stock/${s.id}-sm.jpg 900w, /site-stock/${s.file} 1600w" sizes="${sizes}" alt="${esc(alt || s.alt)}" ${lazy} decoding="async">` : ''
}

// composition: the page uses a composition section (its CSS is only sent when needed).
function css(t, { composition = false } = {}) {
  const c = t.colors
  const pad = { compact: [40, 56, 72, 96], comfortable: [56, 80, 104, 136], airy: [72, 104, 136, 176] }[t.density]
  const fonts = [...new Set([t.headingFont, t.bodyFont])].map((f) => `@font-face{font-family:"${f}";src:url(/site-fonts/${f}.woff2) format("woff2");font-weight:100 900;font-display:swap}`).join('')
  const k = t.scale
  const fs = (n) => `${(t.baseSize * k ** n).toFixed(1)}px`
  // Display sizes shrink with the screen: the floor is also capped by the viewport width, so a large scale or a wide
  // display font can't push a headline word past a phone's edge (seen at 390px: 75px Cormorant, 54px uppercase Syne).
  const cap = (n) => (n >= 5 ? 11 : n >= 3 ? 8.5 : 100)
  const fluid = (n) => `clamp(min(${(t.baseSize * k ** Math.max(1, n - 2)).toFixed(1)}px, ${cap(n)}vw), ${(t.baseSize * k ** n * 0.16).toFixed(2)}vw + ${(t.baseSize * k ** (n - 1) * 0.55).toFixed(1)}px, min(${fs(n)}, ${cap(n)}vw))`
  const btn = {
    solid: `background:var(--accent);color:var(--on-accent);border:2px solid var(--accent);border-radius:${Math.min(t.radius, 14)}px`,
    pill: `background:var(--accent);color:var(--on-accent);border:2px solid var(--accent);border-radius:999px`,
    outline: `background:transparent;color:inherit;border:2px solid currentColor;border-radius:${Math.min(t.radius, 14)}px`,
    underline: `background:transparent;color:inherit;border:0;border-bottom:2px solid currentColor;border-radius:0;padding-left:0;padding-right:0`,
  }[t.buttons]
  const motion =
    t.motion === 'none'
      ? ''
      : `@media (prefers-reduced-motion:no-preference){@keyframes gsu-fade{from{opacity:0}to{opacity:1}}@keyframes gsu-rise{from{opacity:0;transform:translateY(${t.motion === 'expressive' ? 36 : 16}px)}to{opacity:1;transform:none}}
.hero .hero-copy>*{animation:gsu-rise .7s cubic-bezier(.2,.7,.2,1) both}.hero .hero-copy>*:nth-child(2){animation-delay:.08s}.hero .hero-copy>*:nth-child(3){animation-delay:.16s}.hero .hero-copy>*:nth-child(4){animation-delay:.24s}
@supports (animation-timeline:view()){.anim-fade{animation:gsu-fade linear both;animation-timeline:view();animation-range:entry 0% cover 30%}.anim-rise{animation:gsu-rise linear both;animation-timeline:view();animation-range:entry 0% cover 30%}}}`
  return `${fonts}
:root{--bg:${c.bg};--surface:${c.surface};--ink:${c.ink};--muted:${c.muted};--accent:${c.accent};--on-accent:${c.onAccent};--accent-text:${c.accentText};--line:${c.line};--r:${t.radius}px;--max:${t.maxWidth}px;--hf:"${t.headingFont}",system-ui,sans-serif;--bf:"${t.bodyFont}",system-ui,sans-serif}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:400 ${t.baseSize}px/${t.lineHeight} var(--bf);text-rendering:optimizeLegibility}
img{max-width:100%;display:block}a{color:var(--accent-text)}a:focus-visible,.btn:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
h1,h2,h3{font-family:var(--hf);font-weight:${t.headingWeight};letter-spacing:${t.headingTracking}em;line-height:1.08;margin:0;overflow-wrap:break-word;${t.headingCase === 'upper' ? 'text-transform:uppercase;' : ''}text-wrap:balance}
h1{font-size:${fluid(5)}}h2{font-size:${fluid(3.4)}}h3{font-size:${fs(1.3)};line-height:1.25}p{margin:0 0 1em}p:last-child{margin-bottom:0}
.wrap{width:min(var(--max),100% - 40px);margin-inline:auto}.w-narrow .wrap{max-width:720px}.w-wide .wrap{width:min(var(--max),100% - 40px)}.w-full .wrap{width:100%;max-width:none;padding-inline:max(20px,(100% - var(--max)) / 2)}
.sec{padding-block:var(--py)}.sp-s{--py:${pad[0]}px}.sp-m{--py:${pad[1]}px}.sp-l{--py:${pad[2]}px}.sp-xl{--py:${pad[3]}px}@media(max-width:700px){.sec{--py:${pad[0]}px}}
.bg-bg{background:var(--bg)}.bg-surface{background:var(--surface)}.bg-accent{background:var(--accent);color:var(--on-accent)}.bg-accent a,.bg-ink a{color:inherit}.bg-ink{background:var(--ink);color:var(--bg)}
.bg-ink .muted,.bg-accent .muted{color:inherit;opacity:.82}.bg-image{position:relative;color:#fff;isolation:isolate}.bg-image>.bgimg{position:absolute;inset:0;z-index:-2}.bg-image>.bgimg img{width:100%;height:100%;object-fit:cover}.bg-image::before{content:"";position:absolute;inset:0;background:#000;opacity:.55;z-index:-1}
.al-center{text-align:center}.al-center .head{margin-inline:auto}.al-center .actions{justify-content:center}
.eyebrow{font-size:${fs(-1)};letter-spacing:.14em;text-transform:uppercase;font-weight:600;color:var(--accent-text);margin:0 0 14px}.bg-accent .eyebrow,.bg-ink .eyebrow,.bg-image .eyebrow{color:inherit;opacity:.85}
.muted{color:var(--muted)}.head{max-width:780px;margin-bottom:clamp(28px,4vw,48px)}.head p{margin-top:16px;font-size:${fs(0.5)}}.lead p{font-size:${fs(1.2)};line-height:1.45}
.btn{display:inline-flex;align-items:center;gap:8px;padding:14px 26px;font:600 ${fs(0.15)}/1 var(--bf);text-decoration:none;cursor:pointer;transition:transform .15s,opacity .15s;${btn}}.btn:hover{transform:translateY(-1px)}.btn.ghost{background:transparent;color:inherit;border-color:currentColor}
.bg-accent .btn:not(.ghost){background:var(--on-accent);color:var(--accent);border-color:var(--on-accent)}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
.ico{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;color:var(--accent-text)}.bg-accent .ico,.bg-ink .ico{color:inherit}
.nav{position:${'relative'};z-index:20;background:var(--bg);border-bottom:1px solid var(--line)}.nav.sticky{position:sticky;top:0}.nav .wrap{display:flex;align-items:center;gap:24px;min-height:72px}
.nav .brand{font:700 ${fs(0.6)}/1 var(--hf);color:var(--ink);text-decoration:none;letter-spacing:${t.headingTracking}em;${t.headingCase === 'upper' ? 'text-transform:uppercase;' : ''}}.nav ul{display:flex;gap:22px;list-style:none;margin:0;padding:0}.nav ul a{color:var(--ink);text-decoration:none;font-size:${fs(-0.3)}}.nav ul a[aria-current]{color:var(--accent-text)}
.nav-left .brand,.nav-split .brand{margin-right:auto}.nav-center .wrap{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;column-gap:24px;row-gap:2px;padding-block:8px}.nav-center .brand{grid-column:2;grid-row:1;text-align:center}.nav-center .btn{grid-column:3;grid-row:1;justify-self:end}.nav-center ul{grid-column:1/-1;grid-row:2;justify-content:center}.nav-split ul{flex:1;justify-content:center}.nav .btn{padding:10px 18px;min-height:44px}
@media(max-width:820px){.nav ul{display:none}.nav .wrap{justify-content:space-between}.nav-center .wrap{grid-template-columns:1fr auto;padding-block:0}.nav-center .brand{grid-column:1;text-align:left}.nav-center .btn{grid-column:2}}
.hero{position:relative}.h-auto{min-height:0}.h-tall{min-height:min(calc(85vh - 72px),760px);min-height:min(calc(85svh - 72px),760px)}.h-screen{min-height:calc(100vh - 72px);min-height:calc(100svh - 72px)}.hero .wrap{display:grid;align-items:center;gap:clamp(28px,5vw,72px)}.hero.h-tall,.hero.h-screen{display:flex;flex-direction:column;justify-content:center;padding-block:clamp(32px,6vh,var(--py))}
.hero p.sub{font-size:${fs(0.6)};max-width:620px}.al-center .hero-copy p.sub{margin-inline:auto}
.l-split .wrap{grid-template-columns:1.05fr .95fr}.l-split.side-left .hero-media{order:-1}.hero-media img{width:100%;height:100%;max-height:640px;object-fit:cover;border-radius:var(--r)}
.l-overlay{color:#fff}.l-overlay .hero-bg{position:absolute;inset:0}.l-overlay .hero-bg img{width:100%;height:100%;object-fit:cover}.l-overlay .hero-bg::after{content:"";position:absolute;inset:0;background:#000;opacity:var(--ov)}.l-overlay .wrap{position:relative}.l-overlay .eyebrow{color:#fff}
.l-overlay .btn.ghost{color:#fff}.l-stacked .hero-media img{max-height:560px;margin-top:48px}.l-editorial h1{font-size:${fluid(6)};line-height:.98}.l-editorial .wrap{grid-template-columns:1fr}.l-editorial .hero-copy{display:grid;grid-template-columns:1.4fr 1fr;gap:48px;align-items:end}
.l-minimal .wrap{grid-template-columns:1fr}.l-mosaic .wrap{grid-template-columns:1fr 1fr}.mosaic{display:grid;grid-template-columns:1fr 1fr;gap:12px}.mosaic img{width:100%;height:100%;aspect-ratio:3/4;object-fit:cover;border-radius:var(--r)}.mosaic img:first-child{grid-row:span 2;aspect-ratio:auto}
@media(max-width:860px){.l-split .wrap,.l-mosaic .wrap,.l-editorial .hero-copy{grid-template-columns:1fr}.l-split.side-left .hero-media{order:0}.h-tall,.h-screen{min-height:0}}
.grid{display:grid;gap:clamp(16px,2.4vw,28px);grid-template-columns:repeat(var(--cols),minmax(0,1fr))}@media(max-width:900px){.grid{--cols:2!important}}@media(max-width:600px){.grid{--cols:1!important}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:clamp(20px,2.4vw,32px);display:flex;flex-direction:column;gap:10px}.bg-surface .card{background:var(--bg)}.bg-accent .card,.bg-ink .card{background:transparent;border-color:currentColor}
.card .price,.row .price{font-weight:650;color:var(--accent-text)}.bg-accent .price,.bg-ink .price{color:inherit}.card img{border-radius:calc(var(--r) * .7);aspect-ratio:4/3;object-fit:cover;width:100%}
.list .row{display:grid;grid-template-columns:1fr auto;gap:8px 24px;padding:22px 0;border-top:1px solid var(--line)}.list .row:last-child{border-bottom:1px solid var(--line)}.list .row p{grid-column:1/-1;margin:0}
.rows .row{display:grid;grid-template-columns:64px 1fr auto;gap:20px;align-items:baseline;padding:26px 0;border-top:1px solid var(--line)}.rows .num{font:600 ${fs(1)} var(--hf);color:var(--accent-text)}.rows .row p{margin:6px 0 0}
.tiles .card{min-height:240px;justify-content:flex-end}.alternating .alt{display:grid;grid-template-columns:1fr 1fr;gap:clamp(24px,5vw,64px);align-items:center;margin-bottom:56px}.alternating .alt:nth-child(even) .alt-media{order:2}.alternating img{border-radius:var(--r);aspect-ratio:4/3;object-fit:cover;width:100%}
@media(max-width:760px){.alternating .alt{grid-template-columns:1fr}.alternating .alt:nth-child(even) .alt-media{order:0}.rows .row{grid-template-columns:40px 1fr}.rows .price{grid-column:2}}
.feat-inline{display:flex;flex-wrap:wrap;gap:16px 40px}.feat-inline .f{display:flex;gap:12px;align-items:center}.feat-list .f{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;padding:18px 0;border-top:1px solid var(--line)}.feat-list .f p{grid-column:2;margin:0}
.it{display:grid;grid-template-columns:1fr 1fr;gap:clamp(28px,6vw,88px);align-items:center}.it.side-right .it-media{order:2}.it-media img{width:100%;object-fit:cover;aspect-ratio:4/5}@media(max-width:820px){.it{grid-template-columns:1fr}.it.side-right .it-media{order:0}}
.shape-rect img{border-radius:0}.shape-rounded img{border-radius:var(--r)}.shape-arch img{border-radius:999px 999px var(--r) var(--r)}.shape-circle img{border-radius:50%;aspect-ratio:1}
.gal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}.gal-grid img{aspect-ratio:1;object-fit:cover;width:100%;border-radius:calc(var(--r) * .6)}
.gal-masonry{columns:3 260px;column-gap:12px}.gal-masonry img{width:100%;margin-bottom:12px;border-radius:calc(var(--r) * .6);break-inside:avoid}
.gal-strip{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:8px}.gal-strip img{height:340px;width:auto;scroll-snap-align:start;border-radius:calc(var(--r) * .6)}
.gal-feature{display:grid;grid-template-columns:2fr 1fr;gap:12px}.gal-feature img{width:100%;height:100%;object-fit:cover;border-radius:calc(var(--r) * .6)}.gal-feature img:first-child{grid-row:span 2}@media(max-width:700px){.gal-feature{grid-template-columns:1fr}}
.steps-n{counter-reset:s;display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.steps-n .st{counter-increment:s}.steps-n .st::before{content:counter(s,decimal-leading-zero);display:block;font:600 ${fs(1.6)} var(--hf);color:var(--accent-text);margin-bottom:10px}
.steps-t{border-left:2px solid var(--line);padding-left:28px;display:grid;gap:28px}.steps-t .st{position:relative}.steps-t .st::before{content:"";position:absolute;left:-36px;top:6px;width:14px;height:14px;border-radius:50%;background:var(--accent)}
.faq details{border-top:1px solid var(--line);padding:20px 0}.faq details:last-child{border-bottom:1px solid var(--line)}.faq summary{cursor:pointer;font:600 ${fs(0.5)} var(--hf);list-style:none;display:flex;justify-content:space-between;gap:16px}.faq summary::after{content:"+";color:var(--accent-text)}.faq details[open] summary::after{content:"–"}.faq details p{margin:12px 0 0}
.cta-card .wrap>div{background:var(--surface);color:var(--ink);border-radius:var(--r);padding:clamp(32px,5vw,64px)}.cta-card .wrap>div .muted{color:var(--muted);opacity:1}.cta-card .wrap>div .eyebrow{color:var(--accent-text);opacity:1}.cta-card .wrap>div .btn:not(.ghost){background:var(--accent);color:var(--on-accent);border-color:var(--accent)}.cta-split .wrap{display:grid;grid-template-columns:1.2fr .8fr;gap:48px;align-items:center}.cta-split img{border-radius:var(--r);width:100%;aspect-ratio:4/3;object-fit:cover}@media(max-width:760px){.cta-split .wrap{grid-template-columns:1fr}}
.towns{display:flex;flex-wrap:wrap;gap:10px;list-style:none;padding:0;margin:24px 0 0}.towns li{border:1px solid var(--line);border-radius:999px;padding:8px 16px}.al-center .towns{justify-content:center}
.foot{border-top:1px solid var(--line);padding:40px 0;font-size:${fs(-0.4)}}.foot .wrap{display:flex;flex-wrap:wrap;gap:16px 32px;justify-content:space-between;align-items:center}.foot a{color:inherit}.foot-statement .big{font:${t.headingWeight} ${fluid(3)}/1.05 var(--hf);margin-bottom:28px;width:100%}
${composition ? `.zs-display{font-size:${fluid(7)};line-height:.96}.zs-xl{font-size:${fluid(5)};line-height:1.02}.zs-l{font-size:${fluid(3.4)}}.zs-m{font-size:${fs(0.6)}}.zs-s{font-size:${fs(-0.3)}}
.comp .cg{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:clamp(14px,2vw,28px);align-items:start}.cb{position:relative;min-width:0}.cb p{margin:0}.cb .eyebrow{margin:0}
.comp.h-tall,.comp.h-screen{display:flex;flex-direction:column;justify-content:center;padding-block:clamp(32px,6vh,var(--py))}
.cm{position:relative;overflow:hidden;height:100%;min-height:160px}.cm img{width:100%;height:100%;object-fit:cover}.cm.shape-rounded{border-radius:var(--r)}.cm.shape-arch{border-radius:999px 999px var(--r) var(--r)}.cm.shape-circle{border-radius:50%}.cm.shape-rect img,.cm.shape-rounded img,.cm.shape-arch img,.cm.shape-circle img{border-radius:0}
.cm.tr-tint::after,.cm.tr-duo::after,.cm.tr-scrim::after{content:"";position:absolute;inset:0;pointer-events:none}.cm.tr-tint::after{background:var(--accent);mix-blend-mode:multiply;opacity:.35}.cm.tr-duo img{filter:grayscale(1) contrast(1.1)}.cm.tr-duo::after{background:var(--accent);mix-blend-mode:screen;opacity:.55}.cm.tr-scrim::after{background:linear-gradient(180deg,transparent 35%,rgba(0,0,0,.6))}
.mk{font:800 clamp(64px,14vw,240px)/.8 var(--hf);color:var(--line);user-select:none}
@media(min-width:861px){.cb.over{color:#fff;text-shadow:0 1px 18px rgba(0,0,0,.35)}.cb.over .muted,.cb.over .eyebrow{color:#fff;opacity:.92}.cb.over .btn.ghost{color:#fff}.cm.under::before{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(180deg,rgba(0,0,0,.15),rgba(0,0,0,.55))}.cb.raised{background:var(--bg);color:var(--ink);padding:clamp(16px,2.2vw,32px);border-radius:var(--r);box-shadow:0 12px 40px rgba(0,0,0,.12)}.bg-surface .cb.raised{background:var(--surface)}.cb.raised .muted{color:var(--muted)}}
@media(max-width:860px){.comp .cg{grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}}` : ''}
.preview-bar{background:#fff4d6;color:#4a3800;text-align:center;font:500 14px system-ui;padding:8px}.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:16px;z-index:99;background:var(--bg);padding:8px}
${motion}`
}

// biz: { id, name, phone, cities[], services[{name, price}], appointmentMode }
// opts: { page (slug), pageBase ('' on the business's own domain, '/p/<id>' on ours), canonical, bookUrl, privacyUrl, preview, noindex, year }
export function renderV2(biz, spec, opts = {}) {
  const { page = '', pageBase = '', canonical = null, bookUrl = '/book', privacyUrl = '/privacy', preview = false, noindex = false, year = new Date().getUTCFullYear() } = opts
  const pg = spec.pages.find((p) => p.slug === page) || spec.pages[0]
  // pageBase: '' (own domain → /services), '/p/<id>' (→ /p/<id>/services) or a query prefix ending in '=' (private preview).
  const href = (slug) => (pageBase.endsWith('=') ? `${pageBase}${slug}` : slug ? `${pageBase}/${slug}` : pageBase || '/')
  const where = new Map(spec.pages.flatMap((p) => p.sections.map((s) => [s.id, p.slug])))
  const link = (target) => {
    if (!target || target === 'book') return esc(bookUrl)
    if (target.startsWith('page:')) return esc(href(target.slice(5)))
    const id = target.slice(8)
    return where.get(id) === pg.slug ? `#${esc(id)}` : `${esc(href(where.get(id) ?? ''))}#${esc(id)}`
  }
  const button = (c, ghost = false) => (c ? `<a class="btn${ghost ? ' ghost' : ''}" href="${link(c.target)}">${esc(c.label)}</a>` : '')
  const visit = biz.appointmentMode === 'at_customer'
  const head = (s, tag = 'h2') => (s.heading || s.eyebrow || s.text ? `<div class="head">${s.eyebrow ? `<p class="eyebrow">${esc(s.eyebrow)}</p>` : ''}${s.heading ? `<${tag} id="h-${esc(s.id)}">${esc(s.heading)}</${tag}>` : ''}${s.text ? `<div class="muted">${paras(s.text)}</div>` : ''}</div>` : '')
  const svc = (it) => biz.services?.[it.serviceIndex] || { name: '', price: '' }
  let first = true
  // Placement rules for composition blocks, generated from validated numbers/enums only (section ids are slugs).
  const blockCss = []
  const ASPECT = { '1x1': '1/1', '4x5': '4/5', '3x4': '3/4', '4x3': '4/3', '3x2': '3/2', '16x9': '16/9', '21x9': '21/9' }
  const composition = (s, cls) => {
    // Desktop overlaps stay readable: text fully on a photo → white text over a darkening layer; text partly over a
    // photo → a solid card behind it. Phones stack the blocks, so nothing overlaps there.
    const media = s.blocks.filter((b) => b.kind === 'media')
    const hit = (a, m) => a.col[0] < m.col[0] + m.col[1] && m.col[0] < a.col[0] + a.col[1] && a.row[0] < m.row[0] + m.row[1] && m.row[0] < a.row[0] + a.row[1] && a.z > m.z
    const inside = (a, m) => a.col[0] >= m.col[0] && a.col[0] + a.col[1] <= m.col[0] + m.col[1] && a.row[0] >= m.row[0] && a.row[0] + a.row[1] <= m.row[0] + m.row[1]
    const words = s.blocks.filter((b) => b.kind !== 'media' && b.kind !== 'mark')
    const over = new Set(words.filter((b) => media.some((m) => hit(b, m) && inside(b, m))))
    const raised = new Set(words.filter((b) => !over.has(b) && media.some((m) => hit(b, m))))
    const under = new Set(media.filter((m) => [...over].some((b) => hit(b, m))))
    const eager = first
    let labelled = ''
    const html = s.blocks
      .map((b, i) => {
        const sel = `#${s.id} .cg>.cb:nth-child(${i + 1})`
        const box = b.kind === 'button' || b.kind === 'mark'
        blockCss.push(`${sel}{grid-column:${b.col[0]} / span ${b.col[1]};grid-row:${b.row[0]} / span ${b.row[1]};z-index:${b.z};align-self:${b.kind === 'media' && b.aspect === 'auto' ? 'stretch' : b.y};justify-self:${box ? b.x : 'stretch'};text-align:${b.x === 'end' ? 'right' : b.x === 'center' ? 'center' : 'left'}}`)
        if (b.kind === 'media') blockCss.push(`${sel} .cm${ASPECT[b.aspect] ? `{aspect-ratio:${ASPECT[b.aspect]}}` : '{min-height:320px}'}${sel} img{object-position:${b.focus[0]}% ${b.focus[1]}%}`)
        blockCss.push(`@media(max-width:860px){${sel}{grid-column:span ${b.m.span};grid-row:auto;order:${b.m.order};text-align:${b.x === 'center' ? 'center' : 'left'}${b.m.hide ? ';display:none' : ''}}}`)
        let inner = ''
        if (b.kind === 'heading') {
          const tag = first ? 'h1' : 'h2'
          first = false
          const hid = labelled ? '' : ` id="h-${esc(s.id)}"`
          if (!labelled) labelled = `h-${s.id}`
          inner = `<${tag}${hid} class="zs-${b.size}">${esc(b.text)}</${tag}>`
        } else if (b.kind === 'text') inner = b.size === 's' ? `<p class="eyebrow">${esc(b.text)}</p>` : `<p class="zs-${b.size}${b.size === 'm' ? ' muted' : ''}">${esc(b.text)}</p>`
        else if (b.kind === 'button') inner = `<a class="btn${b.secondary ? ' ghost' : ''}" href="${link(b.target)}">${esc(b.label)}</a>`
        else if (b.kind === 'media') inner = `<div class="cm shape-${b.shape} tr-${b.treat}${under.has(b) ? ' under' : ''}">${image(b.image, { alt: b.alt, eager, sizes: `(max-width:860px) 100vw, ${Math.max(25, Math.round((b.col[1] / 12) * 100))}vw` })}</div>`
        else inner = `<div class="mk" aria-hidden="true">${esc(b.text)}</div>`
        return `<div class="cb${over.has(b) ? ' over' : raised.has(b) ? ' raised' : ''}">${inner}</div>`
      })
      .join('')
    return `<section id="${esc(s.id)}" class="${cls} comp h-${s.height}"${labelled ? ` aria-labelledby="${esc(labelled)}"` : ''}><div class="wrap cg">${html}</div></section>`
  }

  const section = (s) => {
    const cls = `sec sp-${s.spacing} bg-${s.background} al-${s.align} w-${s.width}${s.animate !== 'none' && spec.theme.motion !== 'none' ? ` anim-${s.animate}` : ''}`
    const bgImg = s.background === 'image' && s.backgroundImage ? `<div class="bgimg" aria-hidden="true">${image(s.backgroundImage)}</div>` : ''
    const open = (extra = '', label = true) => `<section id="${esc(s.id)}" class="${cls}${extra}"${label && s.heading ? ` aria-labelledby="h-${esc(s.id)}"` : ''}>${bgImg}`
    switch (s.type) {
      case 'composition':
        return composition(s, cls)
      case 'hero': {
        const tag = first ? 'h1' : 'h2'
        first = false
        const copy = `<div class="hero-copy">${s.eyebrow ? `<p class="eyebrow">${esc(s.eyebrow)}</p>` : ''}<${tag} id="h-${esc(s.id)}">${esc(s.heading)}</${tag}>${s.text ? `<p class="sub${s.layout === 'overlay' ? '' : ' muted'}">${esc(s.text.replace(/\n+/g, ' '))}</p>` : ''}<div class="actions">${button(s.primaryCta)}${button(s.secondaryCta, true)}</div></div>`
        const media = s.layout === 'mosaic' && s.images.length ? `<div class="mosaic">${s.images.map((im, i) => image(im, { eager: i === 0, sizes: '(max-width:860px) 100vw, 50vw' })).join('')}</div>` : s.image ? `<div class="hero-media">${image(s.image, { alt: s.imageAlt, eager: true, sizes: s.layout === 'split' ? '(max-width:860px) 100vw, 50vw' : '100vw' })}</div>` : ''
        if (s.layout === 'overlay' && s.image) return `<section id="${esc(s.id)}" class="hero ${cls.replace(/bg-\w+/, '')} l-overlay h-${s.height}" style="--ov:${s.overlay}" aria-labelledby="h-${esc(s.id)}"><div class="hero-bg">${image(s.image, { alt: s.imageAlt, eager: true })}</div><div class="wrap">${copy}</div></section>`
        const layout = s.layout === 'overlay' ? 'minimal' : s.layout
        if (layout === 'editorial') return `<section id="${esc(s.id)}" class="hero ${cls} l-editorial h-${s.height}" aria-labelledby="h-${esc(s.id)}">${bgImg}<div class="wrap"><div class="hero-copy"><div>${s.eyebrow ? `<p class="eyebrow">${esc(s.eyebrow)}</p>` : ''}<${tag} id="h-${esc(s.id)}">${esc(s.heading)}</${tag}></div><div>${s.text ? `<p class="sub muted">${esc(s.text.replace(/\n+/g, ' '))}</p>` : ''}<div class="actions">${button(s.primaryCta)}${button(s.secondaryCta, true)}</div></div></div>${media}</div></section>`
        return `<section id="${esc(s.id)}" class="hero ${cls} l-${layout} side-${s.imageSide} h-${s.height}" aria-labelledby="h-${esc(s.id)}">${bgImg}<div class="wrap">${copy}${layout === 'minimal' ? '' : media}</div></section>`
      }
      case 'text':
        return `${open()}<div class="wrap">${head({ ...s, text: '' })}<div class="${s.lead ? 'lead ' : ''}${s.columns === 2 ? 'grid" style="--cols:2' : ''}">${paras(s.body || s.text)}</div></div></section>`
      case 'services': {
        const items = s.items.map((it, i) => ({ ...it, ...svc(it), n: i + 1 }))
        const price = (it) => (s.showPrices && it.price ? `<span class="price">${esc(it.price)}</span>` : '')
        let body
        if (s.layout === 'list') body = `<div class="list">${items.map((it) => `<div class="row"><h3>${esc(it.name)}</h3>${price(it)}${it.text ? `<p class="muted">${esc(it.text)}</p>` : ''}</div>`).join('')}</div>`
        else if (s.layout === 'rows') body = `<div class="rows">${items.map((it) => `<div class="row"><span class="num">${String(it.n).padStart(2, '0')}</span><div><h3>${esc(it.name)}</h3>${it.text ? `<p class="muted">${esc(it.text)}</p>` : ''}</div>${price(it)}</div>`).join('')}</div>`
        else if (s.layout === 'alternating') body = `<div class="alternating">${items.map((it) => `<div class="alt">${it.image ? `<div class="alt-media">${image(it.image, { sizes: '(max-width:760px) 100vw, 50vw' })}</div>` : ''}<div>${icon(it.icon)}<h3>${esc(it.name)}</h3>${price(it)}${it.text ? `<p class="muted">${esc(it.text)}</p>` : ''}<div class="actions">${button({ label: visit ? 'Book a visit' : 'Book', target: 'book' })}</div></div></div>`).join('')}</div>`
        else body = `<div class="grid ${s.layout}" style="--cols:${s.columns}">${items.map((it) => `<div class="card">${it.image ? image(it.image, { sizes: '(max-width:600px) 100vw, 33vw' }) : icon(it.icon)}<h3>${esc(it.name)}</h3>${price(it)}${it.text ? `<p class="muted">${esc(it.text)}</p>` : ''}</div>`).join('')}</div>`
        return `${open()}<div class="wrap">${head(s)}${body}</div></section>`
      }
      case 'features': {
        const body =
          s.layout === 'inline'
            ? `<div class="feat-inline">${s.items.map((f) => `<div class="f">${icon(f.icon)}<strong>${esc(f.title)}</strong></div>`).join('')}</div>`
            : s.layout === 'list'
              ? `<div class="feat-list">${s.items.map((f) => `<div class="f">${icon(f.icon)}<h3>${esc(f.title)}</h3>${f.text ? `<p class="muted">${esc(f.text)}</p>` : ''}</div>`).join('')}</div>`
              : `<div class="grid" style="--cols:${s.columns}">${s.items.map((f) => `<div>${icon(f.icon)}<h3 style="margin-top:14px">${esc(f.title)}</h3>${f.text ? `<p class="muted" style="margin-top:8px">${esc(f.text)}</p>` : ''}</div>`).join('')}</div>`
        return `${open()}<div class="wrap">${head(s)}${body}</div></section>`
      }
      case 'imageText':
        return `${open()}<div class="wrap"><div class="it side-${s.imageSide}">${s.image ? `<div class="it-media shape-${s.imageShape}">${image(s.image, { alt: s.imageAlt, sizes: '(max-width:820px) 100vw, 50vw' })}</div>` : ''}<div>${head({ ...s, text: '' })}${paras(s.body || s.text)}${s.cta ? `<div class="actions">${button(s.cta)}</div>` : ''}</div></div></div></section>`
      case 'gallery':
        return `${open()}<div class="wrap">${head(s)}<div class="gal-${s.layout}">${s.images.map((im) => image(im, { alt: `Work by ${biz.name}`, sizes: '(max-width:700px) 100vw, 33vw' })).join('')}</div></div></section>`
      case 'steps':
        return `${open()}<div class="wrap">${head(s)}<div class="${s.layout === 'timeline' ? 'steps-t' : 'steps-n'}">${s.items.map((x) => `<div class="st"><h3>${esc(x.title)}</h3>${x.text ? `<p class="muted" style="margin-top:8px">${esc(x.text)}</p>` : ''}</div>`).join('')}</div></div></section>`
      case 'faq':
        return `${open(' faq')}<div class="wrap">${head(s)}${s.items.map((x) => `<details><summary>${esc(x.question)}</summary><p class="muted">${esc(x.answer)}</p></details>`).join('')}</div></section>`
      case 'cta': {
        const inner = `<div>${s.eyebrow ? `<p class="eyebrow">${esc(s.eyebrow)}</p>` : ''}<h2 id="h-${esc(s.id)}">${esc(s.heading)}</h2>${s.text ? `<div class="muted" style="margin-top:14px">${paras(s.text)}</div>` : ''}<div class="actions">${button(s.cta)}</div></div>`
        return `${open(` cta-${s.layout}`)}<div class="wrap">${inner}${s.layout === 'split' && s.image ? image(s.image, { sizes: '(max-width:760px) 100vw, 40vw' }) : ''}</div></section>`
      }
      case 'area':
        return `${open()}<div class="wrap">${head({ ...s, heading: s.heading || 'Where we work' })}${biz.cities?.length ? `<ul class="towns">${biz.cities.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</div></section>`
      case 'contact':
        return `${open()}<div class="wrap">${head({ ...s, heading: s.heading || 'Get in touch' })}<div class="actions">${button({ label: visit ? 'Book a visit' : 'Book online', target: 'book' })}${s.showPhone && biz.phone ? `<a class="btn ghost" href="tel:${esc(biz.phone.replace(/[^\d+]/g, ''))}">${esc(biz.phone)}</a>` : ''}</div></div></section>`
    }
    return ''
  }

  const body = pg.sections.map(section).join('')
  const navLinks = spec.pages.length > 1 ? `<ul>${spec.pages.map((p) => `<li><a href="${esc(href(p.slug))}"${p.slug === pg.slug ? ' aria-current="page"' : ''}>${esc(p.navLabel)}</a></li>`).join('')}</ul>` : ''
  const nav = `<header class="nav nav-${spec.nav.layout}${spec.nav.sticky ? ' sticky' : ''}"><div class="wrap"><a class="brand" href="${esc(href(''))}">${esc(biz.name)}</a>${navLinks}${spec.nav.showBook ? `<a class="btn" href="${esc(bookUrl)}">${visit ? 'Book a visit' : 'Book'}</a>` : ''}</div></header>`
  const foot = `<footer class="foot foot-${spec.footer.layout}"><div class="wrap">${spec.footer.layout === 'statement' ? `<p class="big">${esc(spec.footer.text || biz.name)}</p>` : ''}<span>© ${year} ${esc(biz.name)}${spec.footer.layout !== 'statement' && spec.footer.text ? ` · ${esc(spec.footer.text)}` : ''}</span><span><a href="${esc(privacyUrl)}">Privacy</a> · Website by GetShowUps</span></div></footer>`
  const title = pg.seoTitle || (pg.slug ? `${pg.navLabel} · ${biz.name}` : biz.name)
  const desc = pg.seoDescription || spec.pages[0].seoDescription || ''
  const schema = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: biz.name, ...(canonical ? { url: canonical } : {}), ...(biz.phone ? { telephone: biz.phone } : {}), ...(biz.cities?.length ? { areaServed: biz.cities } : {}) }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${desc ? `<meta name="description" content="${esc(desc)}">` : ''}${preview || noindex ? '<meta name="robots" content="noindex">' : ''}${!preview && canonical ? `<link rel="canonical" href="${esc(pg.slug ? `${canonical.replace(/\/$/, '')}/${pg.slug}` : canonical)}">` : ''}<meta name="theme-color" content="${spec.theme.colors.bg}"><style>${css(spec.theme, { composition: blockCss.length > 0 })}${blockCss.join("")}</style><script type="application/ld+json">${ld(schema)}</script></head><body><a class="skip" href="#main">Skip to content</a>${preview ? '<div class="preview-bar">Preview. Only you can see this.</div>' : ''}${nav}<main id="main">${body}</main>${foot}</body></html>`
}

export { FONTS }
