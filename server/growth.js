// Admin → Growth (Measure | Simulate | Decide). Measure reads the existing metrics (server/metrics.js growth(),
// the sales funnel, ad spend) and labels every figure by what it is: live, test, estimated or unavailable, with its
// sample size and date range. Nothing here is a second metrics system: every number comes from the same queries the
// admin overview already uses, filtered the same way (test businesses and test leads excluded). Decide is a fixed,
// explainable rule set over Measure with minimum samples; it never spends, never changes a campaign, never forecasts.
import { customerRows, growth, SALES_BUSINESS } from './metrics.js'
import { internalEmails, isTestLead } from './testdata.js'
import { isTestBusinessSql } from './testbusiness.js'
import { stripeLiveEnabled } from './stripe.js'
import { baselineFrom, DEFAULTS, monthlyFunnel, normalizeAssumptions, FIELDS } from './growth-model.js'
import { SALES_PROFILE } from './sales.js'
import { salesAttribution } from './sales-attribution.js'

const DAY = 86_400_000
const REAL = (col) => `NOT ${isTestBusinessSql(col)}`
const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null)
// Plain words for the notes an admin reads: "1 business", "2 businesses" (never "business(es)"); "$12" from cents.
const count = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString('en-US')} ${Number(n || 0) === 1 ? one : many}`
const usd = (cents) => `$${(Math.round(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const NO_SALES = 'The GetShowUps sales assistant has not been created yet (Overview, under “GetShowUps sales setup”).'

// The listed plan price (the one the sales assistant quotes: server/sales.js), for modeling only. Never invented and
// never written anywhere: Stripe prices are Price ids the simulator cannot touch.
export function listedPriceCents() {
  const m = /\$(\d[\d,]*)(?:\.(\d{2}))?/.exec(SALES_PROFILE.services?.find((s) => s.name === 'Growth plan')?.price || '')
  return m ? Number(m[1].replace(/,/g, '')) * 100 + Number(m[2] || 0) : null
}

export async function growthMeasure(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const rows = await customerRows(env, now)
  const g = await growth(env, rows, now)
  const internal = internalEmails(env)
  const since30 = now - 30 * DAY
  const range = { days: 30, from: new Date(since30).toISOString(), to: new Date(now).toISOString() }
  const live = stripeLiveEnabled(env)
  // Leads across real businesses in the period (the customers' funnels), and the sales funnel (GetShowUps itself).
  const leads = (await db
    .prepare(`SELECT count(*) AS total, coalesce(sum(status <> 'unqualified'), 0) AS qualified, coalesce(sum(status = 'booked'), 0) AS booked FROM leads l WHERE l.created_at >= ?1 AND NOT ${isTestLead('l', '?2')} AND ${REAL('l.customer')}`)
    .bind(since30, internal)
    .first()) || {}
  const spend = (await db
    .prepare(`SELECT coalesce(sum(spend_cents), 0) AS cents, count(*) AS days, count(DISTINCT customer) AS businesses FROM ad_metrics_daily m WHERE m.date >= ?1 AND ${REAL('m.customer')}`)
    .bind(new Date(since30).toISOString().slice(0, 10))
    .first()
    .catch(() => ({ cents: 0, days: 0, businesses: 0 }))) || {}
  const spendMeasured = Number(spend.days || 0) > 0
  const s = g.sales
  // GetShowUps' OWN ad spend: the sales business's own campaigns only (the same rows server/sales-attribution.js reads).
  // Customers' ad spend above is their money and is never GetShowUps' acquisition cost.
  const own = s
    ? (await db
        .prepare('SELECT count(*) AS days, coalesce(sum(spend_cents), 0) AS cents FROM ad_metrics_daily WHERE customer = ?1 AND date >= ?2')
        .bind(SALES_BUSINESS, new Date(since30).toISOString().slice(0, 10))
        .first()
        .catch(() => null)) || {}
    : {}
  const ownMeasured = Number(own.days || 0) > 0
  // Prospect → business → paying, by source (90 days: a sale takes longer than the 30-day window above).
  const attr = await salesAttribution(env, { now, days: 90, internal }).catch(() => null)
  const att = attr && !attr.unavailable ? attr : null
  const sourceLabel = (r) => `${r.source.replace(/^link:/, '')}${r.campaign ? ` (${r.campaign})` : ''}`
  const bySourceNote = att?.bySource.length ? `By source, prospects → businesses${att.live ? ' → paying' : ''}: ${att.bySource.slice(0, 5).map((r) => `${sourceLabel(r)} ${r.prospects} → ${r.businessesCreated}${att.live ? ` → ${r.paying}` : ''}`).join(' · ')}` : null
  const b = g.billing
  // Test mode: the count of active test subscriptions (0 when there are none), never revenue.
  const testSubs = live ? null : b?.mode === 'test' ? b.testSubscriptions || 0 : 0
  const total = Number(leads.total || 0)
  const qualified = Number(leads.qualified || 0)
  const outcomes = s ? s.consultationsAttended + s.consultationsMissed : null
  // group: 'customers' = what your customers' businesses did · 'sales' = GetShowUps selling itself, and what it earns.
  const item = (group, key, label, value, kind, { n = null, note = null, unit = 'count' } = {}) => ({ key, group, label, value, kind, n, note, unit })
  const items = [
    item('customers', 'leads', 'Leads', total, 'live', { n: total, note: 'Across your customers’ businesses. Test leads and your own addresses are left out.' }),
    item('customers', 'qualifiedLeads', 'Qualified leads', qualified, 'live', { n: total, note: rate(qualified, total) == null ? 'No leads in the period.' : `${Math.round(rate(qualified, total) * 100)}% of ${count(total, 'lead')}.` }),
    item('customers', 'bookingConversion', 'Booking conversion (qualified leads that booked)', g.bookingConversion30, g.bookingConversion30 == null ? 'unavailable' : 'live', { unit: 'percent', n: qualified, note: g.bookingConversion30 == null ? 'No qualified leads in the period.' : `Of ${count(qualified, 'qualified lead')}.` }),
    item('customers', 'spend', 'Ad spend by your customers', spendMeasured ? Number(spend.cents) : null, spendMeasured ? 'live' : 'unavailable', { unit: 'cents', n: Number(spend.days || 0), note: spendMeasured ? `${count(spend.businesses, 'business', 'businesses')}, ${count(spend.days, 'campaign day')} reported by the ad platforms. Their money, not what GetShowUps spends to win customers.` : 'No ad spend reported in the period.' }),
    item('sales', 'salesLeads', 'Prospects', s ? s.leads : null, s ? 'live' : 'unavailable', { n: s?.leads ?? null, note: s ? 'People who left details in the sales chat or booked a consultation.' : NO_SALES }),
    item('sales', 'consultationsBooked', 'Consultations booked', s ? s.consultationsBooked : null, s ? 'live' : 'unavailable', { n: s?.qualifiedLeads ?? null, note: s ? `Of ${count(s.qualifiedLeads, 'qualified prospect')}.` : null }),
    item('sales', 'demoBookingRate', 'Consultation booking rate', s ? s.demoBookingRate : null, s?.demoBookingRate == null ? 'unavailable' : 'live', { unit: 'percent', n: s?.qualifiedLeads ?? null, note: s && s.demoBookingRate != null ? `Of ${count(s.qualifiedLeads, 'qualified prospect')}.` : null }),
    item('sales', 'consultationsAttended', 'Consultations attended', s ? s.consultationsAttended : null, s ? 'live' : 'unavailable', { n: outcomes, note: s ? `${s.consultationsMissed} missed. You record the outcome after each call.` : null }),
    item('sales', 'demoAttendanceRate', 'Consultation attendance rate', s ? s.demoAttendanceRate : null, s?.demoAttendanceRate == null ? 'unavailable' : 'live', { unit: 'percent', n: outcomes, note: s && s.demoAttendanceRate != null ? `Of ${count(outcomes, 'consultation')} with a recorded outcome.` : null }),
    item('sales', 'salesBusinesses', 'Prospects who created a business (90 days)', att ? att.businessesCreated : null, att ? 'live' : 'unavailable', { n: att?.prospects ?? null, note: att ? bySourceNote || `Of ${count(att.prospects, 'prospect')}, matched by the owner’s sign-in. Counts only.` : s ? 'This could not be read just now.' : NO_SALES }),
    item('sales', 'salesPaying', 'Prospects now paying (90 days)', att?.paying ?? null, att?.live ? 'live' : att ? 'test' : 'unavailable', { n: att?.businessesCreated ?? null, note: att?.live ? 'Businesses created by prospects that have an active paid subscription.' : 'Billing is in test mode, so no prospect counts as paying.' }),
    item('sales', 'payingCustomers', 'Paying customers', live ? (b?.payingCustomers ?? null) : testSubs, live ? (b?.payingCustomers == null ? 'unavailable' : 'live') : 'test', { note: live ? 'Subscriptions paid in live billing.' : `Billing is in test mode: ${count(testSubs ?? 0, 'active test subscription')}, none of it revenue.` }),
    item('sales', 'mrr', 'MRR', live ? (b?.mrrCents ?? null) : null, live ? (b?.mrrCents == null ? 'unavailable' : 'live') : 'unavailable', { unit: 'cents', note: live ? null : 'Live billing is not switched on yet.' }),
    item('sales', 'ownSpend', 'GetShowUps’ own ad spend', ownMeasured ? Number(own.cents) : null, ownMeasured ? 'live' : 'unavailable', { unit: 'cents', n: Number(own.days || 0), note: ownMeasured ? `${count(own.days, 'campaign day')} of the sales business’s own campaigns, reported by the ad platforms.` : 'GetShowUps runs no ad campaigns of its own with reported spend.' }),
    item('sales', 'cac', 'Cost to win a customer (GetShowUps’ own ads, 90 days)', att?.cacCents ?? null, att?.cacCents == null ? 'unavailable' : 'live', { unit: 'cents', n: att?.paying ?? null, note: att?.cacCents != null ? `${usd(att.spendCents)} of GetShowUps’ own ad spend ÷ ${count(att.paying, 'paying customer')} who came in as prospects.` : 'Needs GetShowUps’ own reported ad spend and at least one paying customer who came in as a prospect, in live billing.' }),
    item('sales', 'retention', 'Retention (customers active 30 days after setup)', g.retention30, g.retention30 == null ? 'unavailable' : 'live', { unit: 'percent', note: g.retention30 == null ? 'No customer has been set up for 30 days yet.' : null }),
  ]
  // What the simulator can be prefilled with (null where not measured). Closed deals: paying customers are counted
  // only in live mode; in test mode nothing closes commercially.
  const measured = {
    leads30: s ? s.leads : null,
    qualified30: s ? s.qualifiedLeads : null,
    booked30: s ? s.consultationsBooked : null,
    attended30: s ? s.consultationsAttended : null,
    closed30: live ? (b?.payingCustomers ?? null) : null,
    // Only GetShowUps' own spend may prefill the simulator's "Acquisition spend"; customers' ad spend never does.
    spend30Cents: ownMeasured ? Number(own.cents) : null,
    payingCustomers: live ? (b?.payingCustomers ?? null) : null,
    mrrCents: live ? (b?.mrrCents ?? null) : null,
    priceMonthlyCents: listedPriceCents(),
  }
  // billing + retention30: the same facts the admin Overview shows (server/metrics.js growth()), so both pages format
  // MRR, Paying customers and Retention through one function (src/admin/figures.js).
  return { generatedAt: now, range, billingMode: live ? 'live' : 'test', items, measured, customers: g.customers, salesExists: Boolean(s), billing: g.billing, retention30: g.retention30, salesAttribution: att }
}

// ---------- Decide: the most consequential MEASURABLE bottleneck, with a concrete experiment ----------
// Rules run along the funnel; a stage is judged only with enough cases (MIN); the first stage below its threshold is the
// bottleneck. Upside = the model's monthly new customers and MRR if that one rate moved up by 10 points, everything
// else as measured/assumed. Never recommends more spend; never changes anything.
export const MIN = { leads: 10, qualified: 8, booked: 5, attended: 5 }
export const THRESHOLDS = { qualificationRate: 0.5, bookingRate: 0.3, attendanceRate: 0.7, closeRate: 0.25 }
const EXPERIMENTS = {
  volume: { title: 'Get prospects flowing before judging rates', cost: 'No money', effort: 'Low', evidence: 'insufficient' },
  qualificationRate: { title: 'Improve lead qualification', experiment: 'Change the sales assistant’s opening question to ask what the business does and how inquiries arrive today, and add the two most common disqualifiers to its approved answers. Compare qualified share over the next 20 leads.', cost: 'No money', effort: 'Low' },
  bookingRate: { title: 'Improve the consultation booking offer', experiment: 'Have the assistant offer two concrete times right after the first qualifying answer, and add a visible "Book a 20-minute call" entry on the homepage. Compare booking rate over the next 10 qualified prospects.', cost: 'No money', effort: 'Low' },
  attendanceRate: { title: 'Reduce missed consultations', experiment: 'Turn on confirmation and reminder emails for the sales business (sending real messages needs your approval first) and send a one-line agenda the day before. Compare attendance over the next 10 booked calls.', cost: 'No money (email provider already configured)', effort: 'Medium (needs the messaging approval)' },
  closeRate: { title: 'Improve the close', experiment: 'Run every consultation from the sales playbook’s objection list and end with a dated next step; record the outcome the same day. Compare closes over the next 10 attended calls.', cost: 'No money', effort: 'Low' },
}
const strength = (n, min) => (n >= 5 * min ? 'strong' : n >= 2 * min ? 'moderate' : 'weak')
const quoted = (acts) => acts.map((a) => `“${a.title}”`).join(' and ')

// The next step in the prepared plan, from what Activities has RECORDED (server/acquisition.js acquisitionOverview):
// follow-ups that are due come first, then an approved batch that was never sent, then the first activity still only
// prepared. Activities that cost money are never suggested here (spend is the founder's separate decision), and
// nothing is sent by this page. → { text, activities: [titles named] }
export function planStep(acquisition) {
  const acts = (acquisition?.activities || []).filter((a) => !a.derived && !a.paid && a.codes?.length)
  if (!acts.length) return { text: 'Work through the prepared activities on the Activities tab, in order.', activities: [] }
  const named = (text, list) => ({ text, activities: list.map((a) => a.title) })
  const due = acts.filter((a) => a.followUpsDue > 0)
  if (due.length) {
    const n = due.reduce((t, a) => t + a.followUpsDue, 0)
    return named(`Start with the ${count(n, 'follow-up')} now due in ${quoted(due)}: reply once in the same thread, then mark each code “Followed up”.`, due)
  }
  const approved = acts.filter((a) => a.status?.approved > 0)
  if (approved.length) {
    const n = approved.reduce((t, a) => t + a.status.approved, 0)
    return named(`Send the approved batch: ${count(n, 'approved code')} in ${quoted(approved.slice(0, 2))} ${n === 1 ? 'has' : 'have'} not been sent. Mark each one “Sent” after you send it yourself.`, approved.slice(0, 2))
  }
  const prepared = acts.filter((a) => a.status?.prepared > 0)
  const sent = Number(acquisition.totals?.sent || 0)
  if (prepared.length && !sent) return named(`Nothing has been sent yet. Approve and send the first prepared activity, ${quoted(prepared.slice(0, 1))} (${count(prepared[0].status.prepared, 'code')} prepared)${prepared[1] ? `, then ${quoted(prepared.slice(1, 2))}` : ''}.`, prepared.slice(0, 2))
  if (prepared.length) return named(`${count(sent, 'code')} sent so far. Next in the plan: ${quoted(prepared.slice(0, 1))} (${count(prepared[0].status.prepared, 'code')} still prepared).`, prepared.slice(0, 1))
  return named(`Every prepared code has been sent. Add new codes to the activity that brought the most prospects, starting with ${quoted(acts.slice(0, 1))}.`, acts.slice(0, 1))
}

// `acquisition` = the Activities view (optional). A count that Measure shows as unavailable (no sales business:
// measured.leads30 is null) is never stated as 0 here.
export function decide(measure, acquisition = null) {
  const m = measure.measured || {}
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const leads = n(m.leads30)
  const base = normalizeAssumptions(baselineFrom(m).assumptions)
  const plan = planStep(acquisition)
  if (m.leads30 == null) {
    return { bottleneck: 'volume', ...EXPERIMENTS.volume, title: 'Set up the sales assistant, then start the plan', experiment: `Create the GetShowUps sales assistant and connect its calendar (Overview, under “GetShowUps sales setup”) so the activity links open and prospects are counted. ${plan.text}`, activities: plan.activities, sample: {}, why: 'Prospects can’t be counted yet, so no conversion rate can be judged.', upside: null }
  }
  if (leads < MIN.leads) {
    return { bottleneck: 'volume', ...EXPERIMENTS.volume, experiment: `${plan.text} Then watch prospects per week on the Activities tab.`, activities: plan.activities, sample: { leads }, why: `${count(leads, 'prospect')} in 30 days: too few to judge any conversion rate (the first rate is judged at ${MIN.leads} prospects).`, upside: null }
  }
  const stages = [
    ['qualificationRate', n(m.qualified30), leads, MIN.leads],
    ['bookingRate', n(m.booked30), n(m.qualified30), MIN.qualified],
    ['attendanceRate', n(m.attended30), n(m.booked30), MIN.booked],
    ['closeRate', n(m.closed30), n(m.attended30), MIN.attended],
  ]
  for (const [key, num, den, min] of stages) {
    if (den < min) return { bottleneck: 'volume', title: `Not enough cases yet at “${FIELDS[key].label}”`, experiment: `Keep the funnel running until ${min} cases reach this step (${den} so far); the earlier steps meet their thresholds. ${plan.text}`, activities: plan.activities, cost: 'No money', effort: 'Low', evidence: 'insufficient', sample: { [key]: { num, den } }, why: `Rates are judged only with at least ${min} cases.`, upside: null }
    const r = rate(num, den)
    if (r != null && r < THRESHOLDS[key]) {
      const improved = monthlyFunnel({ ...base, [key]: Math.min(1, base[key] + 0.1) })
      const current = monthlyFunnel(base)
      return {
        bottleneck: key,
        ...EXPERIMENTS[key],
        activities: [],
        evidence: strength(den, min),
        sample: { [key]: { num, den, rate: r, threshold: THRESHOLDS[key] } },
        why: `${Math.round(r * 100)}% at this step (${num} of ${den}) is below the ${Math.round(THRESHOLDS[key] * 100)}% threshold; earlier steps meet theirs.`,
        upside: { ratePoints: 10, newCustomersPerMonth: improved.newCustomers - current.newCustomers, newMrrCentsPerMonth: improved.newMrrCents - current.newMrrCents, assumptions: base, note: 'Scenario arithmetic from the measured rates and the listed price; not a forecast.' },
      }
    }
  }
  return { bottleneck: null, title: 'No stage below its threshold', experiment: `Keep measuring. The next experiment is more prospects at the same quality: ${plan.text}`, activities: plan.activities, cost: 'No money for the prepared activities; paid tests need your approval', effort: 'Medium', evidence: strength(leads, MIN.leads), sample: { leads }, why: 'Every measured rate meets its threshold with enough cases.', upside: null }
}

export const simulatorDefaults = DEFAULTS
