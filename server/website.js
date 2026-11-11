// Managed business websites. One structured content document per business (no page builder):
// a private draft the owner edits, immutable published versions (so any earlier version can be
// restored), and hosting that follows the subscription. Everything customers read goes through the
// same unapproved-claims filter as ads, so a site never invents reviews, guarantees or credentials.
import { unapprovedClaims } from './ads/spec.js'
import { approvedClaimsFor } from './landing.js'
import { getSubscription } from './stripe.js'
import { validateDesign } from './site-design.js'

export const TEMPLATES = ['clean', 'bold', 'warm']
// Accent colours, each dark enough for white button text (WCAG AA).
export const COLORS = {
  ocean: '#1d5fa8',
  teal: '#0f766e',
  forest: '#2f6b2f',
  orange: '#c2410c',
  red: '#b42318',
  plum: '#6b3fa0',
  slate: '#334155',
}
export const LIMITS = { headline: 80, intro: 400, about: 1200, services: 12, serviceName: 60, price: 40, serviceText: 240, area: 200, highlights: 5, highlight: 90, photos: 6, seoTitle: 70, seoDescription: 160 }
const ASSET_RE = /^[a-f0-9]{32}$/
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
// Keeps paragraph breaks for longer text; collapses everything else.
const cleanPara = (s) =>
  String(s ?? '')
    .split(/\n{2,}/)
    .map(clean)
    .filter(Boolean)
    .join('\n\n')

// Industry-aware defaults so a site reads well before the owner writes anything.
const TAGLINES = {
  'pool service': 'Clean, clear water without the hassle.',
  'lawn care': 'A healthy, tidy lawn without the weekend work.',
  'house cleaning': 'Come home to a clean house.',
  'pest control': 'Keep pests out of your home.',
  hvac: 'Heating and cooling you can count on.',
  plumbing: 'Plumbing help when you need it.',
  'pressure washing': 'Make your home look new again.',
  landscaping: 'Outdoor spaces you’ll enjoy.',
  'window cleaning': 'Clear windows, inside and out.',
}

function legacyContent(landing) {
  return {
    headline: landing.headline,
    intro: landing.intro,
    about: '',
    services: JSON.parse(landing.services || '[]').map((s) => {
      const [name, price = ''] = String(s).split(' · ')
      return { name: name.slice(0, LIMITS.serviceName), price: price.slice(0, LIMITS.price), description: '' }
    }),
    area: landing.area || '',
    highlights: JSON.parse(landing.highlights || '[]'),
  }
}

// Deterministic first draft from what the business already told us. Nothing here is a claim.
export async function generateContent(db, customer) {
  const [bp, landing, claims] = await Promise.all([
    db.prepare('SELECT industry, description, services, cities FROM business_profiles WHERE customer = ?1').bind(customer.id).first(),
    db.prepare('SELECT * FROM landing_pages WHERE customer = ?1').bind(customer.id).first(),
    approvedClaimsFor(db, customer.id),
  ])
  const base = landing ? legacyContent(landing) : null
  const services = bp
    ? JSON.parse(bp.services).map((s) => ({ name: s.name, price: s.price || '', description: '' }))
    : base?.services || []
  const cities = bp ? JSON.parse(bp.cities) : []
  const industry = clean(bp?.industry)
  const lead = services[0]?.name || industry || 'Service'
  const where = cities[0] ? ` in ${cities[0]}` : ''
  const zips = customer.serviceZips || []
  const area = cities.length ? cities.join(', ') : base?.area || (zips.length ? `ZIP codes ${zips.slice(0, 12).join(', ')}${zips.length > 12 ? ' and nearby' : ''}` : '')
  const visit = customer.appointmentMode === 'at_customer'
  const intro =
    bp?.description ||
    base?.intro ||
    (visit
      ? `${customer.name} comes to you. Tell us what you need and pick a time that works for you. It takes about a minute.`
      : `Tell ${customer.name} what you need and pick a time that works for you. It takes about a minute.`)
  const headline = base?.headline || (industry && TAGLINES[industry.toLowerCase()] && !cities[0] ? TAGLINES[industry.toLowerCase()] : `${lead}${where}`)
  const content = {
    template: 'clean',
    color: 'ocean',
    headline: headline.slice(0, LIMITS.headline),
    intro: intro.slice(0, LIMITS.intro),
    about: '',
    services: services.slice(0, LIMITS.services),
    area: area.slice(0, LIMITS.area),
    highlights: (base?.highlights?.length ? base.highlights : claims).slice(0, LIMITS.highlights),
    logo: null,
    hero: null,
    photos: [],
    seoTitle: `${customer.name}${industry ? ` | ${industry}${where}` : ''}`.slice(0, LIMITS.seoTitle),
    seoDescription: intro.slice(0, LIMITS.seoDescription),
  }
  // Generated text passes the same rules as owner text; drop anything that would not.
  const [errors, valid] = validateContent(content, claims)
  return errors.length ? { ...valid, highlights: [] } : valid
}

// Returns [errors[], content]. `assetIds`: ids this business owns (images are checked against them).
export function validateContent(body, approvedClaims = [], assetIds = null) {
  const b = body && typeof body === 'object' ? body : {}
  const errors = []
  const services = (Array.isArray(b.services) ? b.services : [])
    .map((s) => ({ name: clean(s?.name), price: clean(s?.price), description: clean(s?.description) }))
    .filter((s) => s.name)
  const asset = (v) => (v == null || v === '' ? null : String(v))
  const c = {
    template: TEMPLATES.includes(b.template) ? b.template : 'clean',
    color: Object.hasOwn(COLORS, b.color) ? b.color : 'ocean',
    headline: clean(b.headline),
    intro: clean(b.intro),
    about: cleanPara(b.about),
    services,
    area: clean(b.area),
    highlights: (Array.isArray(b.highlights) ? b.highlights : []).map(clean).filter(Boolean),
    logo: asset(b.logo),
    hero: asset(b.hero),
    photos: (Array.isArray(b.photos) ? b.photos : []).map(asset).filter(Boolean),
    seoTitle: clean(b.seoTitle),
    seoDescription: clean(b.seoDescription),
  }
  if (b.template !== undefined && !TEMPLATES.includes(b.template)) errors.push('template')
  if (b.color !== undefined && !Object.hasOwn(COLORS, b.color)) errors.push('color')
  if (!c.headline || c.headline.length > LIMITS.headline) errors.push('headline')
  if (!c.intro || c.intro.length > LIMITS.intro) errors.push('intro')
  if (c.about.length > LIMITS.about) errors.push('about')
  if (services.length > LIMITS.services || services.some((s) => s.name.length > LIMITS.serviceName || s.price.length > LIMITS.price || s.description.length > LIMITS.serviceText)) errors.push('services')
  if (c.area.length > LIMITS.area) errors.push('area')
  if (c.highlights.length > LIMITS.highlights || c.highlights.some((h) => h.length > LIMITS.highlight)) errors.push('highlights')
  if (c.seoTitle.length > LIMITS.seoTitle) errors.push('seoTitle')
  if (c.seoDescription.length > LIMITS.seoDescription) errors.push('seoDescription')
  // Optional AI-chosen design (layout, palette, type, images) from the safe design system.
  if (b.design != null) {
    const [designErrors, design] = validateDesign(b.design, assetIds)
    if (designErrors.length) errors.push('design')
    else c.design = design
  }
  const images = [c.logo, c.hero, ...c.photos].filter(Boolean)
  if (c.photos.length > LIMITS.photos || new Set(c.photos).size !== c.photos.length) errors.push('photos')
  if (images.some((id) => !ASSET_RE.test(id) || (assetIds && !assetIds.has(id)))) errors.push('images')
  const texts = {
    headline: [c.headline],
    intro: [c.intro],
    about: [c.about],
    services: services.flatMap((s) => [s.name, s.price, s.description]),
    area: [c.area],
    highlights: c.highlights,
    seoTitle: [c.seoTitle],
    seoDescription: [c.seoDescription],
  }
  for (const [field, list] of Object.entries(texts)) {
    if (list.some((t) => t && unapprovedClaims(t, approvedClaims).length)) errors.push(`${field}:unapproved_claim`)
  }
  return [[...new Set(errors)], c]
}

// ---------- storage ----------
const parse = (s) => JSON.parse(s)

export async function assetIdsFor(db, customerId) {
  const { results } = await db.prepare('SELECT id FROM website_assets WHERE customer = ?1').bind(customerId).all()
  return new Set(results.map((r) => r.id))
}

// What the public sees: the live version, or (for businesses that published before websites existed)
// their published landing page. null = not published.
export async function liveContent(db, customerId) {
  const w = await db.prepare('SELECT live_version, published_at FROM websites WHERE customer = ?1').bind(customerId).first()
  if (w) {
    if (w.live_version == null) return null
    const v = await db.prepare('SELECT content FROM website_versions WHERE customer = ?1 AND version = ?2').bind(customerId, w.live_version).first()
    return v ? { version: w.live_version, publishedAt: w.published_at, content: { ...defaults(), ...parse(v.content) } } : null
  }
  const legacy = await db.prepare('SELECT * FROM landing_pages WHERE customer = ?1 AND published = 1').bind(customerId).first()
  return legacy ? { version: 0, publishedAt: legacy.published_at, content: { ...defaults(), ...legacyContent(legacy) } } : null
}
const defaults = () => ({ template: 'clean', color: 'ocean', about: '', logo: null, hero: null, photos: [], seoTitle: '', seoDescription: '', design: null })

// The owner's view: draft (saved or generated), live version, recent versions.
export async function loadWebsite(db, customer) {
  const [w, live, versions] = await Promise.all([
    db.prepare('SELECT * FROM websites WHERE customer = ?1').bind(customer.id).first(),
    liveContent(db, customer.id),
    db.prepare('SELECT version, created_at FROM website_versions WHERE customer = ?1 ORDER BY version DESC LIMIT 10').bind(customer.id).all(),
  ])
  const draft = w ? { ...defaults(), ...parse(w.draft) } : live ? live.content : await generateContent(db, customer)
  return {
    draft,
    generated: !w && !live,
    published: Boolean(live),
    liveVersion: live?.version ?? null,
    publishedAt: live?.publishedAt ?? null,
    updatedAt: w?.updated_at ?? null,
    // Unpublished changes: the draft differs from what is live.
    changed: Boolean(live) && JSON.stringify(draft) !== JSON.stringify(live.content),
    versions: versions.results.map((v) => ({ version: v.version, createdAt: v.created_at, live: v.version === live?.version })),
  }
}

// First save of a business that already had a published landing page keeps it live as version 1.
async function ensureRow(db, customerId, content, now) {
  const exists = await db.prepare('SELECT 1 FROM websites WHERE customer = ?1').bind(customerId).first()
  if (exists) return
  const legacy = await liveContent(db, customerId)
  let live = null
  if (legacy) {
    await db.prepare('INSERT OR IGNORE INTO website_versions (customer, version, content, created_at) VALUES (?1, 1, ?2, ?3)').bind(customerId, JSON.stringify(legacy.content), now).run()
    live = 1
  }
  await db
    .prepare('INSERT OR IGNORE INTO websites (customer, draft, live_version, published_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(customerId, JSON.stringify(content), live, legacy?.publishedAt ?? null, now)
    .run()
}

export async function saveDraft(db, customerId, content, now = Date.now()) {
  await ensureRow(db, customerId, content, now)
  await db.prepare('UPDATE websites SET draft = ?2, updated_at = ?3 WHERE customer = ?1').bind(customerId, JSON.stringify(content), now).run()
}

// Publishes `content` as a new version and makes it live.
export async function publish(db, customerId, content, now = Date.now()) {
  await saveDraft(db, customerId, content, now)
  const row = await db
    .prepare(
      `INSERT INTO website_versions (customer, version, content, created_at)
       SELECT ?1, coalesce(max(version), 0) + 1, ?2, ?3 FROM website_versions WHERE customer = ?1 RETURNING version`,
    )
    .bind(customerId, JSON.stringify(content), now)
    .first()
  await db.prepare('UPDATE websites SET live_version = ?2, published_at = ?3, updated_at = ?3 WHERE customer = ?1').bind(customerId, row.version, now).run()
  return row.version
}

export async function unpublish(db, customer, now = Date.now()) {
  const w = await loadWebsite(db, customer)
  await ensureRow(db, customer.id, w.draft, now)
  await db.prepare('UPDATE websites SET live_version = NULL, updated_at = ?2 WHERE customer = ?1').bind(customer.id, now).run()
}

// Rollback: an earlier version becomes live again (and the draft, so editing continues from it).
export async function restore(db, customerId, version, now = Date.now()) {
  if (!Number.isInteger(version) || version < 1) return false
  const v = await db.prepare('SELECT content FROM website_versions WHERE customer = ?1 AND version = ?2').bind(customerId, version).first()
  if (!v) return false
  await db.prepare('UPDATE websites SET draft = ?2, live_version = ?3, published_at = ?4, updated_at = ?4 WHERE customer = ?1').bind(customerId, v.content, version, now).run()
  return true
}

export async function websiteSummary(db, customerId) {
  const [w, live] = await Promise.all([db.prepare('SELECT 1 AS x FROM websites WHERE customer = ?1').bind(customerId).first(), liveContent(db, customerId)])
  return { exists: Boolean(w || live), published: Boolean(live) }
}

// ---------- hosting entitlement ----------
// Businesses without a self-serve signup (pilots, invited, admin-created) are always hosted.
// Self-serve: hosted while the subscription is paid (including Stripe's retry window). After the
// subscription ends, the site stays up for a 14-day transition, then shows "unavailable". Content is
// never deleted, and resubscribing brings the site straight back.
export const HOSTING_GRACE_MS = 14 * 24 * 60 * 60 * 1000
export async function hostingStatus(db, customerId, now = Date.now()) {
  const signup = await db.prepare('SELECT onboarded_at FROM self_signups WHERE customer = ?1').bind(customerId).first()
  if (!signup) return { status: 'active', exempt: true }
  const sub = await getSubscription(db, customerId)
  if (sub && ['active', 'trialing', 'past_due'].includes(sub.status)) return { status: 'active', endsAt: sub.cancelAtPeriodEnd ? sub.currentPeriodEnd : null }
  if (sub?.status === 'canceled') {
    const until = (sub.currentPeriodEnd || now) + HOSTING_GRACE_MS
    return now < until ? { status: 'grace', until } : { status: 'ended' }
  }
  // Never paid: only possible before onboarding finished, when nothing can be published yet.
  return signup.onboarded_at ? { status: 'active' } : { status: 'unpaid' }
}
export const isHosted = (h) => h.status === 'active' || h.status === 'grace'
