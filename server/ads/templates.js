// Campaign templates: a faster start for a business that has never advertised (Journey B), on top of the existing
// draft → approve → create-paused workflow (server/ads/campaigns.js). Three sources:
//   - curated GetShowUps templates (TEMPLATES below): Search campaigns for the trades we serve, written to pass the
//     spec limits and the unapproved-claims filter; no performance is claimed for them (no customer data backs them);
//   - a business's own imported campaign turned into a normalized draft template (keywords, negatives, ad text,
//     landing page; never account identifiers, never another business's campaign);
//   - a business's own saved drafts.
// A template only ever becomes a DRAFT (editable, nothing created, nothing spent); every later step is unchanged:
// validateSpec at approval, the owner's budget approval, PAUSED creation, read-back, explicit Start.
import { randomToken } from '../google-oauth.js'
import { LIMITS, unapprovedClaims, validateSpec } from './spec.js'
import { fitText, serviceList, cityList, exclusionTerms } from './strategy.js'
import { openDraftIds, saveDraft } from './campaigns.js'

export const TEMPLATES = [
  {
    id: 'pool_cleaning',
    name: 'Pool cleaning',
    industry: 'Pool service',
    match: /pool/i,
    service: 'pool cleaning',
    startingDailyCents: 1500,
    keywords: ['pool cleaning service', 'pool cleaning near me', 'weekly pool service', 'pool maintenance service', 'pool cleaner'],
    negativeKeywords: ['jobs', 'job', 'hiring', 'salary', 'diy', 'how to', 'free', 'cheap', 'robot', 'equipment', 'supplies', 'chemicals'],
    headlines: ['Weekly Pool Cleaning', 'Clear Water Every Week', 'Book a Pool Visit Online', 'Local Pool Service'],
    descriptions: ['Weekly cleaning, chemicals balanced, filters checked. Pick a time online.', 'Tell us about your pool and choose a visit that fits your schedule.'],
  },
  {
    id: 'pool_repair',
    name: 'Pool repair',
    industry: 'Pool service',
    match: /pool/i,
    service: 'pool repair',
    startingDailyCents: 2000,
    keywords: ['pool repair', 'pool repair near me', 'pool pump repair', 'pool leak repair', 'pool heater repair', 'pool filter repair'],
    negativeKeywords: ['jobs', 'job', 'hiring', 'salary', 'diy', 'how to', 'free', 'cheap', 'parts', 'kit', 'manual'],
    headlines: ['Pool Repair Service', 'Pump, Filter & Heater Repair', 'Book a Repair Visit Online', 'Local Pool Repair'],
    descriptions: ['Pumps, filters, heaters and leaks. Describe the problem and pick a visit time online.', 'Tell us what stopped working and choose an appointment that fits your schedule.'],
  },
  {
    id: 'hvac_maintenance',
    name: 'HVAC maintenance',
    industry: 'HVAC',
    match: /hvac|heating|cooling|air cond|\bac\b|furnace/i,
    service: 'hvac maintenance',
    startingDailyCents: 2000,
    keywords: ['ac tune up', 'hvac maintenance', 'air conditioner service near me', 'furnace tune up', 'hvac service'],
    negativeKeywords: ['jobs', 'job', 'hiring', 'salary', 'diy', 'how to', 'free', 'cheap', 'filter size', 'parts', 'school', 'training'],
    headlines: ['AC & Furnace Tune-Ups', 'HVAC Maintenance Visits', 'Book a Tune-Up Online', 'Local HVAC Service'],
    descriptions: ['Seasonal tune-ups for your AC and furnace. Pick a time online.', 'Tell us about your system and choose a visit that fits your schedule.'],
  },
  {
    id: 'hvac_repair',
    name: 'HVAC repair',
    industry: 'HVAC',
    match: /hvac|heating|cooling|air cond|\bac\b|furnace/i,
    service: 'hvac repair',
    startingDailyCents: 2500,
    keywords: ['ac repair', 'ac repair near me', 'air conditioner not cooling', 'furnace repair', 'heating repair near me', 'hvac repair'],
    negativeKeywords: ['jobs', 'job', 'hiring', 'salary', 'diy', 'how to', 'free', 'cheap', 'parts', 'capacitor', 'manual', 'reset'],
    headlines: ['AC & Heating Repair', 'Not Cooling? Book a Visit', 'Book a Repair Online', 'Local HVAC Repair'],
    descriptions: ['AC not cooling or heat not coming on? Describe it and pick a visit time online.', 'Tell us what your system is doing and choose an appointment that fits your schedule.'],
  },
  {
    id: 'plumbing',
    name: 'Plumbing',
    industry: 'Plumbing',
    match: /plumb|drain|water heater|sewer/i,
    service: 'plumbing',
    startingDailyCents: 2500,
    keywords: ['plumber near me', 'plumbing repair', 'water heater repair', 'drain cleaning service', 'leaking pipe repair', 'clogged drain'],
    negativeKeywords: ['jobs', 'job', 'hiring', 'salary', 'diy', 'how to', 'free', 'cheap', 'parts', 'supply', 'school', 'apprentice', 'snake rental'],
    headlines: ['Plumbing Repairs', 'Drains, Leaks & Water Heaters', 'Book a Plumber Online', 'Local Plumbing Service'],
    descriptions: ['Leaks, clogged drains and water heaters. Describe the problem and pick a time online.', 'Tell us what needs fixing and choose an appointment that fits your schedule.'],
  },
  {
    id: 'electrical',
    name: 'Electrical services',
    industry: 'Electrical',
    match: /electric/i,
    service: 'electrical',
    startingDailyCents: 2500,
    keywords: ['electrician near me', 'electrical repair', 'outlet repair', 'breaker panel repair', 'ceiling fan installation', 'ev charger installation'],
    negativeKeywords: ['jobs', 'job', 'hiring', 'salary', 'diy', 'how to', 'free', 'cheap', 'parts', 'supply', 'school', 'apprentice', 'wiring diagram'],
    headlines: ['Electrical Repairs', 'Panels, Outlets & Fans', 'Book an Electrician Online', 'Local Electrical Service'],
    descriptions: ['Outlets, panels, fans and chargers. Describe the job and pick a visit time online.', 'Tell us what you need and choose an appointment that fits your schedule.'],
  },
  {
    id: 'roofing',
    name: 'Roofing',
    industry: 'Roofing',
    match: /roof|gutter|shingle/i,
    service: 'roofing',
    startingDailyCents: 3000,
    keywords: ['roof repair', 'roof repair near me', 'roof leak repair', 'roofing contractor', 'roof replacement estimate', 'roof inspection'],
    negativeKeywords: ['jobs', 'job', 'hiring', 'salary', 'diy', 'how to', 'free', 'cheap', 'materials', 'supply', 'calculator', 'school'],
    headlines: ['Roof Repair & Inspection', 'Leaks, Shingles & Gutters', 'Book a Roof Visit Online', 'Local Roofing Service'],
    descriptions: ['Leaks, storm damage and inspections. Describe the roof and pick a visit time online.', 'Tell us what you noticed and choose an appointment that fits your schedule.'],
  },
]

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/
const CURATED_RE = /^[a-z_]{3,40}$/
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const keywordText = (t) => clean(t).toLowerCase().replace(/[^a-z0-9 '&.-]/g, '').replace(/\s+/g, ' ').trim()
const unique = (xs) => [...new Set(xs.filter(Boolean))]

// The curated templates that fit the business (industry and services), suggested first; the rest follow.
export function suggestTemplates(profile) {
  const haystack = [profile?.industry, ...serviceList(profile)].filter(Boolean).join(' ')
  const fits = (t) => t.match.test(haystack)
  return [...TEMPLATES.filter(fits), ...TEMPLATES.filter((t) => !fits(t))].map((t) => publicTemplate(t, fits(t)))
}
export const publicTemplate = (t, suggested = false) => ({
  id: t.id,
  name: t.name,
  industry: t.industry,
  suggested,
  startingDailyCents: t.startingDailyCents,
  keywords: t.keywords,
  negativeKeywords: t.negativeKeywords.length,
  headlines: t.headlines,
  descriptions: t.descriptions,
  landing: 'Your booking page (or your published website)',
  goals: ['A lead when the booking form is submitted', 'A booking when an appointment is confirmed'],
})

// The draft spec a curated template produces for THIS business: its name and town as headlines, its ZIP codes as the
// area, its exclusions as extra negatives, the budget it chose (floored at the platform minimum), its booking page.
// Every text goes through fitText and the claims filter; the result is validated by the normal draft path.
export function templateSpec(template, customer, profile, { dailyCents, bookingUrl }) {
  const towns = cityList(profile)
  const town = towns[0] || ''
  const claims = profile?.approvedClaims || []
  const keep = (texts, len) => unique(texts.map((t) => fitText(t, len)).filter((t) => t && !unapprovedClaims(t, claims).length))
  const localKeywords = town ? template.keywords.slice(0, 2).map((k) => `${k.replace(/ near me$/, '')} ${town.toLowerCase()}`) : []
  const keywords = unique([...template.keywords, ...localKeywords].map(keywordText)).slice(0, LIMITS.google.keywords).map((text) => ({ text, match: 'PHRASE' }))
  return {
    version: 1,
    platform: 'google',
    name: `${customer.name} — ${template.name}`,
    dailyBudgetCents: Math.max(LIMITS.minDailyBudgetCents, Number.isInteger(dailyCents) ? dailyCents : template.startingDailyCents),
    geo: { zips: profile?.serviceArea?.zips || [] },
    finalUrl: bookingUrl,
    google: {
      keywords,
      negativeKeywords: unique([...template.negativeKeywords, ...exclusionTerms(profile)].map(keywordText)).slice(0, LIMITS.google.negatives),
      headlines: keep([customer.name, ...template.headlines, ...(town ? [`Serving ${town}`] : [])], LIMITS.google.headline).slice(0, LIMITS.google.headlinesMax),
      descriptions: keep(template.descriptions, LIMITS.google.description).slice(0, LIMITS.google.descriptionsMax),
    },
    template: { source: 'curated', id: template.id },
  }
}

// An imported Search campaign of THIS business as a normalized draft template: what the owner wrote (keywords,
// negatives, the first ad's headlines and descriptions, its landing page when it is an https URL) and nothing tied to
// the account (no Google ids, no ad group ids, no location ids: the area comes from the business's own ZIP codes).
export function normalizeImported(row, profile) {
  const s = typeof row.settings === 'string' ? JSON.parse(row.settings || '{}') : row.settings || {}
  if (row.channel_type !== 'SEARCH' && row.channelType !== 'SEARCH') return { ok: false, error: 'unsupported_campaign_type' }
  const claims = profile?.approvedClaims || []
  const ad = (s.ads || []).find((a) => a.headlines?.length) || null
  const keep = (texts, len) => unique((texts || []).map((t) => fitText(t, len)).filter((t) => t && !unapprovedClaims(t, claims).length))
  const keywords = unique((s.keywords || []).map((k) => keywordText(k.text)))
    .filter((t) => t.length <= 80)
    .slice(0, LIMITS.google.keywords)
    .map((text) => ({ text, match: ['EXACT', 'PHRASE'].includes((s.keywords || []).find((k) => keywordText(k.text) === text)?.match) ? (s.keywords || []).find((k) => keywordText(k.text) === text).match : 'PHRASE' }))
  const headlines = keep(ad?.headlines, LIMITS.google.headline).slice(0, LIMITS.google.headlinesMax)
  const descriptions = keep(ad?.descriptions, LIMITS.google.description).slice(0, LIMITS.google.descriptionsMax)
  if (!keywords.length || headlines.length < LIMITS.google.headlinesMin || descriptions.length < LIMITS.google.descriptionsMin) return { ok: false, error: 'not_enough_to_copy' }
  const url = (s.finalUrls || []).find((u) => /^https:\/\//.test(String(u))) || null
  return {
    ok: true,
    spec: {
      version: 1,
      platform: 'google',
      name: clean(row.name).replace(/\s*\[gsu:[^\]]*\]$/, '').slice(0, 120) || 'Imported campaign',
      dailyBudgetCents: Math.max(LIMITS.minDailyBudgetCents, Number(row.daily_budget_cents ?? row.dailyBudgetCents) || LIMITS.minDailyBudgetCents),
      geo: { zips: profile?.serviceArea?.zips || [] },
      ...(url ? { finalUrl: url } : {}),
      google: { keywords, negativeKeywords: unique((s.negativeKeywords || []).map(keywordText)).slice(0, LIMITS.google.negatives), headlines, descriptions },
      template: { source: 'imported', externalId: String(row.external_id || row.externalId || '') },
    },
  }
}

// ---------- the business's own templates (ad_templates) ----------

const templatesReady = async (db) => {
  try {
    return Number((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'ad_templates'").first())?.n) === 1
  } catch {
    return false
  }
}

export async function listTemplates(db, customerId) {
  if (!(await templatesReady(db))) return { ready: false, saved: [] }
  const { results } = await db.prepare('SELECT id, name, source, spec, created_at FROM ad_templates WHERE customer = ?1 ORDER BY created_at DESC LIMIT 20').bind(customerId).all()
  return {
    ready: true,
    saved: results.map((r) => {
      let spec = {}
      try {
        spec = JSON.parse(r.spec)
      } catch {}
      return { id: r.id, name: r.name, source: r.source, createdAt: r.created_at, keywords: (spec.google?.keywords || []).map((k) => k.text), headlines: spec.google?.headlines || [], descriptions: spec.google?.descriptions || [], dailyBudgetCents: spec.dailyBudgetCents ?? null, landing: spec.finalUrl || null }
    }),
  }
}

async function insertTemplate(db, customerId, name, source, spec, now) {
  const count = await db.prepare('SELECT count(*) AS n FROM ad_templates WHERE customer = ?1').bind(customerId).first()
  if ((count?.n ?? 0) >= 20) return { ok: false, error: 'too_many_templates' }
  const id = randomToken(12)
  await db.prepare('INSERT INTO ad_templates (id, customer, name, source, spec, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, customerId, clean(name).slice(0, 120) || 'Template', source, JSON.stringify(spec).slice(0, 60000), now).run()
  return { ok: true, id }
}

// One of the business's own imported Search campaigns → a saved template (never another business's row).
export async function saveFromImported(env, customer, importedId, profile, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await templatesReady(db))) return { ok: false, error: 'not_ready' }
  if (!ID_RE.test(String(importedId || ''))) return { ok: false, error: 'not_found' }
  const row = await db.prepare("SELECT * FROM ad_imported_campaigns WHERE id = ?1 AND customer = ?2 AND platform = 'google'").bind(importedId, customer.id).first()
  if (!row) return { ok: false, error: 'not_found' }
  const n = normalizeImported(row, profile)
  if (!n.ok) return n
  return insertTemplate(db, customer.id, row.name, 'imported', n.spec, now)
}

// One of the business's own drafts → a saved template (the spec as the owner left it, minus its campaign id link).
export async function saveFromDraft(env, customer, campaignId, name, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!(await templatesReady(db))) return { ok: false, error: 'not_ready' }
  if (!ID_RE.test(String(campaignId || ''))) return { ok: false, error: 'not_found' }
  const row = await db.prepare("SELECT * FROM ad_campaigns WHERE id = ?1 AND customer = ?2 AND platform = 'google' AND status <> 'removed'").bind(campaignId, customer.id).first()
  if (!row) return { ok: false, error: 'not_found' }
  const spec = JSON.parse(row.spec)
  const { finalUrl, ...rest } = spec
  void finalUrl // carries the campaign id for attribution; a new draft gets its own
  return insertTemplate(db, customer.id, name || spec.name, 'saved', { ...rest, template: { source: 'saved', from: row.id } }, now)
}

export async function removeTemplate(env, customer, id) {
  const db = env.ONBOARDING_DB
  if (!(await templatesReady(db)) || !ID_RE.test(String(id || ''))) return { ok: false, error: 'not_found' }
  const r = await db.prepare('DELETE FROM ad_templates WHERE id = ?1 AND customer = ?2').bind(id, customer.id).run()
  return r.meta.changes ? { ok: true } : { ok: false, error: 'not_found' }
}

// Starts ONE Google draft from a curated or saved template (one open Google draft per business, as for plans). The
// draft's landing page is the business's booking page (or published website) carrying the new campaign id for
// attribution, unless a saved template keeps its own https landing page. Returns validation notes for the editor.
export async function startFromTemplate(env, customer, profile, { templateId, savedId, dailyCents }, { bookingUrl }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!profile) return { ok: false, error: 'profile_required' }
  let spec
  let source
  if (templateId != null) {
    const t = CURATED_RE.test(String(templateId)) ? TEMPLATES.find((x) => x.id === templateId) : null
    if (!t) return { ok: false, error: 'not_found' }
    spec = templateSpec(t, customer, profile, { dailyCents, bookingUrl })
    source = { source: 'curated', id: t.id, name: t.name }
  } else {
    if (!(await templatesReady(db)) || !ID_RE.test(String(savedId || ''))) return { ok: false, error: 'not_found' }
    const row = await db.prepare('SELECT * FROM ad_templates WHERE id = ?1 AND customer = ?2').bind(savedId, customer.id).first()
    if (!row) return { ok: false, error: 'not_found' }
    const saved = JSON.parse(row.spec)
    spec = { ...saved, dailyBudgetCents: Math.max(LIMITS.minDailyBudgetCents, Number.isInteger(dailyCents) ? dailyCents : saved.dailyBudgetCents || LIMITS.minDailyBudgetCents), geo: { zips: profile.serviceArea?.zips || [] }, finalUrl: saved.finalUrl || bookingUrl, template: { source: row.source, id: row.id } }
    source = { source: row.source, id: row.id, name: row.name }
  }
  const open = await openDraftIds(db, customer.id, 'google')
  if (open.length) return { ok: false, error: 'draft_exists', campaignIds: open }
  const saved = await saveDraft(env, customer, { spec, onlyIfNone: true }, now)
  if (!saved.ok) return saved
  // The booking-page landing URL carries our campaign id for attribution, so it is set once the id exists.
  if (spec.finalUrl === bookingUrl) await saveDraft(env, customer, { id: saved.id, spec: { ...spec, finalUrl: `${bookingUrl}?utm_source=google&utm_medium=paid&utm_campaign=${saved.id}` } }, now)
  const [errors] = validateSpec(spec, { approvedClaims: profile.approvedClaims || [] })
  return { ok: true, campaignId: saved.id, template: source, errors }
}
