// Website Studio editor: the small, curated set of things an owner can add without AI. Sections and pages are built from
// the business's own details only (no invented facts, reviews or promises); the server validates every save
// (server/site-spec.js validateSpec + claims filter), so these are suggestions, not a trust boundary.

// Allowed choices per section type (mirrors server/site-spec.js ENUM; the server repairs anything else).
export const LAYOUTS = {
  hero: [['split', 'Photo beside text'], ['overlay', 'Text over photo'], ['stacked', 'Photo below'], ['editorial', 'Large headline'], ['minimal', 'Text only'], ['mosaic', 'Photo collage']],
  services: [['cards', 'Cards'], ['list', 'List'], ['rows', 'Numbered rows'], ['tiles', 'Tiles'], ['alternating', 'Photo rows']],
  features: [['grid', 'Grid'], ['list', 'List'], ['inline', 'One line']],
  gallery: [['grid', 'Grid'], ['masonry', 'Masonry'], ['strip', 'Strip'], ['feature', 'One large photo']],
  steps: [['numbered', 'Numbered'], ['timeline', 'Timeline']],
  cta: [['band', 'Band'], ['card', 'Card'], ['split', 'With photo']],
}
export const BACKGROUNDS = [['bg', 'Page'], ['surface', 'Soft'], ['accent', 'Brand colour'], ['ink', 'Dark']]
export const SECTION_LABEL = { hero: 'Hero', composition: 'Hero', text: 'Text', services: 'Services', features: 'Benefits', imageText: 'Photo and text', gallery: 'Gallery', steps: 'How it works', faq: 'FAQ', cta: 'Booking', area: 'Service areas', contact: 'Contact' }

export const newId = (type, taken) => {
  let id
  do id = `${type.toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`
  while (taken.has(id))
  return id
}
export const takenIds = (site) => new Set(site.pages.flatMap((p) => p.sections.map((s) => s.id)))

// biz: { name, services[{id,name}], area, about, photos[] (asset ids), visit }
export function sectionTemplate(type, biz, id) {
  const base = { type, id, background: 'bg', spacing: 'l', align: 'left', width: 'normal', animate: 'none', heading: '', eyebrow: '', text: '' }
  const photo = biz.photos[0] ? `asset:${biz.photos[0]}` : null
  const book = { label: biz.visit ? 'Book a visit' : 'Book online', target: 'book' }
  switch (type) {
    case 'text':
      return { ...base, heading: `About ${biz.name}`, body: biz.about || 'Tell visitors who you are and how you work.' }
    case 'imageText':
      return { ...base, heading: 'How we work', body: biz.about || 'Describe your work in a few sentences.', image: photo, imageAlt: photo ? `Work by ${biz.name}` : '', imageSide: 'right', imageShape: 'rounded', cta: book }
    case 'services':
      return { ...base, heading: 'Services', layout: 'rows', showPrices: true, items: biz.services.map((s) => ({ serviceId: s.id, text: '' })) }
    case 'features':
      return { ...base, heading: 'Why customers choose us', layout: 'grid', columns: 3, items: [{ icon: 'calendar', title: 'Book online', text: 'Pick a time that suits you.' }, { icon: 'chat', title: 'Clear communication', text: 'We let you know what we did after every visit.' }] }
    case 'steps':
      return { ...base, heading: 'How it works', layout: 'numbered', items: [{ title: 'Book online', text: 'Choose a time that works for you.' }, { title: biz.visit ? 'We come to you' : 'Visit us', text: biz.visit ? 'We arrive at the time you picked.' : 'Come in at the time you picked.' }] }
    case 'gallery':
      return { ...base, heading: 'Our work', layout: 'grid', images: biz.photos.slice(0, 6).map((p) => `asset:${p}`) }
    case 'faq':
      return { ...base, heading: 'Questions', items: [{ question: 'How do I book?', answer: 'Pick a time on our booking page. It takes about a minute.' }, ...(biz.area ? [{ question: 'Where do you work?', answer: biz.area }] : [])] }
    case 'cta':
      return { ...base, background: 'accent', align: 'center', layout: 'band', heading: 'Ready when you are.', text: 'Book online in about a minute.', cta: book }
    case 'area':
      return { ...base, heading: 'Where we work' }
    case 'contact':
      return { ...base, heading: 'Get in touch', text: 'Send us a message and we’ll get back to you.', showPhone: true, form: 'contact' }
    default:
      return null
  }
}
export const ADDABLE = ['text', 'imageText', 'services', 'features', 'steps', 'gallery', 'faq', 'cta', 'area', 'contact']

// Page types an owner can add; each starts with sensible sections built from their details.
export const PAGE_TYPES = [
  ['about', 'About'],
  ['services', 'Services'],
  ['service', 'One service'],
  ['service-area', 'Service area'],
  ['contact', 'Contact'],
  ['faq', 'Questions'],
  ['privacy', 'Privacy Policy'],
  ['terms', 'Terms of Service'],
]
// Legal page slugs: /privacy and /terms on every business website and connected domain (server/site-render-v2.js puts
// them in the footer, never in the main navigation; the middleware also forwards old addresses like /privacy-policy).
export const LEGAL_PAGES = { privacy: { navLabel: 'Privacy', title: 'Privacy Policy' }, terms: { navLabel: 'Terms', title: 'Terms of Service' } }
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '') || 'page'
export function uniqueSlug(base, site) {
  const taken = new Set(site.pages.map((p) => p.slug))
  let slug = slugify(base)
  for (let i = 2; taken.has(slug); i++) slug = `${slugify(base).slice(0, 28)}-${i}`
  return slug
}

export function pageTemplate(kind, biz, site, { service } = {}) {
  const ids = takenIds(site)
  const sec = (type, extra = {}) => {
    const s = { ...sectionTemplate(type, biz, newId(type, ids)), ...extra }
    ids.add(s.id)
    return s
  }
  const label = { about: 'About', services: 'Services', 'service-area': 'Service area', contact: 'Contact', faq: 'Questions', privacy: 'Privacy', terms: 'Terms' }[kind] || service?.name || 'Page'
  const slug = uniqueSlug(kind === 'service' ? service?.name || 'service' : kind, site)
  const page = (sections, seo = {}) => ({ slug, navLabel: label.slice(0, 24), seoTitle: seo.title || `${label} | ${biz.name}`.slice(0, 70), seoDescription: (seo.description || '').slice(0, 160), sections })
  switch (kind) {
    case 'about':
      return page([sec('text', { heading: `About ${biz.name}` }), ...(biz.photos[0] ? [sec('imageText')] : []), sec('cta')])
    case 'services':
      return page([sec('services', { heading: 'Our services' }), sec('steps'), sec('cta')], { description: `${biz.services.map((s) => s.name).join(', ')} from ${biz.name}.` })
    case 'service':
      return page([sec('text', { heading: service.name, body: service.description || `Tell visitors what ${service.name} includes.` }), sec('cta')], { title: `${service.name} | ${biz.name}`, description: service.description })
    case 'service-area':
      return page([sec('area', { heading: 'Where we work', text: biz.area || '' }), sec('cta')], { description: biz.area ? `${biz.name} serves ${biz.area}.` : '' })
    case 'contact':
      return page([sec('contact', { heading: 'Contact us' }), sec('area')])
    case 'faq':
      return page([sec('faq'), sec('cta')])
    case 'privacy':
      // A legal page (legal: true): the owner's own words, kept word for word (no marketing filters), shown in the
      // footer, never rewritten or dropped by the AI designer, published only after the owner's explicit review.
      return { ...page([sec('text', { heading: 'Privacy Policy', body: privacyText(biz) })], { title: `Privacy Policy | ${biz.name}`, description: `How ${biz.name} uses the details you share on this website.` }), legal: true, source: { kind: 'starter', at: Date.now() } }
    case 'terms':
      return { ...page(termsSections(biz, sec), { title: `Terms of Service | ${biz.name}`, description: `The terms that apply when you book or buy services from ${biz.name}.` }), legal: true, source: { kind: 'starter', at: Date.now() } }
    default:
      return null
  }
}

// Accurate to what the website actually does (no tracking script; contact form; online booking). Plain words, not legal
// advice; the owner can edit it. Kept within the text section's body limit.
export function privacyText(biz) {
  return [
    `This page explains how ${biz.name} uses the details you share on this website.`,
    'What we collect: when you send a message, request a quote or book a time, we receive the name, email address, phone number and message you enter, and the time you book. For visits at your property, we also receive the address you give us.',
    'How we use it: only to reply to you, to arrange and confirm your appointment, and to send reminders about it. We do not sell your details.',
    'This website does not use advertising trackers. It is hosted by GetShowUps, which stores the details you send on our behalf; bookings are added to our calendar.',
    `To see, correct or delete the details we hold about you, contact ${biz.name}.`,
  ].join('\n\n')
}

// Terms of Service: a structure only. Every body is a prompt in [brackets] the owner replaces with their own terms;
// nothing here states a price, a guarantee, a refund rule or any obligation on the owner's behalf. Not legal advice.
export function termsSections(biz, sec) {
  const t = (heading, body) => sec('text', { heading, body })
  return [
    t('Terms of Service', `These terms apply when you book, buy or use services from ${biz.name}. [Replace the bracketed prompts on this page with your own terms before publishing. This page is not legal advice.]`),
    t('Services', '[Describe what you provide and where, and anything that is not included.]'),
    t('Bookings and cancellations', '[Say how appointments are booked and confirmed, and how and when a customer can cancel or reschedule.]'),
    t('Payment', '[Say when and how payment is due, and what happens if a payment is late or missed.]'),
    t('Contact', `Questions about these terms: contact ${biz.name}.`),
  ]
}

// Curated looks (each pairing reads well together).
export const FONT_PAIRS = [
  ['fraunces', 'manrope', 'Fraunces · Manrope'],
  ['syne', 'inter', 'Syne · Inter'],
  ['bricolage-grotesque', 'dm-sans', 'Bricolage · DM Sans'],
  ['playfair-display', 'inter', 'Playfair · Inter'],
  ['space-grotesk', 'inter', 'Space Grotesk · Inter'],
  ['archivo', 'manrope', 'Archivo · Manrope'],
  ['cormorant-garamond', 'outfit', 'Cormorant · Outfit'],
]
export const BUTTONS = [['solid', 'Solid'], ['pill', 'Rounded'], ['outline', 'Outline'], ['underline', 'Text link']]
export const TONES = {
  light: { bg: '#ffffff', surface: '#f4f5f6', ink: '#14181c', muted: '#5b636b', line: '#dfe3e7' },
  warm: { bg: '#f8f3ea', surface: '#efe7d8', ink: '#1f2422', muted: '#5f6460', line: '#ddd3c2' },
  cool: { bg: '#f1f6f8', surface: '#e2ecf0', ink: '#0f2430', muted: '#4c626c', line: '#cddbe1' },
  dark: { bg: '#111417', surface: '#1b2025', ink: '#f2f4f5', muted: '#a8b0b7', line: '#2c333a' },
}
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
// A full colour set from a tone and one brand colour (the server still checks contrast and repairs it).
export function colorsFor(tone, accent) {
  const t = TONES[tone] || TONES.light
  return { ...t, accent, onAccent: lum(accent) > 0.45 ? '#111111' : '#ffffff', accentText: accent }
}
export const toneOf = (colors) => Object.entries(TONES).find(([, t]) => t.bg === colors?.bg)?.[0] || null
