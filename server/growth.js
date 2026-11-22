// Admin → Growth (Measure | Simulate | Decide). Measure reads the existing metrics (server/metrics.js growth(),
// the sales funnel, ad spend) and labels every figure by what it is: live, test, estimated or unavailable, with its
// sample size and date range. Nothing here is a second metrics system: every number comes from the same queries the
// admin overview already uses, filtered the same way (test businesses and test leads excluded). Decide is a fixed,
// explainable rule set over Measure with minimum samples; it never spends, never changes a campaign, never forecasts.
import { customerRows, growth } from './metrics.js'
import { internalEmails, isTestLead } from './testdata.js'
import { isTestBusinessSql } from './testbusiness.js'
import { stripeLiveEnabled } from './stripe.js'
import { baselineFrom, DEFAULTS, monthlyFunnel, normalizeAssumptions, FIELDS } from './growth-model.js'
import { SALES_PROFILE } from './sales.js'

const DAY = 86_400_000
const REAL = (col) => `NOT ${isTestBusinessSql(col)}`
const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null)

// The listed plan price (the one the sales assistant quotes: server/sales.js), for modeling only. Never invented and
// never written anywhere: Stripe prices are Price ids the simulator cannot touch.
export function listedPriceCents() {
  const m = /\$(\d[\d,]*)(?:\.(\d{2}))?/.exec(SALES_PROFILE.services?.[0]?.price || '')
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
  const b = g.billing
  // Test mode: the count of active Stripe test subscriptions (0 when there are none), never revenue.
  const testSubs = live ? null : b?.mode === 'test' ? b.testSubscriptions || 0 : 0
  const item = (key, label, value, kind, { n = null, note = null, unit = 'count' } = {}) => ({ key, label, value, kind, n, note, unit })
  const items = [
    item('leads', 'Leads (all customers)', Number(leads.total || 0), 'live', { n: Number(leads.total || 0), note: 'Real businesses only; test leads and internal addresses excluded.' }),
    item('qualifiedLeads', 'Qualified leads (all customers)', Number(leads.qualified || 0), 'live', { n: Number(leads.total || 0), note: 'Share of leads: ' + (rate(Number(leads.qualified || 0), Number(leads.total || 0)) == null ? '—' : `${Math.round(rate(Number(leads.qualified || 0), Number(leads.total || 0)) * 100)}%`) }),
    item('salesLeads', 'Prospects (GetShowUps sales chat)', s ? s.leads : null, s ? 'live' : 'unavailable', { n: s?.leads ?? null, note: s ? 'People who left details in the sales chat or booked a consultation.' : 'The GetShowUps sales business does not exist yet.' }),
    item('consultationsBooked', 'Consultations booked', s ? s.consultationsBooked : null, s ? 'live' : 'unavailable', { n: s?.qualifiedLeads ?? null, note: s ? `Of ${s.qualifiedLeads} qualified prospects.` : null }),
    item('consultationsAttended', 'Consultations attended', s ? s.consultationsAttended : null, s ? 'live' : 'unavailable', { n: s ? s.consultationsAttended + s.consultationsMissed : null, note: s ? `${s.consultationsMissed} missed; recorded by the founder after each call.` : null }),
    item('payingCustomers', 'Paying customers', live ? (b?.payingCustomers ?? null) : testSubs, live ? (b?.payingCustomers == null ? 'unavailable' : 'live') : 'test', { note: live ? 'Live Stripe subscriptions recorded as live mode.' : `Stripe is in test mode: ${testSubs ?? 0} active test subscription(s), none of it revenue.` }),
    item('mrr', 'MRR', live ? (b?.mrrCents ?? null) : null, live ? (b?.mrrCents == null ? 'unavailable' : 'live') : 'unavailable', { unit: 'cents', note: live ? null : 'No live billing yet (STRIPE_LIVE_ENABLED off).' }),
    item('bookingConversion', 'Booking conversion (qualified → booked, all customers)', g.bookingConversion30, g.bookingConversion30 == null ? 'unavailable' : 'live', { unit: 'percent', n: Number(leads.qualified || 0) }),
    item('demoBookingRate', 'Consultation booking rate (sales)', s ? s.demoBookingRate : null, s?.demoBookingRate == null ? 'unavailable' : 'live', { unit: 'percent', n: s?.qualifiedLeads ?? null }),
    item('demoAttendanceRate', 'Consultation attendance rate (sales)', s ? s.demoAttendanceRate : null, s?.demoAttendanceRate == null ? 'unavailable' : 'live', { unit: 'percent', n: s ? s.consultationsAttended + s.consultationsMissed : null }),
    item('spend', 'Acquisition spend (ads, all customers)', spendMeasured ? Number(spend.cents) : null, spendMeasured ? 'live' : 'unavailable', { unit: 'cents', n: Number(spend.days || 0), note: spendMeasured ? `${spend.businesses} business(es), ${spend.days} campaign-days synced from the platforms.` : 'No ad spend synced in the period (no live campaigns).' }),
    item('cac', 'Customer acquisition cost', null, 'unavailable', { unit: 'cents', note: 'Needs measured spend and paying customers won in the same period.' }),
    item('retention', 'Retention (customers active 30 days after setup)', g.retention30, g.retention30 == null ? 'unavailable' : 'live', { unit: 'percent' }),
  ]
  // What the simulator can be prefilled with (null where not measured). Closed deals: paying customers are counted
  // only in live mode; in test mode nothing closes commercially.
  const measured = {
    leads30: s ? s.leads : null,
    qualified30: s ? s.qualifiedLeads : null,
    booked30: s ? s.consultationsBooked : null,
    attended30: s ? s.consultationsAttended : null,
    closed30: live ? (b?.payingCustomers ?? null) : null,
    spend30Cents: spendMeasured ? Number(spend.cents) : null,
    payingCustomers: live ? (b?.payingCustomers ?? null) : null,
    mrrCents: live ? (b?.mrrCents ?? null) : null,
    priceMonthlyCents: listedPriceCents(),
  }
  return { generatedAt: now, range, billingMode: live ? 'live' : 'test', items, measured, customers: g.customers }
}

// ---------- Decide: the most consequential MEASURABLE bottleneck, with a concrete experiment ----------
// Rules run along the funnel; a stage is judged only with enough cases (MIN); the first stage below its threshold is the
// bottleneck. Upside = the model's monthly new customers and MRR if that one rate moved up by 10 points, everything
// else as measured/assumed. Never recommends more spend; never changes anything.
export const MIN = { leads: 10, qualified: 8, booked: 5, attended: 5 }
export const THRESHOLDS = { qualificationRate: 0.5, bookingRate: 0.3, attendanceRate: 0.7, closeRate: 0.25 }
const EXPERIMENTS = {
  volume: { title: 'Get leads flowing before judging rates', experiment: 'Make the sales chat the first thing a visitor meets (homepage entry is live), ask PoolThru for two referrals, and prepare one small Meta or Google test for when spend is approved. Measure leads per week.', cost: 'No money', effort: 'Low', evidence: 'insufficient' },
  qualificationRate: { title: 'Improve lead qualification', experiment: 'Change the sales assistant’s opening question to ask what the business does and how inquiries arrive today, and add the two most common disqualifiers to its approved answers. Compare qualified share over the next 20 leads.', cost: 'No money', effort: 'Low' },
  bookingRate: { title: 'Improve the consultation booking offer', experiment: 'Have the assistant offer two concrete times right after the first qualifying answer, and add a visible "Book a 20-minute call" entry on the homepage. Compare booking rate over the next 10 qualified prospects.', cost: 'No money', effort: 'Low' },
  attendanceRate: { title: 'Reduce missed consultations', experiment: 'Turn on confirmation and reminder emails for the sales business (MESSAGES_LIVE is an approval) and send a one-line agenda the day before. Compare attendance over the next 10 booked calls.', cost: 'No money (email provider already configured)', effort: 'Medium (needs the messaging approval)' },
  closeRate: { title: 'Improve the close', experiment: 'Run every consultation from the sales playbook’s objection list and end with a dated next step; record the outcome the same day. Compare closes over the next 10 attended calls.', cost: 'No money', effort: 'Low' },
}
const strength = (n, min) => (n >= 5 * min ? 'strong' : n >= 2 * min ? 'moderate' : 'weak')
export function decide(measure) {
  const m = measure.measured || {}
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const leads = n(m.leads30)
  const base = normalizeAssumptions(baselineFrom(m).assumptions)
  if (leads < MIN.leads) {
    return { bottleneck: 'volume', ...EXPERIMENTS.volume, sample: { leads }, why: `${leads} prospect(s) in 30 days: too few to judge any conversion rate (the first rate is judged at ${MIN.leads} leads).`, upside: null }
  }
  const stages = [
    ['qualificationRate', n(m.qualified30), leads, MIN.leads],
    ['bookingRate', n(m.booked30), n(m.qualified30), MIN.qualified],
    ['attendanceRate', n(m.attended30), n(m.booked30), MIN.booked],
    ['closeRate', n(m.closed30), n(m.attended30), MIN.attended],
  ]
  for (const [key, num, den, min] of stages) {
    if (den < min) return { bottleneck: 'volume', title: `Not enough cases yet at “${FIELDS[key].label}”`, experiment: `Keep the funnel running until ${min} cases reach this step (${den} so far); the earlier steps meet their thresholds.`, cost: 'No money', effort: 'Low', evidence: 'insufficient', sample: { [key]: { num, den } }, why: `Rates are judged only with at least ${min} cases.`, upside: null }
    const r = rate(num, den)
    if (r != null && r < THRESHOLDS[key]) {
      const improved = monthlyFunnel({ ...base, [key]: Math.min(1, base[key] + 0.1) })
      const current = monthlyFunnel(base)
      return {
        bottleneck: key,
        ...EXPERIMENTS[key],
        evidence: strength(den, min),
        sample: { [key]: { num, den, rate: r, threshold: THRESHOLDS[key] } },
        why: `${Math.round(r * 100)}% at this step (${num} of ${den}) is below the ${Math.round(THRESHOLDS[key] * 100)}% threshold; earlier steps meet theirs.`,
        upside: { ratePoints: 10, newCustomersPerMonth: improved.newCustomers - current.newCustomers, newMrrCentsPerMonth: improved.newMrrCents - current.newMrrCents, assumptions: base, note: 'Scenario arithmetic from the measured rates and the listed price; not a forecast.' },
      }
    }
  }
  return { bottleneck: null, title: 'No stage below its threshold', experiment: 'Keep measuring; the next experiment is more volume at the same quality, which needs an acquisition decision (ads are an approval).', cost: 'Depends on the channel', effort: 'Medium', evidence: strength(leads, MIN.leads), sample: { leads }, why: 'Every measured rate meets its threshold with enough cases.', upside: null }
}

export const simulatorDefaults = DEFAULTS
