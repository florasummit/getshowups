// The acquisition funnel: ONE definition of results, used by the Ads screen, the Overview tile and diagnostics.
//   spend (Google/Meta, synced) → leads → qualified → booked → attended → completed → revenue (estimated / invoiced / paid)
// Cohort: leads CREATED in the period (test records excluded, same rule as everywhere: server/testdata.js), followed to
// their bookings and outcomes, so every stage shares one denominator. scope 'ads' = leads attributed to a GetShowUps
// campaign (lead_attribution); 'all' = every lead. Nothing is estimated: a cost or rate is null when what it divides by
// is missing or zero; ROAS uses PAID revenue only. Attribution is never inferred: unattributed leads are counted as such.
import { isTestLead } from '../testdata.js'
import { CURRENT_REVENUE_SQL, revenueReady } from '../revenue.js'

const DAY = 86_400_000
export const AD_SOURCES = ['google_ads', 'meta_ad_click', 'meta_lead_form']
export const STALE_HOURS = 36
const inList = (xs) => xs.map((x) => `'${x}'`).join(',')

export async function funnel(db, customerId, { days = 30, scope = 'ads', internal = '[]', now = Date.now() } = {}) {
  const since = now - days * DAY
  const sinceDay = new Date(since).toISOString().slice(0, 10)
  const adsOnly = scope === 'ads'
  const scopeSql = adsOnly ? `AND a.source IN (${inList(AD_SOURCES)})` : ''
  const spend = await db
    .prepare('SELECT count(*) AS n, coalesce(sum(spend_cents),0) AS s, coalesce(sum(clicks),0) AS c, max(date) AS last_day, max(fetched_at) AS fetched FROM ad_metrics_daily WHERE customer = ?1 AND date >= ?2')
    .bind(customerId, sinceDay)
    .first()
  const measured = (spend?.n ?? 0) > 0
  const leads = await db
    .prepare(
      `SELECT count(*) AS n,
              coalesce(sum(l.status <> 'unqualified'), 0) AS qualified,
              coalesce(sum(l.status = 'unqualified'), 0) AS outside_area,
              coalesce(sum(a.source IN (${inList(AD_SOURCES)})), 0) AS from_ads
         FROM leads l LEFT JOIN lead_attribution a ON a.lead_id = l.id AND a.customer = l.customer
        WHERE l.customer = ?1 AND l.created_at >= ?2 AND NOT ${isTestLead('l', '?3')} ${scopeSql}`,
    )
    .bind(customerId, since, internal)
    .first()
  // All leads in the period (regardless of scope), for attribution coverage; leads from campaigns the business runs
  // itself in Google Ads (imported, read-only) are counted apart: their spend is not GetShowUps' campaign spend.
  const all = await db
    .prepare(`SELECT count(*) AS n, coalesce(sum(a.source = 'google_ads_imported'), 0) AS imported FROM leads l LEFT JOIN lead_attribution a ON a.lead_id = l.id AND a.customer = l.customer WHERE l.customer = ?1 AND l.created_at >= ?2 AND NOT ${isTestLead('l', '?3')}`)
    .bind(customerId, since, internal)
    .first()
  const withRevenue = await revenueReady(db)
  const cohortJoin = `FROM appointments p
         JOIN leads l ON l.id = p.lead_id AND l.customer = p.customer
         LEFT JOIN lead_attribution a ON a.lead_id = l.id AND a.customer = l.customer
         LEFT JOIN appointment_outcomes o ON o.appointment_id = p.id AND o.customer = p.customer`
  const cohortWhere = `p.customer = ?1 AND l.created_at >= ?2 AND NOT ${isTestLead('l', '?3')} ${scopeSql}`
  // Stages count LEADS, each once, at the furthest real step (a lead that cancelled and rebooked is booked, not
  // cancelled; a no-show who later showed up attended). Only real bookings count: 'pending' is a reservation in
  // progress (or abandoned), never a booking.
  const a = await db
    .prepare(
      `SELECT coalesce(sum(live > 0), 0) AS booked, coalesce(sum(past > 0), 0) AS past,
              coalesce(sum(showed > 0 OR no_show > 0), 0) AS recorded, coalesce(sum(showed > 0), 0) AS attended,
              coalesce(sum(showed = 0 AND no_show > 0), 0) AS no_show, coalesce(sum(completed > 0), 0) AS completed,
              coalesce(sum(live = 0 AND cancelled > 0), 0) AS cancelled
         FROM (SELECT l.id,
                      sum(p.status IN ('booked','showed','no_show')) AS live,
                      sum(p.status IN ('booked','showed','no_show') AND p.start_at <= ?4) AS past,
                      sum(p.status = 'showed') AS showed, sum(p.status = 'no_show') AS no_show,
                      sum(p.status = 'showed' AND o.work = 'completed') AS completed, sum(p.status = 'cancelled') AS cancelled
                 ${cohortJoin} WHERE ${cohortWhere} GROUP BY l.id)`,
    )
    .bind(customerId, since, internal, now)
    .first()
  // Money is per VISIT that happened (each is a job): the current amount of each kind, never mixed with another kind.
  const m = await db
    .prepare(
      `SELECT sum(o.value_cents) AS estimated, coalesce(sum(o.value_cents IS NOT NULL), 0) AS estimated_n
              ${withRevenue ? `, sum(rev.invoiced) AS invoiced, coalesce(sum(rev.invoiced IS NOT NULL), 0) AS invoiced_n, sum(rev.paid) AS paid, coalesce(sum(rev.paid IS NOT NULL), 0) AS paid_n` : ''}
         ${cohortJoin} ${withRevenue ? `LEFT JOIN (${CURRENT_REVENUE_SQL}) rev ON rev.appointment_id = p.id` : ''}
        WHERE p.status = 'showed' AND ${cohortWhere}`,
    )
    .bind(customerId, since, internal)
    .first()
  const n = (v) => Number(v) || 0
  const stages = {
    leads: n(leads?.n),
    qualified: n(leads?.qualified),
    // Kept leads not in a listed ZIP (waiting for, or declined by, the owner's coverage decision). Never "qualified";
    // an approved request becomes qualified.
    outsideArea: n(leads?.outside_area),
    booked: n(a?.booked),
    cancelled: n(a?.cancelled),
    past: n(a?.past),
    outcomeRecorded: n(a?.recorded),
    attended: n(a?.attended),
    noShow: n(a?.no_show),
    completed: n(a?.completed),
  }
  const money = (sum, count) => (n(count) > 0 ? n(sum) : null)
  const revenue = {
    estimatedCents: money(m?.estimated, m?.estimated_n),
    estimatedJobs: n(m?.estimated_n),
    invoicedCents: withRevenue ? money(m?.invoiced, m?.invoiced_n) : null,
    invoicedJobs: n(m?.invoiced_n),
    paidCents: withRevenue ? money(m?.paid, m?.paid_n) : null,
    paidJobs: n(m?.paid_n),
  }
  // Costs only for ad leads (spend is ad spend), only with measured spend and something to divide by.
  const per = (count) => (adsOnly && measured && count > 0 ? Math.round(spend.s / count) : null)
  const fetchedAt = spend?.fetched ?? null
  return {
    range: { days, from: new Date(since).toISOString(), to: new Date(now).toISOString() },
    scope: adsOnly ? 'ads' : 'all',
    spend: { cents: measured ? n(spend.s) : null, clicks: measured ? n(spend.c) : null, lastDay: spend?.last_day ?? null, fetchedAt, stale: measured && fetchedAt != null && now - fetchedAt > STALE_HOURS * 3_600_000 },
    stages,
    revenue,
    cost: { perLead: per(stages.leads), perQualified: per(stages.qualified), perBooking: per(stages.booked), perAttended: per(stages.attended), perCompleted: per(stages.completed) },
    // Return on ad spend from money actually received; null without both.
    roas: adsOnly && measured && n(spend.s) > 0 && revenue.paidCents != null ? Math.round((revenue.paidCents / n(spend.s)) * 100) / 100 : null,
    attribution: { allLeads: n(all?.n), adLeads: adsOnly ? stages.leads : n(leads?.from_ads), importedLeads: n(all?.imported), unattributed: n(all?.n) - (adsOnly ? stages.leads : n(leads?.from_ads)) - n(all?.imported) },
    revenueTracking: withRevenue,
  }
}

// ---------- diagnostics ----------
// Deterministic, explainable rules over the funnel; each finding states its numbers, sample and limitation. A rate is
// judged only with enough cases (MIN); otherwise the finding says there isn't enough data. Ordered along the funnel
// (the first broken step matters most). Never recommends more spend; never acts by itself.
export const MIN = { leads: 10, past: 5, recorded: 8, attended: 5, spendCents: 5000, clicks: 30 }
export const THRESHOLDS = { bookRate: 0.3, recordedShare: 0.6, showRate: 0.7, outsideShare: 0.3 }
const pct = (a, b) => Math.round((a / b) * 100)
const usd = (c) => `$${(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

export function diagnose(f) {
  const s = f.stages
  const out = []
  const add = (id, level, title, detail, sample) => out.push({ id, level, title, detail, sample })
  if (f.scope === 'ads' && f.spend.cents != null && f.spend.cents >= MIN.spendCents && (f.spend.clicks ?? 0) >= MIN.clicks && s.leads === 0)
    add(
      'tracking',
      'act',
      'Ads are spending, but no leads are recorded from them',
      `${usd(f.spend.cents)} spent and ${f.spend.clicks} clicks in ${f.range.days} days, with no lead tied to an ad. Check that your booking page and contact form work before spending more.`,
      `${f.spend.clicks} clicks`,
    )
  if (f.spend.stale) add('stale', 'watch', 'Ad spend figures are out of date', 'Spend and clicks haven’t been refreshed from Google in over a day and a half; costs below may be behind.', null)
  if (s.leads < MIN.leads) {
    if (s.leads > 0 || f.spend.cents)
      add('sample', 'info', 'Not enough leads yet to judge', `${s.leads} lead${s.leads === 1 ? '' : 's'} in ${f.range.days} days. Rates become meaningful from about ${MIN.leads}; until then, look at each lead.`, `${s.leads} leads`)
  } else {
    // Leads outside the listed ZIPs can't book until the owner answers: their own finding, and the booking rate is
    // judged on in-area leads only (so one problem isn't reported twice).
    const outside = s.outsideArea ?? 0
    if (outside / s.leads >= THRESHOLDS.outsideShare)
      add(
        'outside_area',
        'act',
        'Many leads are outside your service area',
        `${outside} of ${s.leads} leads (${pct(outside, s.leads)}%) were outside your listed ZIP codes. ${f.scope === 'ads' ? 'Check that the campaign’s locations match your service ZIP codes, and answer' : 'Answer'} their service-area requests in Appointments.`,
        `${s.leads} leads`,
      )
    const inArea = s.leads - outside
    if (inArea >= MIN.leads && s.booked / inArea < THRESHOLDS.bookRate)
      add(
        'lead_to_booking',
        'act',
        'Most leads aren’t booking',
        `${outside ? `${inArea} leads in your area` : `${s.leads} leads`}, but only ${s.booked} booked (${pct(s.booked, inArea)}%). Review booking availability and how fast you follow up before increasing ad spend.`,
        `${inArea} leads`,
      )
  }
  if (s.past >= MIN.past && s.outcomeRecorded / s.past < THRESHOLDS.recordedShare)
    add(
      'outcomes_missing',
      'act',
      'Visits aren’t being marked',
      `${s.past - s.outcomeRecorded} of ${s.past} past visits have no outcome. Mark who showed up so attendance and cost per visit are accurate.`,
      `${s.past} past visits`,
    )
  if (s.outcomeRecorded >= MIN.recorded && s.attended / s.outcomeRecorded < THRESHOLDS.showRate)
    add(
      'attendance',
      'act',
      'Many booked customers don’t show up',
      `${s.noShow} of ${s.outcomeRecorded} recorded visits were no-shows (${pct(s.noShow, s.outcomeRecorded)}%). Confirmations and a reminder the day before usually help.`,
      `${s.outcomeRecorded} recorded visits`,
    )
  if (f.revenueTracking && s.attended >= MIN.attended && f.revenue.paidCents == null)
    add('revenue_missing', 'watch', 'No payments recorded yet', `${s.attended} visits happened but no payment is recorded. Record what you were paid to see return on ad spend.`, `${s.attended} visits`)
  const order = { act: 0, watch: 1, info: 2 }
  return out.sort((x, y) => order[x.level] - order[y.level])
}
