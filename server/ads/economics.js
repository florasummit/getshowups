// What each source of inquiries led to, and what it cost, from records (server/ads/funnel.js rules: the cohort is inquiries
// created in the period, test records out). Platform-neutral: a source added to AD_SOURCES appears by itself. Read-only;
// recommendations are findings with their evidence and never a change, a budget or permission to spend.
import { isTestLead } from '../testdata.js'
import { AD_SOURCES, MIN, THRESHOLDS } from './funnel.js'

const DAY = 86_400_000
const PLATFORM = { google_ads: 'google', meta_ad_click: 'meta', meta_lead_form: 'meta', openai_ad_click: 'openai' }
const LABEL = { google: 'Google Ads', meta: 'Meta ads', openai: 'ChatGPT ads', google_ads_imported: 'Google campaigns you run yourself', untraced: 'Not traced to an ad', unknown: 'Ad spend not tied to a platform' }
const n = (v) => Number(v) || 0
const same = (a, b) => String(a).toLowerCase().trim() === String(b).toLowerCase().trim()

export async function channels(db, customerId, { days = 90, internal = '[]', economics = [], now = Date.now() } = {}) {
  const since = now - days * DAY
  const { results } = await db
    .prepare(
      `SELECT l.id, l.status, l.need, coalesce(la.source, '') AS source,
              (SELECT a.status FROM appointments a WHERE a.customer = l.customer AND a.lead_id = l.id AND a.status IN ('booked','showed','no_show') ORDER BY (a.status = 'showed') DESC, a.start_at DESC LIMIT 1) AS appt,
              (SELECT ao.work FROM appointments a JOIN appointment_outcomes ao ON ao.appointment_id = a.id AND ao.customer = a.customer WHERE a.customer = l.customer AND a.lead_id = l.id AND a.status = 'showed' ORDER BY a.start_at DESC LIMIT 1) AS work,
              (SELECT sum(x.amount_cents) FROM revenue_entries x JOIN appointments a ON a.id = x.appointment_id AND a.customer = x.customer WHERE x.customer = l.customer AND a.lead_id = l.id AND a.status = 'showed' AND x.kind = 'paid' AND x.id = (SELECT max(y.id) FROM revenue_entries y WHERE y.appointment_id = x.appointment_id AND y.kind = 'paid')) AS paid
         FROM leads l LEFT JOIN lead_attribution la ON la.lead_id = l.id AND la.customer = l.customer
        WHERE l.customer = ?1 AND l.created_at >= ?2 AND l.created_at <= ?4 AND NOT ${isTestLead('l', '?3')} LIMIT 5000`,
    )
    .bind(customerId, since, internal, now)
    .all()
  const from = new Date(since).toISOString().slice(0, 10)
  const spend = await db
    .prepare("SELECT coalesce(k.platform, 'unknown') AS platform, sum(m.spend_cents) AS s, sum(m.clicks) AS c, count(*) AS n, min(m.date) AS d FROM ad_metrics_daily m LEFT JOIN ad_campaigns k ON k.id = m.campaign_id AND k.customer = m.customer WHERE m.customer = ?1 AND m.date >= ?2 GROUP BY 1")
    .bind(customerId, from)
    .all()
    .then((r) => r.results)
    .catch(() => null)
  const rows = new Map()
  const row = (key) => {
    if (!rows.has(key)) rows.set(key, { key, channel: LABEL[key] || key, ad: key !== 'untraced' && key !== 'google_ads_imported', spendCents: null, clicks: null, inquiries: 0, qualified: 0, booked: 0, showed: 0, completed: 0, paidJobs: 0, paidCents: 0, margin: { cents: 0, jobs: 0 } })
    return rows.get(key)
  }
  const all = economics.find((e) => same(e.service, 'all services') && e.marginPct !== null)
  for (const l of results) {
    const key = AD_SOURCES.includes(l.source) ? PLATFORM[l.source] || l.source : l.source === 'google_ads_imported' ? l.source : 'untraced'
    const r = row(key)
    r.inquiries++
    if (l.status !== 'unqualified') r.qualified++
    if (l.appt) r.booked++
    if (l.appt === 'showed') r.showed++
    if (l.work === 'completed') r.completed++
    if (l.paid != null) {
      r.paidJobs++
      r.paidCents += n(l.paid)
      const own = economics.find((e) => e.marginPct !== null && l.need && String(l.need).toLowerCase().includes(e.service.toLowerCase())) || all
      if (own) {
        r.margin.cents += Math.round((n(l.paid) * own.marginPct) / 100)
        r.margin.jobs++
      }
    }
  }
  for (const s of spend || []) Object.assign(row(s.platform), n(s.n) ? { spendCents: n(s.s), clicks: n(s.c), firstDay: s.d } : {})
  // Every dollar the Ads page counts is here too: spend without a campaign row is shown, and with one ad source it is that one's.
  const ads = [...rows.values()].filter((r) => r.ad && r.key !== 'unknown')
  if (rows.has('unknown') && ads.length === 1 && ads[0].spendCents === null) {
    Object.assign(ads[0], { spendCents: rows.get('unknown').spendCents, clicks: rows.get('unknown').clicks, firstDay: rows.get('unknown').firstDay })
    rows.delete('unknown')
  }
  const per = (r, count) => (r.spendCents != null && count > 0 ? Math.round(r.spendCents / count) : null)
  const list = [...rows.values()].map(({ margin, ...r }) => ({
    ...r,
    paidCents: r.paidJobs ? r.paidCents : null,
    costPerInquiry: per(r, r.inquiries),
    costPerQualified: per(r, r.qualified),
    costPerBooking: per(r, r.booked),
    costPerCompleted: per(r, r.completed),
    // Only when every paid job has a margin the owner stated. An estimate, and says so.
    estimatedProfitAfterAdsCents: r.ad && r.spendCents != null && r.paidJobs > 0 && margin.jobs === r.paidJobs ? margin.cents - r.spendCents : null,
    bottleneck: bottleneck(r),
  }))
  return { days, spendReadable: spend !== null, channels: list.sort((a, b) => b.inquiries - a.inquiries) }
}

// The first step of the way that clearly loses most, with enough cases to say so; otherwise why it can't be said.
export function bottleneck(r) {
  if (r.ad && r.spendCents >= MIN.spendCents && r.clicks >= MIN.clicks && r.inquiries === 0) return { step: 'clicks to inquiries', evidence: `${r.clicks} clicks and no inquiry`, enough: true }
  if (r.inquiries < MIN.leads) return { step: null, evidence: `${r.inquiries} inquiries; at least ${MIN.leads} are needed to judge`, enough: false }
  if (r.qualified / r.inquiries < 1 - THRESHOLDS.outsideShare) return { step: 'inquiries to service area', evidence: `${r.inquiries - r.qualified} of ${r.inquiries} are outside the area`, enough: true }
  if (r.qualified && r.booked / r.qualified < THRESHOLDS.bookRate) return { step: 'qualified to booked', evidence: `${r.booked} of ${r.qualified} booked`, enough: true }
  if (r.booked >= MIN.past && r.showed / r.booked < THRESHOLDS.showRate) return { step: 'booked to showed up', evidence: `${r.showed} of ${r.booked} recorded as showed up (some may be upcoming or not marked yet)`, enough: true }
  if (r.showed >= MIN.attended && r.paidJobs === 0) return { step: 'payments not recorded', evidence: `${r.showed} visits happened, no payment recorded`, enough: true }
  return { step: null, evidence: 'no step stands out', enough: true }
}
