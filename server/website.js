// Managed business websites. One structured content document per business (no page builder):
// a private draft the owner edits, immutable published versions (so any earlier version can be
// restored), and hosting that follows the subscription. Everything customers read goes through the
// same unapproved-claims filter as ads, so a site never invents reviews, guarantees or credentials.
import { unapprovedClaims } from './ads/spec.js'
import { approvedClaimsFor } from './landing.js'
import { getSubscription } from './stripe.js'
import { validateDesign } from './site-design.js'
import { validateSpec } from './site-spec.js'

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
// Old addresses from a previous website (e.g. /services) → where they go on this one, used once the business's own
// domain points here (functions/_middleware.js). Targets are fixed choices, never free URLs.
export const REDIRECT_TARGETS = ['/', '/#services', '/#about', '/#contact', 'book']
const REDIRECT_FROM = /^\/[a-z0-9][a-z0-9._~/-]{0,119}$/
export const MAX_REDIRECTS = 30
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

// Brand name for headlines: the business name without a legal suffix ("Poolthru LLC" → "Poolthru").
export const brandName = (name) => String(name || '').replace(/[,\s]+(l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|ltd\.?|pllc|llp)$/i, '').trim() || String(name || '')
// The public brand as the owner writes it: the name without a legal suffix, in the spelling the owner's own reviewed
// website text uses most (records say "Poolthru LLC"; their site says "PoolThru"). Never invents a name: only a
// different capitalisation of the same letters is taken from the content.
export function displayBrand(name, content) {
  const base = brandName(name)
  if (!base || !content) return base
  const text = [content.headline, content.intro, content.about, content.seoTitle, content.seoDescription].filter((x) => typeof x === 'string').join(' \n ')
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const counts = new Map()
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'))) counts.set(m[0], (counts.get(m[0]) || 0) + 1)
  let best = base
  // All-caps is styling (a heading in capitals), not the brand's spelling.
  for (const [v, n] of counts) if (v !== v.toUpperCase() && n > (counts.get(best) || 0)) best = v
  return best
}

// Stable service ids (AI-designed sites only). The AI design (content.site) describes each service in its own words; it
// refers to the service by id, never by its position in the list, so deleting, adding or reordering services can't put
// one service's description under another (positions did, 2026-11-16). Content without an AI design keeps its exact
// shape (no ids), so nothing changes for anyone outside the Website Studio pilot.
export const SERVICE_ID_RE = /^[a-z][a-z0-9]{1,23}$/
const newServiceId = () => `v${[...crypto.getRandomValues(new Uint32Array(2))].map((n) => n.toString(36)).join('')}`.slice(0, 13)
const nameKey = (n) => String(n || '').trim().toLowerCase()
const withId = (s, id) => {
  const { id: _old, ...rest } = s
  return { id, ...rest }
}

// Services saved with an AI design: every service gets an id. Kept: a valid id the service already has (unique in the
// list). Inherited: the id of the previously saved service with the same name (a client that dropped ids, an import
// replacing the list). Otherwise a new random id (never a position, so an old reference can't land on a new service).
export function assignServiceIds(services, prior = []) {
  const used = new Set()
  const out = services.map((s) => (SERVICE_ID_RE.test(s.id ?? '') && !used.has(s.id) ? (used.add(s.id), withId(s, s.id)) : withId(s, null)))
  for (const [i, s] of out.entries()) {
    if (s.id) continue
    const p = (prior || []).find((x) => SERVICE_ID_RE.test(x?.id ?? '') && !used.has(x.id) && nameKey(x.name) === nameKey(s.name))
    if (p) {
      out[i] = withId(s, p.id)
      used.add(p.id)
    }
  }
  for (const [i, s] of out.entries()) {
    if (s.id) continue
    let id
    do id = newServiceId()
    while (used.has(id))
    out[i] = withId(s, id)
    used.add(id)
  }
  return out
}

// Read-time upgrade of a stored AI-designed draft or version saved before service ids existed: deterministic (the same
// content always gets the same ids), so drafts and live versions stay comparable and nothing has to be migrated. The
// design's position references are converted against the SAME stored list they were saved with, so they stay right.
export function withServiceRefs(content) {
  if (!content?.site || !Array.isArray(content.services)) return content
  const seen = new Set()
  const taken = new Set(content.services.map((s) => s?.id).filter((id) => SERVICE_ID_RE.test(id ?? '')))
  let n = 0
  const services = content.services.map((s) => {
    if (SERVICE_ID_RE.test(s?.id ?? '') && !seen.has(s.id)) {
      seen.add(s.id)
      return s
    }
    let id
    do id = `s${++n}`
    while (taken.has(id) || seen.has(id))
    seen.add(id)
    return withId(s, id)
  })
  const pages = Array.isArray(content.site.pages)
    ? content.site.pages.map((p) => ({
        ...p,
        sections: (p.sections || []).map((s) =>
          s?.type === 'services' && Array.isArray(s.items)
            ? {
                ...s,
                items: s.items.map((x) => {
                  if (typeof x?.serviceId === 'string' || !Number.isInteger(x?.serviceIndex)) return x
                  const { serviceIndex, ...rest } = x
                  return services[serviceIndex] ? { serviceId: services[serviceIndex].id, ...rest } : x
                }),
              }
            : s,
        ),
      }))
    : content.site.pages
  return { ...content, services, site: { ...content.site, pages } }
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
  // Shown area: towns/cities only. A bare ZIP list reads badly on a website (ZIPs still qualify leads on the
  // booking page); the owner adds their city in Business details.
  const area = cities.length ? cities.join(', ') : base?.area || ''
  const visit = customer.appointmentMode === 'at_customer'
  const intro =
    bp?.description ||
    base?.intro ||
    (visit
      ? `${customer.name} comes to you. Tell us what you need and pick a time that works for you. It takes about a minute.`
      : `Tell ${customer.name} what you need and pick a time that works for you. It takes about a minute.`)
  // Template headline: brand + what they do + city. Never ZIP codes (they qualify leads; they don't sell).
  const headline = base?.headline || `${brandName(customer.name)}: ${lead}${where}`
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
// `prior`: the services as last saved (with ids), for an AI-designed site: ids carry over by name, and a design still
// using positions (saved before ids, sent by an older page) is read against the list it was made for.
export function validateContent(body, approvedClaims = [], assetIds = null, { prior = null } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const errors = []
  const designed = b.site != null
  const listed = (Array.isArray(b.services) ? b.services : [])
    .map((s) => ({ ...(designed && SERVICE_ID_RE.test(s?.id ?? '') ? { id: s.id } : {}), name: clean(s?.name), price: clean(s?.price), description: clean(s?.description) }))
    .filter((s) => s.name)
  const services = designed ? assignServiceIds(listed, prior) : listed
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
    redirects: (Array.isArray(b.redirects) ? b.redirects : [])
      .map((r) => ({ from: String(r?.from ?? '').toLowerCase().replace(/\/+$/, ''), to: String(r?.to ?? '') }))
      .filter((r) => r.from),
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
  if (!c.redirects.length) delete c.redirects // older content has none: keep drafts and live versions comparable
  else if (c.redirects.length > MAX_REDIRECTS || c.redirects.some((r) => !REDIRECT_FROM.test(r.from) || !REDIRECT_TARGETS.includes(r.to)) || new Set(c.redirects.map((r) => r.from)).size !== c.redirects.length) errors.push('redirects')
  // AI-designed site (v2 spec, server/site-spec.js): validated and repaired here too, so a saved or restored spec can never
  // carry anything the schema doesn't allow. Services/prices come from this content's own services list.
  if (designed) c.site = validateSpec(b.site, { assetIds: assetIds || { has: () => true }, services, legacyServices: prior?.length ? prior : services, claims: approvedClaims }).spec
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
    return v ? { version: w.live_version, publishedAt: w.published_at, content: withServiceRefs({ ...defaults(), ...parse(v.content) }) } : null
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
  const draft = w ? withServiceRefs({ ...defaults(), ...parse(w.draft) }) : live ? live.content : await generateContent(db, customer)
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
