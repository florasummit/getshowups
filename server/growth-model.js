// Growth simulator (Admin → Growth → Simulate): a pure, deterministic funnel model. Inputs are the owner's assumptions
// (prefilled from measured data where the sample is big enough, otherwise clearly labelled hypothetical defaults);
// outputs are arithmetic over them. It never reads or writes anything, never touches prices in Stripe, and is never
// a forecast: the page labels every result "scenario", with the assumptions beside it.
//
// Funnel per month: leads → qualified (qualificationRate) → consultations booked (bookingRate) → attended
// (attendanceRate) → new customers (closeRate). Money: newCustomers × priceMonthlyCents = new MRR; retention over
// `months` compounds monthly churn; CAC = spend / new customers (null without spend or customers).
export const RATE_KEYS = ['qualificationRate', 'bookingRate', 'attendanceRate', 'closeRate']
export const FIELDS = {
  leadsPerMonth: { label: 'Leads per month', min: 0, max: 5000, step: 1, kind: 'count' },
  qualificationRate: { label: 'Qualified (share of leads)', min: 0, max: 1, step: 0.01, kind: 'rate' },
  bookingRate: { label: 'Consultations booked (share of qualified)', min: 0, max: 1, step: 0.01, kind: 'rate' },
  attendanceRate: { label: 'Attended (share of booked)', min: 0, max: 1, step: 0.01, kind: 'rate' },
  closeRate: { label: 'Become customers (share of attended)', min: 0, max: 1, step: 0.01, kind: 'rate' },
  spendPerMonthCents: { label: 'Acquisition spend per month', min: 0, max: 100_000_00, step: 100, kind: 'money' },
  priceMonthlyCents: { label: 'Subscription price per month (modeling only)', min: 0, max: 10_000_00, step: 100, kind: 'money' },
  monthlyChurn: { label: 'Monthly churn (share of customers lost)', min: 0, max: 1, step: 0.005, kind: 'rate' },
  existingMrrCents: { label: 'Existing MRR', min: 0, max: 10_000_000_00, step: 100, kind: 'money' },
  existingCustomers: { label: 'Existing paying customers', min: 0, max: 100_000, step: 1, kind: 'count' },
  months: { label: 'Months to project', min: 1, max: 36, step: 1, kind: 'count' },
}
// Hypothetical defaults: starting points for a business with no history. Shown as "assumption", never as data.
export const DEFAULTS = Object.freeze({
  leadsPerMonth: 40,
  qualificationRate: 0.6,
  bookingRate: 0.4,
  attendanceRate: 0.7,
  closeRate: 0.3,
  spendPerMonthCents: 0,
  priceMonthlyCents: 49_900,
  monthlyChurn: 0.03,
  existingMrrCents: 0,
  existingCustomers: 0,
  months: 12,
})

const clamp = (v, { min, max }) => Math.min(max, Math.max(min, v))
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

// Validates and clamps raw input (strings from form fields allowed) into a full assumption set.
export function normalizeAssumptions(input = {}) {
  const out = {}
  for (const [k, f] of Object.entries(FIELDS)) {
    const v = clamp(num(input[k], DEFAULTS[k]), f)
    out[k] = f.kind === 'rate' ? Math.round(v * 1000) / 1000 : Math.round(v)
  }
  return out
}

// One month of the funnel, from a full assumption set.
export function monthlyFunnel(a) {
  const qualified = a.leadsPerMonth * a.qualificationRate
  const booked = qualified * a.bookingRate
  const attended = booked * a.attendanceRate
  const newCustomers = attended * a.closeRate
  const newMrrCents = newCustomers * a.priceMonthlyCents
  const cacCents = a.spendPerMonthCents > 0 && newCustomers > 0 ? a.spendPerMonthCents / newCustomers : null
  const paybackMonths = cacCents != null && a.priceMonthlyCents > 0 ? cacCents / a.priceMonthlyCents : null
  return { qualified, booked, attended, newCustomers, newMrrCents, cacCents, paybackMonths }
}

// Projection over `months`: each month adds the funnel's new customers; churn removes a share of the base.
export function project(a) {
  const m = monthlyFunnel(a)
  let customers = a.existingCustomers
  let mrr = a.existingMrrCents
  const rows = []
  for (let i = 1; i <= a.months; i++) {
    customers = customers * (1 - a.monthlyChurn) + m.newCustomers
    mrr = mrr * (1 - a.monthlyChurn) + m.newMrrCents
    rows.push({ month: i, customers, mrrCents: mrr, spendCents: a.spendPerMonthCents })
  }
  const last = rows.at(-1) || { customers: a.existingCustomers, mrrCents: a.existingMrrCents }
  return {
    monthly: m,
    months: rows,
    endCustomers: last.customers,
    endMrrCents: last.mrrCents,
    addedMrrCents: last.mrrCents - a.existingMrrCents,
    totalSpendCents: a.spendPerMonthCents * a.months,
    totalNewCustomers: m.newCustomers * a.months,
  }
}

// Sensitivity: the effect on monthly new customers of moving each rate by ±10 points (absolute), everything else equal.
export function sensitivity(a, points = 0.1) {
  const base = monthlyFunnel(a).newCustomers
  return RATE_KEYS.map((k) => {
    const up = monthlyFunnel({ ...a, [k]: clamp(a[k] + points, FIELDS[k]) }).newCustomers
    const down = monthlyFunnel({ ...a, [k]: clamp(a[k] - points, FIELDS[k]) }).newCustomers
    return { key: k, label: FIELDS[k].label, base, up, down, upDelta: up - base, downDelta: down - base }
  }).sort((x, y) => Math.abs(y.upDelta) - Math.abs(x.upDelta))
}

// Baseline vs scenario, side by side.
export function compare(baseline, scenario) {
  const b = project(baseline)
  const s = project(scenario)
  return {
    baseline: b,
    scenario: s,
    delta: { newCustomersPerMonth: s.monthly.newCustomers - b.monthly.newCustomers, endMrrCents: s.endMrrCents - b.endMrrCents, totalSpendCents: s.totalSpendCents - b.totalSpendCents },
    changed: Object.keys(FIELDS).filter((k) => baseline[k] !== scenario[k]),
  }
}

// Prefill from measured data: a rate is used only when its denominator reaches the minimum sample; otherwise the
// default stays and the field is marked as an assumption. `measured` = { leads30, qualified30, booked30, attended30,
// closed30, spend30Cents, payingCustomers, mrrCents, priceMonthlyCents } (nulls allowed).
export const MIN_SAMPLE = { leads: 10, qualified: 8, booked: 5, attended: 5 }
export function baselineFrom(measured = {}, { minSample = MIN_SAMPLE } = {}) {
  const src = {}
  const a = { ...DEFAULTS }
  const n = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null) // null = not measured, never 0
  const leads = n(measured.leads30)
  if (leads != null && leads >= minSample.leads) {
    a.leadsPerMonth = leads
    src.leadsPerMonth = 'measured'
    const q = n(measured.qualified30)
    if (q != null) {
      a.qualificationRate = Math.round((q / leads) * 1000) / 1000
      src.qualificationRate = 'measured'
      const b = n(measured.booked30)
      if (b != null && q >= minSample.qualified) {
        a.bookingRate = Math.round((b / q) * 1000) / 1000
        src.bookingRate = 'measured'
        const at = n(measured.attended30)
        if (at != null && b >= minSample.booked) {
          a.attendanceRate = Math.round((at / b) * 1000) / 1000
          src.attendanceRate = 'measured'
          const c = n(measured.closed30)
          if (c != null && at >= minSample.attended) {
            a.closeRate = Math.round((c / at) * 1000) / 1000
            src.closeRate = 'measured'
          }
        }
      }
    }
  }
  const spend = n(measured.spend30Cents)
  if (spend != null) {
    a.spendPerMonthCents = spend
    src.spendPerMonthCents = 'measured'
  }
  if (n(measured.priceMonthlyCents) != null) {
    a.priceMonthlyCents = n(measured.priceMonthlyCents)
    src.priceMonthlyCents = 'listed plan'
  }
  if (n(measured.payingCustomers) != null) {
    a.existingCustomers = n(measured.payingCustomers)
    src.existingCustomers = 'measured'
  }
  if (n(measured.mrrCents) != null) {
    a.existingMrrCents = n(measured.mrrCents)
    src.existingMrrCents = 'measured'
  }
  for (const k of Object.keys(FIELDS)) if (!src[k]) src[k] = 'assumption'
  return { assumptions: a, sources: src }
}
