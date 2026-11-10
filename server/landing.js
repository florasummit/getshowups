// Business landing pages from one reusable template. The draft is generated from what the business
// already told us (name, appointment mode, service ZIPs, and the ad profile's services/cities/claims
// when present). Owners edit and publish; text goes through the same unapproved-claims filter as ads,
// so a page never invents reviews, guarantees, discounts, credentials or results.
import { unapprovedClaims } from './ads/spec.js'

const LIMITS = { headline: 80, intro: 400, service: 80, services: 8, area: 200, highlight: 90, highlights: 5 }
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

async function adProfile(db, customerId) {
  const r = await db.prepare('SELECT services, service_area, approved_claims, industry FROM ad_profiles WHERE customer = ?1').bind(customerId).first()
  if (!r) return null
  return { industry: r.industry, services: JSON.parse(r.services || '[]'), area: JSON.parse(r.service_area || '{}'), claims: JSON.parse(r.approved_claims || '[]') }
}

export async function approvedClaimsFor(db, customerId) {
  return (await adProfile(db, customerId))?.claims || []
}

// Deterministic template draft. Nothing here is a claim about quality, price or speed.
export async function generateDraft(db, customer) {
  // Business profile from onboarding first; the ads profile is the fallback for older businesses.
  const bp = await db.prepare('SELECT industry, description, services, cities FROM business_profiles WHERE customer = ?1').bind(customer.id).first()
  const p = bp
    ? { industry: bp.industry, services: JSON.parse(bp.services).map((x) => (x.price ? `${x.name} · ${x.price}` : x.name)), area: { cities: JSON.parse(bp.cities) }, claims: (await adProfile(db, customer.id))?.claims || [], description: bp.description }
    : await adProfile(db, customer.id)
  const services = (p?.services?.length ? p.services : []).slice(0, LIMITS.services).map((x) => x.slice(0, LIMITS.service))
  const cities = p?.area?.cities || []
  const zips = p?.area?.zips?.length ? p.area.zips : customer.serviceZips
  const area = cities.length ? cities.join(', ') : zips.length ? `ZIP codes ${zips.slice(0, 12).join(', ')}${zips.length > 12 ? ' and nearby' : ''}` : ''
  const lead = (services[0] || p?.industry || 'Service').split(' · ')[0]
  const where = cities[0] ? ` in ${cities[0]}` : ''
  const visit = customer.appointmentMode === 'at_customer'
  return {
    headline: `${lead}${where}`.slice(0, LIMITS.headline),
    intro: (p?.description
      ? p.description
      : visit
      ? `${customer.name} comes to you. Tell us what you need and pick a time that works for you; it takes about a minute.`
      : `Tell ${customer.name} what you need and pick a time that works for you; it takes about a minute.`
    ).slice(0, LIMITS.intro),
    services,
    area: area.slice(0, LIMITS.area),
    highlights: (p?.claims || []).slice(0, LIMITS.highlights),
    published: false,
  }
}

// Returns [errors[], page]. Every visible text is checked against the business's approved claims.
export function validatePage(body, approvedClaims = []) {
  const b = body && typeof body === 'object' ? body : {}
  const errors = []
  const page = {
    headline: clean(b.headline),
    intro: clean(b.intro),
    services: (Array.isArray(b.services) ? b.services : []).map(clean).filter(Boolean),
    area: clean(b.area),
    highlights: (Array.isArray(b.highlights) ? b.highlights : []).map(clean).filter(Boolean),
  }
  if (!page.headline || page.headline.length > LIMITS.headline) errors.push('headline')
  if (!page.intro || page.intro.length > LIMITS.intro) errors.push('intro')
  if (page.services.length > LIMITS.services || page.services.some((s) => s.length > LIMITS.service)) errors.push('services')
  if (page.area.length > LIMITS.area) errors.push('area')
  if (page.highlights.length > LIMITS.highlights || page.highlights.some((s) => s.length > LIMITS.highlight)) errors.push('highlights')
  for (const [field, texts] of [['headline', [page.headline]], ['intro', [page.intro]], ['services', page.services], ['area', [page.area]], ['highlights', page.highlights]]) {
    if (texts.some((t) => unapprovedClaims(t, approvedClaims).length)) errors.push(`${field}:unapproved_claim`)
  }
  return [[...new Set(errors)], page]
}

const fromRow = (r) =>
  r && { headline: r.headline, intro: r.intro, services: JSON.parse(r.services), area: r.area, highlights: JSON.parse(r.highlights), published: r.published === 1, publishedAt: r.published_at, updatedAt: r.updated_at }

export async function getPage(db, customerId) {
  return fromRow(await db.prepare('SELECT * FROM landing_pages WHERE customer = ?1').bind(customerId).first())
}

export async function savePage(db, customerId, page, { publish }, now = Date.now()) {
  await db
    .prepare(
      `INSERT INTO landing_pages (customer, headline, intro, services, area, highlights, published, published_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?7 = 1 THEN ?8 END, ?8)
       ON CONFLICT(customer) DO UPDATE SET headline = ?2, intro = ?3, services = ?4, area = ?5, highlights = ?6, published = ?7,
         published_at = CASE WHEN ?7 = 1 THEN coalesce(landing_pages.published_at, ?8) ELSE NULL END, updated_at = ?8`,
    )
    .bind(customerId, page.headline, page.intro, JSON.stringify(page.services), page.area, JSON.stringify(page.highlights), publish ? 1 : 0, now)
    .run()
  return getPage(db, customerId)
}
