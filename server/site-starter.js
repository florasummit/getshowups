// One content system: the business's records + content it approved (imported or written) → the same multi-page site
// spec (content.site, server/site-spec.js) the Studio editor, preview and publishing use. Deterministic: no AI, no key,
// no cost; works for any industry (look from site-design.js presets, words only from records/approved content).
//
// Precedence (applied by the callers): the owner's own edits > the business's records (name, phone, hours, area,
// services and prices) > approved imported content > generated starter text. Nothing here invents a service, price,
// claim, review or credential; empty content simply leaves a section out.
import { FONTS as LOOKS, INDUSTRIES, PALETTES, industryKey, presetDesigns } from './site-design.js'
import { LIMITS } from './site-spec.js'

const BOOK = { label: 'Book online', target: 'book' }
const cta = (id) => ({ type: 'cta', id, background: 'accent', align: 'center', layout: 'band', heading: 'Ready when you are.', cta: BOOK })

export function starterTheme(key) {
  const preset = presetDesigns(key)[0]
  const p = PALETTES[preset.palette] || PALETTES.graphite
  // The industry's own starter look (type, shape, buttons); unknown industries keep the neutral default.
  const s = INDUSTRIES[key]?.starter || {}
  const f = LOOKS[s.fonts || preset.fonts] || LOOKS.modern
  return {
    name: preset.name || 'Starter',
    theme: {
      colors: { bg: p.bg, surface: p.surface, ink: p.ink, muted: p.muted, accent: p.accent, onAccent: p.onAccent, line: p.line },
      headingFont: f.headFile,
      bodyFont: f.bodyFile,
      headingWeight: f.headWeight,
      headingCase: 'none',
      headingTracking: -0.02,
      baseSize: 17,
      scale: 1.25,
      lineHeight: 1.6,
      radius: s.radius ?? 14,
      density: 'comfortable',
      maxWidth: 1200,
      buttons: s.buttons || 'solid',
      motion: 'none',
    },
    heroImage: preset.heroImage,
  }
}

// Starter privacy text, matched to what the website actually does (forms + booking always; AI chat/voice only when the
// receptionist is on). Always marked as a draft for the owner to review: it is not legal advice.
export function starterPrivacy(biz) {
  return [
    `This page explains how ${biz.name} uses the details you share on this website.`,
    'What we collect: when you send a message, request a quote or book a time, we receive the name, email address, phone number and message you enter, and the time you book.' +
      (biz.visit ? ' For visits at your property, we also receive the address you give us.' : ''),
    ...(biz.chat
      ? [
          'Chat and voice: if you use the chat or talk option, what you type or say is processed by an AI assistant to answer you and to book or record your request, and the conversation is kept so our team can follow up.',
        ]
      : []),
    'How we use it: only to reply to you, to arrange and confirm your appointment, and to send reminders about it. We do not sell your details.',
    'This website does not use advertising trackers. It is hosted by GetShowUps, which stores the details you send on our behalf; bookings are added to our calendar.',
    `To see, correct or delete the details we hold about you, contact ${biz.name}.`,
  ].join('\n\n')
}

// A crawled legal page (privacy policy, terms) → text sections, word for word, headings kept. Refuses rather than
// shortening: an incomplete or over-long policy is never published as if it were the whole policy.
export function legalSections(page) {
  if (!page || page.truncated) return { ok: false, reason: 'incomplete' }
  const sections = []
  let cur = null
  const flush = () => {
    if (cur && (cur.heading || cur.parts.length)) sections.push(cur)
    cur = null
  }
  for (const b of page.text || []) {
    if (/^h[1-4]$/.test(b.tag)) {
      flush()
      cur = { heading: b.text, parts: [] }
    } else {
      cur = cur || { heading: '', parts: [] }
      cur.parts.push(b.tag === 'li' ? `• ${b.text}` : b.text)
    }
  }
  flush()
  // Split a long group at paragraph boundaries (each section's body is limited); a single paragraph over the limit can't
  // be kept intact, so the import is refused.
  const out = []
  for (const s of sections) {
    let body = ''
    let heading = s.heading
    for (const part of s.parts) {
      if (part.length > LIMITS.body) return { ok: false, reason: 'too_long' }
      if (body && body.length + 2 + part.length > LIMITS.body) {
        out.push({ heading, body })
        heading = ''
        body = ''
      }
      body = body ? `${body}\n\n${part}` : part
    }
    out.push({ heading, body })
  }
  const words = out.reduce((n, s) => n + `${s.heading} ${s.body}`.split(/\s+/).filter(Boolean).length, 0)
  if (!words) return { ok: false, reason: 'empty' }
  if (out.length > LIMITS.sectionsPerPage) return { ok: false, reason: 'too_long' }
  return { ok: true, sections: out.map((s, i) => ({ type: 'text', id: `policy-${i + 1}`, heading: s.heading.slice(0, LIMITS.heading), body: s.body })), words }
}

// Pages the owner can have created from approved content. Each returns null when the content for it doesn't exist.
export function pageFor(kind, content, biz, opts = {}) {
  const name = biz.name
  switch (kind) {
    case 'services':
      return content.services?.length
        ? { slug: 'services', navLabel: 'Services', seoTitle: `Services | ${name}`.slice(0, 70), seoDescription: `Services from ${name}.`.slice(0, 160), sections: [{ type: 'services', id: 'services-list', heading: 'Services', layout: 'rows', showPrices: true, items: [] }, cta('services-book')] }
        : null
    case 'about':
      return content.about ? { slug: 'about', navLabel: 'About', seoTitle: `About | ${name}`.slice(0, 70), seoDescription: `About ${name}.`.slice(0, 160), sections: [{ type: 'text', id: 'about-text', heading: `About ${name}`.slice(0, 120), body: content.about }, cta('about-book')] } : null
    case 'contact':
      return { slug: 'contact', navLabel: 'Contact', seoTitle: `Contact | ${name}`.slice(0, 70), seoDescription: `Contact ${name}.`.slice(0, 160), sections: [{ type: 'contact', id: 'contact', heading: 'Contact us', showPhone: Boolean(biz.phone), form: 'contact' }] }
    case 'privacy': {
      const imported = opts.privacy
      if (imported?.sections?.length)
        return { slug: 'privacy', navLabel: 'Privacy policy', seoTitle: `Privacy policy | ${name}`.slice(0, 70), seoDescription: '', legal: true, source: { kind: 'imported', url: imported.url, at: opts.now }, sections: imported.sections }
      return { slug: 'privacy', navLabel: 'Privacy policy', seoTitle: `Privacy policy | ${name}`.slice(0, 70), seoDescription: '', legal: true, source: { kind: 'starter', at: opts.now }, sections: [{ type: 'text', id: 'privacy-text', heading: 'Privacy policy', body: starterPrivacy(biz) }] }
    }
    default:
      return null
  }
}
export const PAGE_KINDS = ['services', 'about', 'contact', 'privacy']

// Adds the chosen pages that the site doesn't have yet (never replaces an existing page; within the page limit).
// Returns { site, added[] }.
export function withPages(site, content, biz, kinds, opts = {}) {
  const have = new Set(site.pages.map((p) => p.slug))
  const added = []
  const pages = [...site.pages]
  for (const kind of PAGE_KINDS.filter((k) => kinds.includes(k))) {
    const pg = pageFor(kind, content, biz, opts)
    if (!pg || have.has(pg.slug) || pages.length >= LIMITS.pages) continue
    pages.push(pg)
    have.add(pg.slug)
    added.push(kind)
  }
  return { site: { ...site, pages }, added }
}

// Approved services always have a place on the website: if no page shows them, a services section is added (to the
// Services page when there is one, otherwise after the home page's first screen). Never duplicated.
export function ensureServices(site, content) {
  if (!content.services?.length) return { site, added: false }
  if (site.pages.some((p) => p.sections.some((s) => s.type === 'services' && !s.hidden))) return { site, added: false }
  const section = { type: 'services', id: 'services', heading: 'Services', layout: 'cards', showPrices: true, items: [] }
  const i = Math.max(0, site.pages.findIndex((p) => p.slug === 'services'))
  const pages = site.pages.map((p, j) => (j === i ? { ...p, sections: [...p.sections.slice(0, 1), section, ...p.sections.slice(1)] } : p))
  return { site: { ...site, pages }, added: true }
}

// biz: { name, industry, description, phone, chat, visit }. kinds: extra pages to create (see PAGE_KINDS).
export function starterSite(content, biz, { kinds = [], privacy = null, now = Date.now() } = {}) {
  const key = industryKey({ industry: biz.industry, services: content.services || [], description: biz.description, name: biz.name })
  const look = starterTheme(key)
  // The logo is never the first-screen photo (it stays in the header).
  const image = content.hero && content.hero !== content.logo ? `asset:${content.hero}` : look.heroImage
  const aboutPage = kinds.includes('about') && content.about
  const home = [
    { type: 'hero', id: 'top', layout: image ? 'split' : 'minimal', height: image ? 'tall' : 'auto', image, imageAlt: '', heading: content.headline || biz.name, text: content.intro || '', primaryCta: BOOK },
    ...(content.services?.length ? [{ type: 'services', id: 'services', heading: 'Services', layout: 'cards', showPrices: true, items: [] }] : []),
    ...(content.about && !aboutPage ? [{ type: 'text', id: 'about', heading: `About ${biz.name}`.slice(0, 120), body: content.about }] : []),
    ...(content.area ? [{ type: 'area', id: 'area', heading: 'Where we work' }] : []),
    cta('book-cta'),
  ]
  const base = {
    name: look.name,
    direction: '',
    theme: look.theme,
    nav: { layout: 'left', sticky: true, showBook: true },
    footer: { layout: 'simple', text: content.area ? `${biz.name} · ${content.area}`.slice(0, 200) : '' },
    pages: [{ slug: '', navLabel: 'Home', seoTitle: (content.seoTitle || biz.name).slice(0, 70), seoDescription: (content.seoDescription || '').slice(0, 160), sections: home }],
  }
  return withPages(base, content, biz, kinds, { privacy, now })
}
