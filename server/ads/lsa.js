// Google Local Services Ads (pay per lead) for a business that already has them: the leads Google reports for its
// Local Services campaigns (read-only; lsa_leads, migration 0037), cost per charged lead from the campaign's own
// spend, and an honest readiness checklist for a business that has none. Verified against Google's documentation
// (docs/GOOGLE_ACQUISITION.md): the API cannot create a standalone Local Services campaign (Google's own setup does;
// status and budget are the mutable fields), lead resources are read-only and carry no cost field, and eligibility
// checks need a Google Business Profile listing id. Google's lead counts stay Google's: they are never mixed with
// GetShowUps' own leads and bookings. No consumer contact details are ever selected or stored.
import { readLocalServicesLeads } from './google.js'

// Callers (server/ads/imports.js) check that migration 0037 is applied; a missing table here is reported, never thrown.
const importsReady = async (db) => {
  try {
    return Number((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('lsa_leads', 'ad_imported_campaigns', 'ad_imported_metrics_daily')").first())?.n) === 3
  } catch {
    return false
  }
}

const DAY = 86_400_000
export const LEAD_WINDOW_DAYS = 90 // first read
export const LEAD_RESYNC_DAYS = 30 // later reads: statuses (booked, credited) keep changing for a while
export const LEAD_TYPE_LABEL = { PHONE_CALL: 'Phone call', MESSAGE: 'Message', BOOKING: 'Booking', COUPON: 'Coupon', UNKNOWN: 'Other' }
export const LEAD_STATUS_LABEL = { NEW: 'New', ACTIVE: 'Active', BOOKED: 'Booked', DECLINED: 'Declined', CONSUMER_DECLINED: 'Customer declined', EXPIRED: 'Expired', DISABLED: 'Disabled', WIPED_OUT: 'Removed', UNKNOWN: 'Other' }
const day = (ms) => new Date(ms).toISOString().slice(0, 10)

const lsaCampaigns = async (db, customerId) => (await db.prepare("SELECT id, external_id, first_seen_at FROM ad_imported_campaigns WHERE customer = ?1 AND platform = 'google' AND channel_type = 'LOCAL_SERVICES' AND status <> 'REMOVED'").bind(customerId).all()).results

// Reads Google's Local Services leads for a business with at least one Local Services campaign and keeps them in
// lsa_leads (upsert by Google's lead id). Nothing is read for businesses without such a campaign.
export async function syncLsaLeads(env, customerId, { now = Date.now() } = {}) {
  const db = env.ONBOARDING_DB
  if (!(await importsReady(db))) return { ok: false, error: 'not_ready' }
  const campaigns = await lsaCampaigns(db, customerId)
  if (!campaigns.length) return { ok: true, leads: 0, skipped: 'no_local_services_campaign' }
  const seen = await db.prepare('SELECT count(*) AS n FROM lsa_leads WHERE customer = ?1').bind(customerId).first()
  const since = day(now - (Number(seen?.n) > 0 ? LEAD_RESYNC_DAYS : LEAD_WINDOW_DAYS) * DAY)
  const r = await readLocalServicesLeads(env, customerId, since)
  if (!r.ok) return r
  const byExternal = new Map(campaigns.map((c) => [String(c.external_id), c.id]))
  let n = 0
  for (const l of r.leads) {
    await db
      .prepare(
        `INSERT INTO lsa_leads (id, customer, imported_id, lead_type, lead_status, charged, credit_state, category_id, created_at, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(customer, id) DO UPDATE SET imported_id = coalesce(?3, lsa_leads.imported_id), lead_type = ?4, lead_status = ?5, charged = ?6, credit_state = ?7, category_id = ?8, synced_at = ?10`,
      )
      .bind(l.id, customerId, byExternal.get(l.campaignExternalId || '') || null, l.type, l.status, l.charged ? 1 : 0, l.creditState, l.categoryId, l.createdAt, now)
      .run()
    n++
  }
  return { ok: true, leads: n, since }
}

// Google's leads for each Local Services campaign in the period: counts by type and status, charged leads, spend
// (from the campaign's own Google-reported cost) and cost per CHARGED lead (null without both). Recent leads are
// listed without any contact details. Keyed by our imported campaign id.
export async function lsaSummary(db, customerId, { days = 30, now = Date.now() } = {}) {
  if (!(await importsReady(db))) return {}
  const since = now - days * DAY
  const [{ results: leads }, { results: spend }] = await Promise.all([
    db.prepare('SELECT * FROM lsa_leads WHERE customer = ?1 AND created_at >= ?2 ORDER BY created_at DESC').bind(customerId, since).all(),
    db
      .prepare("SELECT m.imported_id, coalesce(sum(m.spend_cents),0) AS spend FROM ad_imported_metrics_daily m JOIN ad_imported_campaigns c ON c.id = m.imported_id WHERE m.customer = ?1 AND m.date >= ?2 AND c.channel_type = 'LOCAL_SERVICES' GROUP BY m.imported_id")
      .bind(customerId, day(since))
      .all(),
  ])
  const out = {}
  for (const s of spend) out[s.imported_id] = { total: 0, charged: 0, credited: 0, booked: 0, byType: {}, byStatus: {}, spendCents: s.spend, costPerChargedLeadCents: null, recent: [] }
  for (const l of leads) {
    const key = l.imported_id || 'unassigned'
    const o = (out[key] ||= { total: 0, charged: 0, credited: 0, booked: 0, byType: {}, byStatus: {}, spendCents: null, costPerChargedLeadCents: null, recent: [] })
    o.total++
    if (l.charged) o.charged++
    if (l.credit_state === 'CREDITED') o.credited++
    if (l.lead_status === 'BOOKED') o.booked++
    o.byType[l.lead_type] = (o.byType[l.lead_type] || 0) + 1
    o.byStatus[l.lead_status] = (o.byStatus[l.lead_status] || 0) + 1
    if (o.recent.length < 25) o.recent.push({ id: l.id, type: l.lead_type, status: l.lead_status, charged: Boolean(l.charged), creditState: l.credit_state, categoryId: l.category_id, createdAt: l.created_at })
  }
  for (const o of Object.values(out)) if (o.spendCents != null && o.charged > 0) o.costPerChargedLeadCents = Math.round(o.spendCents / o.charged)
  return out
}

// What a business without Local Services Ads must have before Google lets it run them. Facts only; every step is
// Google's own and the owner's: GetShowUps cannot verify a business, create the campaign or bypass billing.
// `facts` are what GetShowUps can see from its records (never a claim about Google's decision).
export function lsaReadiness({ industry = '', zips = [], profilePhone = false, hasLocalServicesCampaign = false, gbpConnected = null } = {}) {
  const trade = String(industry || '').toLowerCase()
  const likely = /pool|hvac|heating|cooling|air|plumb|electric|roof|landscap|lawn|clean|pest|garage|locksmith|handyman|mov|paint|window|carpet|appliance|tree|fenc|flooring|solar|water|junk|pressure/.test(trade)
  return {
    canCreateHere: false,
    hasLocalServicesCampaign,
    items: [
      { id: 'category', label: 'An eligible service category in your country', state: likely ? 'likely' : 'check', detail: trade ? `Google lists the categories it accepts; ${trade} is ${likely ? 'usually among them' : 'something to check in Google’s list'}.` : 'Add your industry in Settings so this can be checked.' },
      { id: 'location', label: 'A supported location', state: zips.length ? 'likely' : 'check', detail: zips.length ? 'Local Services Ads target by service area; your ZIP codes are on record.' : 'Add your service ZIP codes in Settings.' },
      { id: 'google_account', label: 'A Google account for the business', state: 'owner', detail: 'The sign-in you use for Google Ads works; Google ties Local Services to it.' },
      { id: 'business_profile', label: 'A verified Google Business Profile', state: gbpConnected === true ? 'done' : gbpConnected === false ? 'check' : 'owner', detail: 'Google links Local Services Ads to the Business Profile listing; verification happens with Google.' },
      { id: 'screening', label: 'Background, license and insurance checks (where Google requires them)', state: 'owner', detail: 'Google runs these per category and state; nobody can skip or speed them up.' },
      { id: 'billing', label: 'Billing set up in Google Ads', state: 'owner', detail: 'Google charges per lead to the payment method in your Google Ads account; GetShowUps never handles it.' },
      { id: 'phone', label: 'A business phone number', state: profilePhone ? 'done' : 'check', detail: profilePhone ? 'On record in Settings.' : 'Add it in Settings: Local Services leads are mostly calls.' },
    ],
    setupUrl: 'https://ads.google.com/local-services-ads/',
    note: 'Google only creates Local Services campaigns in its own setup (the Ads API cannot). Once one exists, its leads and cost per lead show here.',
  }
}
