// Website design specification v2: what the AI designer (server/ai-designer.js) writes and server/site-render-v2.js
// renders. The model designs the site: pages, which sections and in what order, their composition (layouts, columns,
// alignment, width, backgrounds, image placement and shape), the theme (any colours, type pairing and scale, weight,
// case, spacing density, radius, button style, motion) and all the words. It never writes HTML, CSS, scripts or URLs:
// every value is data from this schema, and validateSpec() enforces it deterministically:
//   - unknown fields are dropped; numbers are clamped; unknown enums fall back to defaults; broken sections are dropped
//   - colours are checked for WCAG AA contrast and repaired (never rejected)
//   - images: the business's own uploads ('asset:<id>', must belong to it) or the licensed stock library ('stock:<id>')
//   - links: only to booking, a page of this site, or a section of a page (no external URLs)
//   - business facts (service names, prices, phone, towns) are referenced from records, never typed by the model
//   - every text passes the claims filter (and, for AI output, the invented-number check) or is removed
//   - resource limits: pages, sections, items, text lengths, total size
import { unapprovedClaims } from './ads/spec.js'
import { STOCK_IDS } from './site-design.js'

export const SPEC_VERSION = 2
export const FONTS = {
  'space-grotesk': { label: 'Space Grotesk', kind: 'sans' },
  inter: { label: 'Inter', kind: 'sans' },
  'dm-sans': { label: 'DM Sans', kind: 'sans' },
  manrope: { label: 'Manrope', kind: 'sans' },
  outfit: { label: 'Outfit', kind: 'sans' },
  archivo: { label: 'Archivo', kind: 'sans' },
  'bricolage-grotesque': { label: 'Bricolage Grotesque', kind: 'display' },
  syne: { label: 'Syne', kind: 'display' },
  fraunces: { label: 'Fraunces', kind: 'serif' },
  'playfair-display': { label: 'Playfair Display', kind: 'serif' },
  'cormorant-garamond': { label: 'Cormorant Garamond', kind: 'serif' },
}
// Icons we draw ourselves (inline SVG paths in the renderer). No icon implies a claim (no stars, shields, badges).
export const ICONS = ['water', 'drop', 'leaf', 'sun', 'snow', 'calendar', 'clock', 'check', 'map-pin', 'phone', 'home', 'wrench', 'brush', 'sparkle', 'filter', 'thermometer', 'chat', 'truck', 'heart', 'arrow']
// 'composition': a free 12-column arrangement of a few blocks (heading, text, button, media, mark) for the first screen
// and signature moments. The model places blocks; the renderer derives phone layouts and keeps overlaps readable.
export const SECTION_TYPES = ['hero', 'composition', 'text', 'services', 'features', 'imageText', 'gallery', 'steps', 'faq', 'cta', 'area', 'contact']
export const LIMITS = { pages: 5, sectionsPerPage: 12, sections: 36, items: 10, blocks: 10, galleryImages: 12, specBytes: 80_000, heading: 120, eyebrow: 60, text: 900, body: 2400, label: 32, itemTitle: 80, itemText: 400, navLabel: 24, seoTitle: 70, seoDescription: 160, footer: 200, alt: 140, name: 40, direction: 160 }

const ENUM = {
  headingCase: ['none', 'upper'],
  density: ['compact', 'comfortable', 'airy'],
  buttons: ['solid', 'outline', 'pill', 'underline'],
  motion: ['none', 'subtle', 'expressive'],
  navLayout: ['left', 'center', 'split'],
  footerLayout: ['simple', 'columns', 'statement'],
  background: ['bg', 'surface', 'accent', 'ink', 'image'],
  spacing: ['s', 'm', 'l', 'xl'],
  align: ['left', 'center'],
  width: ['narrow', 'normal', 'wide', 'full'],
  animate: ['none', 'fade', 'rise'],
  heroLayout: ['split', 'overlay', 'stacked', 'editorial', 'minimal', 'mosaic'],
  heroHeight: ['auto', 'tall', 'screen'],
  side: ['left', 'right'],
  servicesLayout: ['cards', 'list', 'rows', 'tiles', 'alternating'],
  featuresLayout: ['grid', 'list', 'inline'],
  imageShape: ['rect', 'rounded', 'arch', 'circle'],
  galleryLayout: ['grid', 'masonry', 'strip', 'feature'],
  stepsLayout: ['numbered', 'timeline'],
  ctaLayout: ['band', 'card', 'split'],
  // composition blocks
  blockKind: ['heading', 'text', 'button', 'media', 'mark'],
  size: ['display', 'xl', 'l', 'm', 's'],
  x: ['start', 'center', 'end'],
  y: ['start', 'center', 'end', 'stretch'],
  aspect: ['auto', '1x1', '4x5', '3x4', '4x3', '3x2', '16x9', '21x9'],
  treat: ['none', 'tint', 'duo', 'scrim'],
}
export const COMPOSITION = ENUM // read by the designer's prompt/schema and the renderer

// ---------- helpers ----------
const HEX = /^#[0-9a-f]{6}$/i
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const ASSET = /^asset:[a-f0-9]{32}$/
const printable = (s) => Array.from(String(s ?? '')).map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('')
const clean = (s) => printable(s).replace(/\s+/g, ' ').trim()
const cleanBody = (s) =>
  String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map(clean)
    .filter(Boolean)
    .join('\n\n')
const pick = (v, list, def) => (list.includes(v) ? v : def)
const clamp = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def)
const bool = (v, def = false) => (typeof v === 'boolean' ? v : def)
const arr = (v) => (Array.isArray(v) ? v : [])

// WCAG relative luminance / contrast.
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const mix = (a, b, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('')
// Moves `fg` towards black or white (whichever helps) until it reaches `ratio` against `bg`.
function ensure(fg, bg, ratio) {
  if (contrast(fg, bg) >= ratio) return fg
  const target = lum(bg) > 0.4 ? '#000000' : '#ffffff'
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const c = mix(fg, target, t)
    if (contrast(c, bg) >= ratio) return c
  }
  return target
}

// ---------- validation ----------
// ctx: { assetIds: Set, services: [{name, price}], claims: [], factsText: string|null (AI output: numbers must appear in it) }
// Returns { spec, warnings[] }: always a renderable spec (repairs instead of failing).
export function validateSpec(raw, ctx = {}) {
  const warnings = []
  const r = raw && typeof raw === 'object' ? raw : {}
  const assets = ctx.assetIds || new Set()
  const claims = ctx.claims || []
  const services = ctx.services || []
  const numbersOk = (t) => {
    if (!ctx.factsText) return true
    const facts = ctx.factsText.replace(/[,\s]/g, '')
    return (String(t).match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[.,]+$/, '').replace(/,/g, '')).every((n) => facts.includes(n))
  }
  // Text gate: limits + claims filter + invented numbers. A failing text becomes '' (and is reported).
  const txt = (v, max, where, body = false) => {
    const s = (body ? cleanBody : clean)(v)
    if (!s) return ''
    if (s.length > max) {
      warnings.push({ where, reason: 'too_long' })
      return ''
    }
    if (unapprovedClaims(s, claims).length) {
      warnings.push({ where, reason: 'claim' })
      return ''
    }
    if (!numbersOk(s)) {
      warnings.push({ where, reason: 'invented_number' })
      return ''
    }
    return s
  }
  const img = (v, where) => {
    if (v == null || v === '' || v === 'none') return null
    const s = String(v)
    if (ASSET.test(s) && assets.has(s.slice(6))) return s
    if (s.startsWith('stock:') && STOCK_IDS.has(s.slice(6))) return s
    warnings.push({ where, reason: 'image' })
    return null
  }

  // A choice the model made that isn't on its list is REPORTED (invalid_choice), not silently swapped for the generic
  // default: the designer's quality check counts these, so a broken answer can't pass as a finished design.
  // A missing/"" value is a deliberate "use the default".
  const choose = (v, list, def, where) => {
    if (v == null || v === '') return def
    if (list.includes(v)) return v
    warnings.push({ where, reason: 'invalid_choice' })
    return def
  }

  // Theme
  const t = r.theme && typeof r.theme === 'object' ? r.theme : {}
  const c = t.colors && typeof t.colors === 'object' ? t.colors : {}
  const hex = (v, def) => (HEX.test(String(v)) ? String(v).toLowerCase() : def)
  const bg = hex(c.bg, '#ffffff')
  const dark = lum(bg) < 0.2
  const colors = { bg, surface: hex(c.surface, dark ? mix(bg, '#ffffff', 0.06) : mix(bg, '#000000', 0.04)) }
  colors.ink = ensure(hex(c.ink, dark ? '#f5f5f2' : '#141414'), bg, 7)
  colors.ink = ensure(colors.ink, colors.surface, 4.5)
  colors.muted = ensure(ensure(hex(c.muted, mix(colors.ink, bg, 0.35)), bg, 4.5), colors.surface, 4.5)
  colors.accent = hex(c.accent, dark ? '#5fd4d0' : '#1d5fa8')
  colors.onAccent = contrast('#ffffff', colors.accent) >= contrast('#000000', colors.accent) ? ensure(hex(c.onAccent, '#ffffff'), colors.accent, 4.5) : ensure(hex(c.onAccent, '#0b0b0b'), colors.accent, 4.5)
  colors.line = hex(c.line, mix(bg, colors.ink, 0.14))
  // Accent used as text on the page background (links, eyebrows) must be readable too.
  colors.accentText = ensure(colors.accent, bg, 4.5)
  const theme = {
    colors,
    headingFont: choose(t.headingFont, Object.keys(FONTS), 'space-grotesk', 'theme.headingFont'),
    bodyFont: choose(t.bodyFont, Object.keys(FONTS).filter((k) => FONTS[k].kind !== 'display'), 'inter', 'theme.bodyFont'),
    headingWeight: Math.round(clamp(t.headingWeight, 300, 900, 700) / 50) * 50,
    headingCase: choose(t.headingCase, ENUM.headingCase, 'none', 'theme.headingCase'),
    headingTracking: clamp(t.headingTracking, -0.06, 0.12, -0.02),
    baseSize: clamp(t.baseSize, 15, 20, 17),
    scale: clamp(t.scale, 1.12, 1.6, 1.25),
    lineHeight: clamp(t.lineHeight, 1.35, 1.85, 1.6),
    radius: Math.round(clamp(t.radius, 0, 40, 12)),
    density: choose(t.density, ENUM.density, 'comfortable', 'theme.density'),
    maxWidth: Math.round(clamp(t.maxWidth, 960, 1440, 1180)),
    buttons: choose(t.buttons, ENUM.buttons, 'solid', 'theme.buttons'),
    motion: choose(t.motion, ENUM.motion, 'subtle', 'theme.motion'),
  }

  // Pages (home first, unique slugs).
  const slugs = new Set()
  const pagesIn = arr(r.pages).slice(0, LIMITS.pages)
  if (arr(r.pages).length > LIMITS.pages) warnings.push({ where: 'pages', reason: 'limit' })
  const pages = []
  for (const [pi, p] of pagesIn.entries()) {
    if (!p || typeof p !== 'object') continue
    const slug = pi === 0 ? '' : clean(p.slug).toLowerCase()
    if (pi > 0 && (!SLUG.test(slug) || slugs.has(slug) || ['p', 'book', 'api', 'dashboard', 'site-assets', 'site-stock', 'site-fonts'].includes(slug))) {
      warnings.push({ where: `pages.${pi}`, reason: 'slug' })
      continue
    }
    slugs.add(slug)
    pages.push({ p, slug, pi })
  }
  const ids = new Set()
  const target = (v, where) => {
    const s = clean(v)
    if (s === 'book') return 'book'
    if (s.startsWith('page:') && (s.slice(5) === '' || slugs.has(s.slice(5)))) return s
    if (s.startsWith('section:') && SLUG.test(s.slice(8))) return s
    if (s) warnings.push({ where, reason: 'link' })
    return 'book'
  }
  const cta = (v, where) => {
    if (!v || typeof v !== 'object') return null
    const label = txt(v.label, LIMITS.label, `${where}.label`)
    return label ? { label, target: target(v.target, `${where}.target`) } : null
  }
  let total = 0
  const outPages = []
  for (const { p, slug, pi } of pages) {
    const sections = []
    for (const [si, s] of arr(p.sections).slice(0, LIMITS.sectionsPerPage).entries()) {
      if (total >= LIMITS.sections) {
        warnings.push({ where: 'sections', reason: 'limit' })
        break
      }
      const where = `pages.${pi}.sections.${si}`
      if (!s || typeof s !== 'object' || !SECTION_TYPES.includes(s.type)) {
        warnings.push({ where, reason: 'type' })
        continue
      }
      let id = SLUG.test(clean(s.id).toLowerCase()) ? clean(s.id).toLowerCase() : `${s.type.toLowerCase()}-${si + 1}`
      while (ids.has(id)) id = `${id}-x`
      ids.add(id)
      const base = {
        type: s.type,
        id,
        background: choose(s.background, ENUM.background, 'bg', `${where}.background`),
        backgroundImage: img(s.backgroundImage, `${where}.backgroundImage`),
        spacing: choose(s.spacing, ENUM.spacing, 'l', `${where}.spacing`),
        align: choose(s.align, ENUM.align, 'left', `${where}.align`),
        width: choose(s.width, ENUM.width, 'normal', `${where}.width`),
        animate: choose(s.animate, ENUM.animate, 'none', `${where}.animate`),
        heading: txt(s.heading, LIMITS.heading, `${where}.heading`),
        eyebrow: txt(s.eyebrow, LIMITS.eyebrow, `${where}.eyebrow`),
        text: txt(s.text, LIMITS.text, `${where}.text`, true),
      }
      if (base.background === 'image' && !base.backgroundImage) base.background = 'ink'
      const items = (max) => arr(s.items).slice(0, max)
      let out = null
      switch (s.type) {
        case 'hero': {
          const images = arr(s.images).map((v, i) => img(v, `${where}.images.${i}`)).filter(Boolean).slice(0, 3)
          out = { ...base, layout: choose(s.layout, ENUM.heroLayout, 'split', `${where}.layout`), image: img(s.image, `${where}.image`), images, imageAlt: txt(s.imageAlt, LIMITS.alt, `${where}.imageAlt`), imageSide: choose(s.imageSide, ENUM.side, 'right', `${where}.imageSide`), height: choose(s.height, ENUM.heroHeight, 'tall', `${where}.height`), overlay: clamp(s.overlay, 0, 0.85, 0.45), primaryCta: cta(s.primaryCta, `${where}.primaryCta`) || { label: 'Book now', target: 'book' }, secondaryCta: cta(s.secondaryCta, `${where}.secondaryCta`) }
          if (!out.heading) out.heading = ctx.brand || 'Welcome'
          break
        }
        case 'composition': {
          // Blocks on a 12-column grid (rows 1–6). Every number is range-checked, every choice is from its list (invalid
          // ones are reported), text passes the same gates as everywhere else, images are own/stock refs, buttons link
          // only to booking/pages/sections. Decorative marks are 1–3 symbols/letters, or the number of services.
          const num = (v, lo, hi, def, w) => {
            if (v == null) return def
            if (Number.isInteger(v) && v >= lo && v <= hi) return v
            warnings.push({ where: w, reason: 'invalid_choice' })
            return def
          }
          // A block dropped for missing content is reported too (a gated text/image already reported its own reason).
          const empty = (w, v) => {
            if (v == null || String(v).trim() === '') warnings.push({ where: w, reason: 'empty_block' })
            return null
          }
          const blocks = arr(s.blocks)
            .slice(0, LIMITS.blocks)
            .map((b, bi) => {
              const w = `${where}.blocks.${bi}`
              if (!b || typeof b !== 'object' || !ENUM.blockKind.includes(b.kind)) {
                warnings.push({ where: w, reason: 'invalid_choice' })
                return null
              }
              for (const bad of arr(b.invalid)) warnings.push({ where: `${w}.${String(bad).slice(0, 24)}`, reason: 'invalid_choice' })
              const cs = num(b.col?.[0], 1, 12, 1, `${w}.col`)
              const rs = num(b.row?.[0], 1, 6, 1, `${w}.row`)
              const out = {
                kind: b.kind,
                col: [cs, num(b.col?.[1], 1, 13 - cs, 13 - cs, `${w}.col`)],
                row: [rs, num(b.row?.[1], 1, 7 - rs, 1, `${w}.row`)],
                z: num(b.z, 0, 2, 0, `${w}.z`),
                x: choose(b.x, ENUM.x, 'start', `${w}.x`),
                y: choose(b.y, ENUM.y, 'start', `${w}.y`),
                size: choose(b.size, ENUM.size, b.kind === 'heading' ? 'xl' : 'm', `${w}.size`),
                m: { order: num(b.m?.order, 0, 20, bi, `${w}.m.order`), span: num(b.m?.span, 1, 4, 4, `${w}.m.span`), hide: (b.kind === 'media' || b.kind === 'mark') && bool(b.m?.hide) },
              }
              if (b.kind === 'heading' || b.kind === 'text') {
                out.text = txt(b.text, b.kind === 'heading' ? LIMITS.heading : LIMITS.text, `${w}.text`)
                if (!out.text) return empty(w, b.text)
              } else if (b.kind === 'button') {
                out.label = txt(b.label, LIMITS.label, `${w}.label`)
                if (!out.label) return empty(w, b.label)
                out.target = target(b.target, `${w}.target`)
                out.secondary = bool(b.secondary)
              } else if (b.kind === 'media') {
                out.image = img(b.image, `${w}.image`)
                if (!out.image) return empty(w, b.image)
                out.alt = txt(b.alt, LIMITS.alt, `${w}.alt`)
                out.aspect = choose(b.aspect, ENUM.aspect, '4x5', `${w}.aspect`)
                out.focus = [Math.round(clamp(b.focus?.[0], 0, 100, 50)), Math.round(clamp(b.focus?.[1], 0, 100, 50))]
                out.shape = choose(b.shape, ENUM.imageShape, 'rect', `${w}.shape`)
                out.treat = choose(b.treat, ENUM.treat, 'none', `${w}.treat`)
              } else {
                const mark = clean(b.text)
                const count = String(services.length)
                if (!(/^[A-Za-z&§·•*+~→↗]{1,3}$/.test(mark) || (services.length && (mark === count || mark === count.padStart(2, '0'))))) {
                  warnings.push({ where: `${w}.text`, reason: 'mark' })
                  return null
                }
                out.text = mark
              }
              return out
            })
            .filter(Boolean)
          out = blocks.some((b) => b.kind === 'heading' || b.kind === 'media') ? { ...base, height: choose(s.height, ENUM.heroHeight, 'auto', `${where}.height`), blocks } : null
          break
        }
        case 'text':
          out = { ...base, body: txt(s.body, LIMITS.body, `${where}.body`, true), columns: clamp(s.columns, 1, 2, 1) | 0, lead: bool(s.lead) }
          if (!out.body && !out.heading) out = null
          break
        case 'services': {
          const list = items(LIMITS.items)
            .map((x, i) => {
              const idx = Number.isInteger(x?.serviceIndex) ? x.serviceIndex : -1
              if (!services[idx]) return null
              return { serviceIndex: idx, text: txt(x.text, LIMITS.itemText, `${where}.items.${i}.text`), icon: pick(x?.icon, ICONS, null), image: img(x?.image, `${where}.items.${i}.image`) }
            })
            .filter(Boolean)
            .filter((x, i, all) => all.findIndex((y) => y.serviceIndex === x.serviceIndex) === i)
          // Every service the business offers appears (the AI may order and describe them, not drop them).
          for (const [i] of services.entries()) if (!list.some((x) => x.serviceIndex === i)) list.push({ serviceIndex: i, text: '', icon: null, image: null })
          out = { ...base, layout: choose(s.layout, ENUM.servicesLayout, 'cards', `${where}.layout`), columns: clamp(s.columns, 1, 4, 3) | 0, showPrices: bool(s.showPrices, true), items: list }
          if (!list.length) out = null
          break
        }
        case 'features': {
          const list = items(8)
            .map((x, i) => ({ icon: pick(x?.icon, ICONS, null), title: txt(x?.title, LIMITS.itemTitle, `${where}.items.${i}.title`), text: txt(x?.text, LIMITS.itemText, `${where}.items.${i}.text`) }))
            .filter((x) => x.title)
          out = list.length ? { ...base, layout: choose(s.layout, ENUM.featuresLayout, 'grid', `${where}.layout`), columns: clamp(s.columns, 2, 4, 3) | 0, items: list } : null
          break
        }
        case 'imageText':
          out = { ...base, body: txt(s.body, LIMITS.body, `${where}.body`, true), image: img(s.image, `${where}.image`), imageAlt: txt(s.imageAlt, LIMITS.alt, `${where}.imageAlt`), imageSide: choose(s.imageSide, ENUM.side, 'left', `${where}.imageSide`), imageShape: choose(s.imageShape, ENUM.imageShape, 'rounded', `${where}.imageShape`), cta: cta(s.cta, `${where}.cta`) }
          if (!out.image && !out.body) out = null
          break
        case 'gallery': {
          // Gallery = the business's OWN work only (never stock photos).
          const images = arr(s.images).map((v, i) => img(v, `${where}.images.${i}`)).filter((v) => v && v.startsWith('asset:')).slice(0, LIMITS.galleryImages)
          out = images.length ? { ...base, layout: choose(s.layout, ENUM.galleryLayout, 'grid', `${where}.layout`), images } : null
          break
        }
        case 'steps': {
          const list = items(6)
            .map((x, i) => ({ title: txt(x?.title, LIMITS.itemTitle, `${where}.items.${i}.title`), text: txt(x?.text, LIMITS.itemText, `${where}.items.${i}.text`) }))
            .filter((x) => x.title)
          out = list.length ? { ...base, layout: choose(s.layout, ENUM.stepsLayout, 'numbered', `${where}.layout`), items: list } : null
          break
        }
        case 'faq': {
          const list = items(LIMITS.items)
            .map((x, i) => ({ question: txt(x?.question, LIMITS.itemTitle * 2, `${where}.items.${i}.question`), answer: txt(x?.answer, LIMITS.itemText, `${where}.items.${i}.answer`) }))
            .filter((x) => x.question && x.answer)
          out = list.length ? { ...base, items: list } : null
          break
        }
        case 'cta':
          out = { ...base, layout: choose(s.layout, ENUM.ctaLayout, 'band', `${where}.layout`), image: img(s.image, `${where}.image`), cta: cta(s.cta, `${where}.cta`) || { label: 'Book now', target: 'book' } }
          if (!out.heading) out.heading = 'Ready when you are.'
          break
        case 'area':
          out = { ...base }
          break
        case 'contact':
          out = { ...base, showPhone: bool(s.showPhone) }
          break
      }
      if (out) {
        sections.push(out)
        total++
      } else warnings.push({ where, reason: 'empty' })
    }
    if (!sections.length && pi > 0) {
      warnings.push({ where: `pages.${pi}`, reason: 'empty' })
      continue
    }
    outPages.push({
      slug,
      navLabel: txt(p.navLabel, LIMITS.navLabel, `pages.${pi}.navLabel`) || (slug ? slug.replace(/-/g, ' ') : 'Home'),
      seoTitle: txt(p.seoTitle, LIMITS.seoTitle, `pages.${pi}.seoTitle`),
      seoDescription: txt(p.seoDescription, LIMITS.seoDescription, `pages.${pi}.seoDescription`),
      sections,
    })
  }
  // Every site has a home page with a hero, and a way to book on every page.
  if (!outPages.length || outPages[0].slug !== '') outPages.unshift({ slug: '', navLabel: 'Home', seoTitle: '', seoDescription: '', sections: [] })
  // The home page opens with a hero or a composition that has a heading (its first screen).
  const opener = outPages[0].sections[0]
  if (!opener || !(opener.type === 'hero' || (opener.type === 'composition' && opener.blocks.some((b) => b.kind === 'heading')))) {
    warnings.push({ where: 'pages.0.sections.0', reason: 'first_screen_added' })
    outPages[0].sections.unshift(validateSpec({ pages: [{ sections: [{ type: 'hero' }] }] }, ctx).spec.pages[0].sections[0])
  }
  for (const pg of outPages) {
    const linksToBook = pg.sections.some((s) => s.type === 'hero' || s.type === 'cta' || s.type === 'contact' || (s.type === 'composition' && s.blocks.some((b) => b.kind === 'button' && b.target === 'book')))
    if (!linksToBook) pg.sections.push({ type: 'cta', id: `book-${pg.slug || 'home'}`, background: 'accent', backgroundImage: null, spacing: 'l', align: 'center', width: 'normal', animate: 'none', heading: 'Ready when you are.', eyebrow: '', text: '', layout: 'band', image: null, cta: { label: 'Book now', target: 'book' } })
  }
  // Section links must point at a section that exists.
  const allIds = new Set(outPages.flatMap((pg) => pg.sections.map((s) => s.id)))
  for (const pg of outPages)
    for (const s of pg.sections)
      for (const k of ['primaryCta', 'secondaryCta', 'cta']) if (s[k]?.target?.startsWith('section:') && !allIds.has(s[k].target.slice(8))) s[k].target = 'book'
  for (const pg of outPages) for (const s of pg.sections) for (const b of s.blocks || []) if (b.target?.startsWith('section:') && !allIds.has(b.target.slice(8))) b.target = 'book'
  // Booking is always one tap away: the navigation's Book button can't be switched off.
  if (r.nav?.showBook === false) warnings.push({ where: 'nav.showBook', reason: 'booking_kept' })
  const spec = {
    version: SPEC_VERSION,
    name: txt(r.name, LIMITS.name, 'name') || 'Custom design',
    // The design idea in one line (art direction), as the AI committed to it. Shown to the owner, never rendered.
    direction: txt(r.direction, LIMITS.direction, 'direction'),
    theme,
    nav: { layout: choose(r.nav?.layout, ENUM.navLayout, 'left', 'nav.layout'), sticky: bool(r.nav?.sticky, true), showBook: true },
    footer: { layout: choose(r.footer?.layout, ENUM.footerLayout, 'simple', 'footer.layout'), text: txt(r.footer?.text, LIMITS.footer, 'footer.text') },
    pages: outPages,
  }
  if (JSON.stringify(spec).length > LIMITS.specBytes) {
    warnings.push({ where: 'spec', reason: 'too_large' })
    spec.pages = spec.pages.slice(0, 1)
  }
  return { spec, warnings }
}

// Every image the spec uses (for asset serving: a published site's images are public).
export const specImages = (spec) => {
  const out = new Set()
  for (const pg of spec?.pages || [])
    for (const s of pg.sections) for (const v of [s.image, s.backgroundImage, ...(s.images || []), ...(s.items || []).map((x) => x.image), ...(s.blocks || []).map((b) => b.image)]) if (typeof v === 'string' && v.startsWith('asset:')) out.add(v.slice(6))
  return out
}
