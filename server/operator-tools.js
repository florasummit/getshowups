// What the dashboard assistant can look up and prepare (server/operator.js runs the conversation). Every tool is a fixed,
// typed, read-only lookup bound to the session's business, or PREPARES a change the owner approves separately
// (server/proposals.js). No tool takes a business id, a query or a URL; records are named by references (A1, L2) this
// conversation was given, and every reference is looked up again inside the business.
// Data minimisation: the model sees references, times, statuses, ZIPs and what was asked for (contact details removed),
// never names, phones, emails or addresses. The page shows the real names next to the references.
import { openSlots } from './booking.js'
import { zonedToUtc } from './calendar.js'
import { diagnose, funnel } from './ads/funnel.js'
import { adsAccess } from './ads/access.js'
import { internalEmails, isTestLead } from './testdata.js'
import { getProfile } from './onboarding.js'
import { websiteSummary } from './website.js'
import { policiesOrEmpty } from './policies.js'
import { businessFacts } from './followups/engine.js'
import { outsideZips } from './insights.js'
import { serviceAreaChange } from './proposals.js'
import { validateHours } from './customers.js'

const DAY = 86_400_000
const LIST = 12
const usd = (c) => (c == null ? null : `$${(c / 100).toFixed(2).replace(/\.00$/, '')}`)

// ---------- dates in the business's own time zone ----------
const ymd = (t, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)
const addDays = (s, n) => new Date(Date.parse(`${s}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10)
const startOf = (s, tz) => zonedToUtc(...s.split('-').map(Number), 0, 0, tz)
const weekday = (s) => (new Date(`${s}T12:00:00Z`).getUTCDay() + 6) % 7 // Monday = 0
export const whenText = (t, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(t)
export const PERIODS = ['today', 'tomorrow', 'yesterday', 'this_week', 'next_week', 'last_week', 'next_7_days', 'last_7_days', 'previous_7_days', 'last_30_days', 'previous_30_days', 'last_90_days', 'this_month', 'last_month']
const DATE = /^\d{4}-\d{2}-\d{2}$/
const realDate = (s) => DATE.test(String(s)) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().startsWith(s)

// → { from, to, label } (ms, to exclusive) | null
export function rangeOf({ period, from, to }, tz, now) {
  const today = ymd(now, tz)
  const span = (a, b, label) => ({ from: startOf(a, tz), to: startOf(b, tz), label, days: [a, addDays(b, -1)] })
  if (from || to) {
    const a = from || to
    const b = to || from
    if (!realDate(a) || !realDate(b) || a > b || Date.parse(b) - Date.parse(a) > 366 * DAY) return null
    return span(a, addDays(b, 1), a === b ? a : `${a} to ${b}`)
  }
  const mon = addDays(today, -weekday(today))
  const first = `${today.slice(0, 8)}01`
  const prevFirst = `${addDays(first, -1).slice(0, 8)}01`
  const next = addDays(`${today.slice(0, 8)}28`, 4).slice(0, 8)
  const P = {
    today: [today, addDays(today, 1)],
    tomorrow: [addDays(today, 1), addDays(today, 2)],
    yesterday: [addDays(today, -1), today],
    this_week: [mon, addDays(mon, 7)],
    next_week: [addDays(mon, 7), addDays(mon, 14)],
    last_week: [addDays(mon, -7), mon],
    next_7_days: [today, addDays(today, 7)],
    last_7_days: [addDays(today, -6), addDays(today, 1)],
    previous_7_days: [addDays(today, -13), addDays(today, -6)],
    last_30_days: [addDays(today, -29), addDays(today, 1)],
    previous_30_days: [addDays(today, -59), addDays(today, -29)],
    last_90_days: [addDays(today, -89), addDays(today, 1)],
    this_month: [first, `${next}01`],
    last_month: [prevFirst, first],
  }[period]
  return P ? span(P[0], P[1], period.replace(/_/g, ' ')) : null
}

// ---------- records ----------
const tidy = (v) =>
  String(v ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\S+@\S+/g, '[email removed]')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '[link removed]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number removed]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)

const APPT = `SELECT a.id, a.start_at, a.status, a.lead_id, l.name, l.need, l.zip, l.phone, l.email, ao.work,
    (SELECT source FROM lead_attribution la WHERE la.lead_id = l.id AND la.customer = l.customer) AS source,
    EXISTS (SELECT 1 FROM appointment_confirmations ac WHERE ac.appointment_id = a.id) AS confirmed
  FROM appointments a JOIN leads l ON l.id = a.lead_id AND l.customer = a.customer
  LEFT JOIN appointment_outcomes ao ON ao.appointment_id = a.id AND ao.customer = a.customer`
const LEAD = `SELECT l.id, l.name, l.need, l.zip, l.status, l.created_at, l.email, l.phone, t.stage, t.last_outbound_at, t.needs_owner, r.status AS coverage,
    (SELECT source FROM lead_attribution la WHERE la.lead_id = l.id AND la.customer = l.customer) AS source,
    (SELECT count(*) FROM appointments a WHERE a.lead_id = l.id AND a.customer = l.customer AND a.status = 'no_show') AS no_shows,
    (SELECT count(*) FROM appointments a WHERE a.lead_id = l.id AND a.customer = l.customer AND a.status = 'showed') AS showed,
    (SELECT count(*) FROM appointments a WHERE a.lead_id = l.id AND a.customer = l.customer AND a.status = 'booked') AS booked
  FROM leads l LEFT JOIN lead_threads t ON t.lead_id = l.id AND t.customer = l.customer LEFT JOIN coverage_requests r ON r.lead_id = l.id AND r.customer = l.customer`

const apptState = (r, now) =>
  r.status === 'showed' ? (r.work === 'completed' ? 'happened, job completed' : r.work === 'not_completed' ? 'happened, job not finished' : 'happened') : r.status === 'no_show' ? 'no-show' : r.status === 'cancelled' ? 'cancelled' : r.start_at > now ? 'upcoming' : 'past, outcome not recorded'
const SOURCE = { google_ads: 'your Google ad', meta_ad_click: 'your Meta ad', meta_lead_form: 'your Meta ad', google_ads_imported: 'a Google campaign you run yourself' }

// References: A = appointment, L = inquiry. The map lives in the conversation (the browser holds it); an id in it is
// only ever used in a query that also names the session's business.
export function refBook(given) {
  const book = { A: [], L: [] }
  for (const k of ['A', 'L']) for (const id of Array.isArray(given?.[k]) ? given[k].slice(0, 60) : []) book[k].push(typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : '')
  return {
    book,
    ref(kind, id) {
      let i = book[kind].indexOf(id)
      if (i < 0) i = book[kind].push(id) - 1
      return `${kind}${i + 1}`
    },
    id(ref) {
      const m = /^\[?([AL])(\d{1,3})\]?$/i.exec(String(ref ?? '').trim())
      return m ? { kind: m[1].toUpperCase(), id: book[m[1].toUpperCase()][Number(m[2]) - 1] || null } : { kind: null, id: null }
    },
  }
}

// A context per turn: session business, references, and what the page needs to show (real names) per reference.
export function toolContext(env, customer, given, now = Date.now(), days = 30) {
  return { days, env, db: env.ONBOARDING_DB, customer, tz: customer.timezone, now, refs: refBook(given), shown: new Map(), proposals: [], withdraw: false, go: null, internal: internalEmails(env) }
}

const apptOut = (c, r) => {
  const ref = c.refs.ref('A', r.id)
  c.shown.set(ref, { ref, kind: 'appointment', leadId: r.lead_id, name: r.name, when: whenText(r.start_at, c.tz), what: r.need, state: apptState(r, c.now), contact: [r.phone, r.email].filter(Boolean), go: 'appointments' })
  return { ref, when: whenText(r.start_at, c.tz), asked_for: tidy(r.need), zip: r.zip || null, state: apptState(r, c.now), confirmed_by_customer: !!r.confirmed, came_from: SOURCE[r.source] || 'not traced to an ad', inquiry: c.refs.ref('L', r.lead_id) }
}
const leadState = (r) => (r.status === 'unqualified' ? `outside the service area (${r.coverage || 'kept'})` : r.status === 'booked' ? 'booked' : r.no_shows > 0 && !r.showed ? 'booked before, did not show up, not rebooked' : 'not booked')
const leadOut = (c, r) => {
  const ref = c.refs.ref('L', r.id)
  const state = leadState(r)
  c.shown.set(ref, { ref, kind: 'inquiry', leadId: r.id, name: r.name, when: whenText(r.created_at, c.tz), what: r.need, state, contact: [r.phone, r.email].filter(Boolean), go: 'followups' })
  return {
    ref,
    asked_on: whenText(r.created_at, c.tz),
    days_ago: Math.floor((c.now - r.created_at) / DAY),
    asked_for: tidy(r.need),
    zip: r.zip || null,
    state,
    in_service_area: r.status !== 'unqualified',
    message_sent_by_getshowups: r.last_outbound_at ? whenText(r.last_outbound_at, c.tz) : 'none',
    waiting_for_owner: !!r.needs_owner,
    appointments: { booked: Number(r.booked), showed: Number(r.showed), no_show: Number(r.no_shows) },
    can_be_reached_by: [r.email && 'email', r.phone && 'phone'].filter(Boolean),
    came_from: SOURCE[r.source] || 'not traced to an ad',
  }
}
const all = async (c, sql, ...a) => (await c.db.prepare(sql).bind(c.customer.id, ...a).all()).results
const one = async (c, sql, ...a) => c.db.prepare(sql).bind(c.customer.id, ...a).first()
const listed = (rows, out) => ({ total: rows.length, shown: Math.min(rows.length, LIST), items: rows.slice(0, LIST).map(out) })
const MISSING = { error: 'not_found', note: 'That record is not in this business (it may have been removed). Look it up again.' }

async function apptByRef(c, ref) {
  const { kind, id } = c.refs.id(ref)
  if (!id) return null
  // An inquiry reference means its newest appointment.
  return kind === 'A' ? one(c, `${APPT} WHERE a.customer = ?1 AND a.id = ?2 AND a.status <> 'pending'`, id) : one(c, `${APPT} WHERE a.customer = ?1 AND a.lead_id = ?2 AND a.status <> 'pending' ORDER BY a.start_at DESC LIMIT 1`, id)
}
async function leadByRef(c, ref) {
  const { kind, id } = c.refs.id(ref)
  if (!id) return null
  if (kind === 'L') return one(c, `${LEAD} WHERE l.customer = ?1 AND l.id = ?2`, id)
  const a = await one(c, 'SELECT lead_id FROM appointments WHERE customer = ?1 AND id = ?2', id)
  return a ? one(c, `${LEAD} WHERE l.customer = ?1 AND l.id = ?2`, a.lead_id) : null
}

// Counts by the date things happened (inquiries by when they came in, visits by when they took place).
export async function rangeStats(c, r) {
  const a = [r.from, r.to, c.internal]
  const T = `AND NOT ${isTestLead('l', '?4')}`
  const [l, b, v, m, p] = await Promise.all([
    one(c, `SELECT count(*) AS n, coalesce(sum(l.status = 'unqualified'), 0) AS outside FROM leads l WHERE l.customer = ?1 AND l.created_at >= ?2 AND l.created_at < ?3 ${T}`, ...a),
    one(c, `SELECT count(*) AS n FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE a.customer = ?1 AND a.created_at >= ?2 AND a.created_at < ?3 AND a.status IN ('booked','showed','no_show') ${T}`, ...a),
    one(c, `SELECT coalesce(sum(a.status IN ('booked','showed','no_show')), 0) AS n, coalesce(sum(a.status = 'showed'), 0) AS showed, coalesce(sum(a.status = 'no_show'), 0) AS no_show, coalesce(sum(a.status = 'booked' AND a.start_at <= ?5), 0) AS unmarked FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE a.customer = ?1 AND a.start_at >= ?2 AND a.start_at < ?3 ${T}`, ...a, c.now),
    (await adsAccess(c.env, c.customer)) ? one(c, 'SELECT count(*) AS n, sum(spend_cents) AS s, sum(clicks) AS k, min(date) AS d FROM ad_metrics_daily WHERE customer = ?1 AND date >= ?2 AND date <= ?3', r.days[0], r.days[1]) : null,
    one(c, `SELECT sum(x.amount_cents) AS s, count(x.amount_cents) AS n FROM revenue_entries x JOIN appointments a ON a.id = x.appointment_id AND a.customer = x.customer JOIN leads l ON l.id = a.lead_id WHERE x.customer = ?1 AND x.kind = 'paid' AND a.status = 'showed' AND a.start_at >= ?2 AND a.start_at < ?3 ${T} AND x.id = (SELECT max(y.id) FROM revenue_entries y WHERE y.appointment_id = x.appointment_id AND y.kind = 'paid')`, ...a).catch(() => null),
  ])
  return {
    period: r.label,
    dates: `${r.days[0]} to ${r.days[1]}`,
    ...(r.to > c.now ? { note: 'This period is not over yet.' } : {}),
    new_inquiries: Number(l.n),
    inquiries_outside_service_area: Number(l.outside),
    bookings_made: Number(b.n),
    visits_scheduled: Number(v.n),
    visits_happened: Number(v.showed),
    no_shows: Number(v.no_show),
    past_visits_without_outcome: Number(v.unmarked),
    payments_recorded: p?.n ? usd(p.s) : 'none recorded',
    ad_spend_reported: m?.n ? usd(m.s) : 'none reported',
    ad_clicks_reported: m?.n ? Number(m.k) : 'none reported',
    ...(m?.n && m.d > r.days[0] ? { ad_data_starts: m.d } : {}),
  }
}

const PERIOD = { type: 'string', enum: PERIODS }
const D8 = { type: 'string', description: 'YYYY-MM-DD, only for an exact date or range' }
const REF = { type: 'string', description: 'A reference such as A1 or L2 from earlier results' }
const tool = (name, description, properties, required, run) => ({ name, description, parameters: { type: 'object', properties, required }, run })

export const TOOLS = [
  tool(
    'list_appointments',
    'Appointments. With no arguments: everything coming up plus past ones whose outcome is not recorded. Use period or from/to for a day or range, and state to narrow.',
    { period: PERIOD, from: D8, to: D8, state: { type: 'string', enum: ['any', 'upcoming', 'needs_outcome', 'happened', 'no_show', 'cancelled'] } },
    [],
    async (c, a) => {
      const bounded = a.period || a.from || a.to
      const r = bounded ? rangeOf(a, c.tz, c.now) : null
      if (bounded && !r) return { error: 'invalid_period', note: `Use one of ${PERIODS.join(', ')} or real dates.` }
      const W = { upcoming: "a.status = 'booked' AND a.start_at > ?4", needs_outcome: "a.status = 'booked' AND a.start_at <= ?4", happened: "a.status = 'showed'", no_show: "a.status = 'no_show'", cancelled: "a.status = 'cancelled'" }[a.state]
      const q = (where, from, to, order) => all(c, `${APPT} WHERE a.customer = ?1 AND a.start_at >= ?2 AND a.start_at < ?3 AND ?4 = ?4 AND a.status <> 'pending' AND NOT ${isTestLead('l', '?5')} ${where ? `AND ${where}` : ''} ORDER BY a.start_at ${order} LIMIT 60`, from, to, c.now, c.internal)
      if (r) {
        const rows = await q(W, r.from, r.to, 'ASC')
        const clash = rows.filter((x) => x.status === 'booked' && rows.some((y) => y !== x && y.status === 'booked' && Math.abs(y.start_at - x.start_at) < (c.customer.slotMinutes || 60) * 60_000))
        return { period: r.label, dates: `${r.days[0]} to ${r.days[1]}`, ...listed(rows, (x) => apptOut(c, x)), overlapping: clash.map((x) => c.refs.ref('A', x.id)) }
      }
      const far = c.now + 400 * DAY
      if (W) return { state: a.state, ...listed(await q(W, c.now - 400 * DAY, far, a.state === 'upcoming' ? 'ASC' : 'DESC'), (x) => apptOut(c, x)) }
      return {
        upcoming: listed(await q("a.status = 'booked'", c.now, far, 'ASC'), (x) => apptOut(c, x)),
        outcome_not_recorded: listed(await q("a.status = 'booked'", c.now - 90 * DAY, c.now, 'DESC'), (x) => apptOut(c, x)),
      }
    },
  ),
  tool('get_appointment', 'One appointment in full, with the history of the inquiry behind it.', { ref: REF }, ['ref'], async (c, a) => {
    const r = await apptByRef(c, a.ref)
    if (!r) return MISSING
    const money = await all(c, "SELECT kind, amount_cents FROM revenue_entries WHERE customer = ?1 AND appointment_id = ?2 ORDER BY id DESC LIMIT 6", r.id).catch(() => [])
    const paid = money.find((m) => m.kind === 'paid')
    const l = await one(c, `${LEAD} WHERE l.customer = ?1 AND l.id = ?2`, r.lead_id)
    return { ...apptOut(c, r), paid_recorded: paid ? usd(paid.amount_cents) : 'none recorded', inquiry_details: l ? leadOut(c, l) : null }
  }),
  tool(
    'list_leads',
    'Inquiries (leads). recent = all; unanswered = not booked and nothing was sent to them; not_booked; booked; booked_no_show = booked but did not show up; outside_area = not in the service area; qualified = in the service area. unanswered also means waiting for a reply.',
    { which: { type: 'string', enum: ['recent', 'unanswered', 'not_booked', 'booked', 'booked_no_show', 'outside_area', 'qualified'] }, days: { type: 'integer', description: 'How far back, default 30, at most 365' } },
    ['which'],
    async (c, a) => {
      const days = Math.min(365, Math.max(1, Number.isInteger(a.days) ? a.days : 30))
      const W = {
        recent: '1 = 1',
        unanswered: "l.status = 'new' AND t.last_outbound_at IS NULL AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.lead_id = l.id AND x.customer = l.customer AND x.status IN ('booked','showed','no_show'))",
        not_booked: "l.status = 'new'",
        booked: "l.status = 'booked'",
        booked_no_show: "EXISTS (SELECT 1 FROM appointments x WHERE x.lead_id = l.id AND x.customer = l.customer AND x.status = 'no_show')",
        outside_area: "l.status = 'unqualified'",
        qualified: "l.status <> 'unqualified'",
      }[a.which]
      if (!W) return { error: 'invalid_filter' }
      const rows = await all(c, `${LEAD} WHERE l.customer = ?1 AND l.created_at >= ?2 AND NOT ${isTestLead('l', '?3')} AND ${W} ORDER BY l.created_at DESC LIMIT 60`, c.now - days * DAY, c.internal)
      return { which: a.which, last_days: days, ...listed(rows, (x) => leadOut(c, x)), ...(a.which === 'unanswered' ? { note: 'Phone calls made outside GetShowUps are not recorded.' } : {}) }
    },
  ),
  tool('get_lead', 'One inquiry in full.', { ref: REF }, ['ref'], async (c, a) => {
    const r = await leadByRef(c, a.ref)
    if (!r) return MISSING
    const appts = await all(c, `${APPT} WHERE a.customer = ?1 AND a.lead_id = ?2 AND a.status <> 'pending' ORDER BY a.start_at DESC LIMIT 5`, r.id)
    return { ...leadOut(c, r), appointment_history: appts.map((x) => apptOut(c, x)) }
  }),
  tool('find_person', "Find inquiries and appointments by a customer name the owner typed. Returns references, not names.", { name: { type: 'string' } }, ['name'], async (c, a) => {
    const q = String(a.name || '').replace(/[%_\\]/g, '').trim().slice(0, 60)
    if (q.length < 2) return { error: 'name_too_short' }
    const rows = await all(c, `${LEAD} WHERE l.customer = ?1 AND l.name LIKE ?2 ORDER BY l.created_at DESC LIMIT 6`, `%${q}%`)
    return { matches: rows.length, items: rows.map((x) => leadOut(c, x)) }
  }),
  tool('business_numbers', 'Counts for one period, by the date things happened: inquiries, bookings, visits, no-shows, payments recorded, ad spend.', { period: PERIOD, from: D8, to: D8 }, [], async (c, a) => {
    const r = rangeOf(a.period || a.from ? a : { period: 'last_30_days' }, c.tz, c.now)
    return r ? rangeStats(c, r) : { error: 'invalid_period' }
  }),
  tool('compare_periods', 'Two periods side by side, with the differences already calculated.', { first: PERIOD, second: PERIOD }, ['first', 'second'], async (c, a) => {
    const x = rangeOf({ period: a.first }, c.tz, c.now)
    const y = rangeOf({ period: a.second }, c.tz, c.now)
    if (!x || !y) return { error: 'invalid_period' }
    const [s, t] = await Promise.all([rangeStats(c, x), rangeStats(c, y)])
    const difference = {}
    for (const k of Object.keys(s)) if (typeof s[k] === 'number' && typeof t[k] === 'number') difference[k] = s[k] - t[k]
    const open = [x, y].some((r) => r.to > c.now && r.from <= c.now)
    return { first: s, second: t, difference_first_minus_second: difference, ...(open ? { note: 'One of these periods is still running, so it has had less time. Small counts: do not call a difference a trend.' } : { note: 'Small counts: do not call a difference a trend.' }) }
  }),
  tool('explain_funnel', 'Use for: why leads are not booking, money, revenue, payments, what ads brought in, cost per lead or booking. Where inquiries are lost on the way to finished jobs, findings, recorded payments, what ads can and cannot be credited with, and what is not known.', { days: { type: 'integer', enum: [7, 30, 90] } }, [], async (c, a) => {
    const days = [7, 30, 90].includes(a.days) ? a.days : c.days
    const opts = { days, internal: c.internal, now: c.now }
    const ads = await adsAccess(c.env, c.customer)
    const [f, g] = await Promise.all([funnel(c.db, c.customer.id, { ...opts, scope: 'all' }), ads ? funnel(c.db, c.customer.id, { ...opts, scope: 'ads' }) : null])
    const s = f.stages
    return {
      last_days: days,
      basis: 'Inquiries that came in during this period, followed to what became of each.',
      inquiries: s.leads,
      in_service_area: s.qualified,
      outside_service_area: s.outsideArea,
      booked: s.booked,
      in_area_not_booked: Math.max(0, s.qualified - s.booked),
      showed_up: s.attended,
      no_shows: s.noShow,
      past_visits_without_outcome: s.past - s.outcomeRecorded,
      jobs_completed: s.completed,
      findings: diagnose(f).map((d) => `${d.title}. ${d.detail}`),
      payments_recorded_for_all: usd(f.revenue.paidCents) ?? 'none recorded',
      ...(g
        ? {
            ads: {
              spend_reported: usd(g.spend.cents) ?? 'none reported',
              inquiries_traced_to_ads: g.stages.leads,
              bookings_traced_to_ads: g.stages.booked,
              cost_per_traced_inquiry: usd(g.cost.perLead) ?? 'not available',
              cost_per_traced_booking: usd(g.cost.perBooking) ?? 'not available',
              payments_recorded_for_traced_jobs: usd(g.revenue.paidCents) ?? 'none recorded',
              inquiries_not_traced: g.attribution.unattributed,
              ...(g.spend.firstDay && g.spend.firstDay > g.range.from.slice(0, 10) ? { ad_data_starts: g.spend.firstDay } : {}),
              limits: 'A traced payment is money recorded for a job whose inquiry came through an ad link. It is not proof the ad caused it, and not a return on ad spend.',
            },
          }
        : { ads: 'not available for this business' }),
      not_known: ['Why a person did not book is not recorded.', 'Calls outside GetShowUps are not seen.', s.leads < 10 ? `${s.leads} inquiries are too few to judge rates.` : ''].filter(Boolean),
    }
  }),
  tool('open_times', 'Real open booking times from the calendar, for a day or the next days.', { period: PERIOD, from: D8, to: D8 }, [], async (c, a) => {
    const r = rangeOf(a.period || a.from ? a : { period: 'next_7_days' }, c.tz, c.now)
    if (!r) return { error: 'invalid_period' }
    const o = await openSlots(c.env, c.customer, c.now).catch(() => ({ ok: false, status: 'calendar_error' }))
    if (!o.ok) return { error: 'calendar_unavailable', note: 'The calendar could not be read, so open times are unknown. Settings shows its status.' }
    const t = o.slots.map((x) => x.start).filter((x) => x >= r.from && x < r.to)
    return { period: r.label, open_times: t.length, first_times: t.slice(0, 8).map((x) => whenText(x, c.tz)) }
  }),
  tool('business_settings', 'Current settings: hours, service area, services, receptionist, website, calendar, automatic messages, and what is missing.', {}, [], async (c) => {
    const [f, profile, rec, site, cal, outside, policy] = await Promise.all([
      businessFacts(c.env, c.customer),
      getProfile(c.db, c.customer.id).catch(() => undefined),
      one(c, 'SELECT enabled FROM receptionist_settings WHERE customer = ?1').catch(() => undefined),
      websiteSummary(c.db, c.customer.id).catch(() => null),
      c.env.GOOGLE_TOKENS.get(`google:${c.customer.id}`).catch(() => undefined),
      outsideZips(c.env, c.customer, c.now).catch(() => []),
      policiesOrEmpty(c.db, c.customer.id),
    ])
    const z = c.customer.serviceZips || []
    return {
      business: f.name,
      booking_hours: f.hours || 'not set',
      appointment_minutes: c.customer.slotMinutes,
      time_zone: c.tz,
      appointments_are: f.visit ? "at the customer's address" : 'at the business',
      service_area_zips: z.length ? z.slice(0, 40) : 'no limit, anyone can book',
      outside_zips_asked_from_last_90_days: outside.slice(0, 6).map((x) => ({ zip: x.zip || 'unknown', inquiries: x.n })),
      services: (profile?.services || []).map((s) => ({ name: s.name, price: s.price || 'no price listed' })),
      towns: profile?.cities || [],
      online_booking: c.customer.status && c.customer.status !== 'active' ? 'closed: the account is not active' : cal === null || cal === false ? 'CLOSED to new bookings: needs Google Calendar connected (Settings); nobody can book online, and website chat cannot run, until then' : c.customer.hoursConfirmed === false ? 'CLOSED to new bookings: booking hours not confirmed (Settings)' : cal === undefined ? 'unknown' : 'open if hosting is active: customers can book on the booking page at any hour, with or without a website or the receptionist',
      ai_receptionist: rec === undefined ? 'unknown' : rec?.enabled === 1 ? 'on' : 'off (optional website chat, turned on in Receptionist; not phone calls)',
      website: site?.published ? 'published' : site?.exists ? 'draft, not published' : 'none (optional: the booking page has its own link)',
      google_calendar: cal === undefined ? 'unknown' : cal ? 'connected (last known)' : 'not connected',
      automatic_messages: c.customer.automations ? 'turned on' : 'turned off',
      messages_to_customers: c.env.MESSAGES_LIVE === 'true' ? 'live' : 'not live yet: GetShowUps is still activating sending, so new automatic messages do not go out. Anything a record shows as sent was sent',
      // What each gap does, from how the product works, so the model neither guesses a consequence nor a place to fix it.
      ...(profile !== undefined
        ? {
            not_set: [
              !profile?.services?.length && 'services (Settings): the receptionist has none to describe',
              profile?.services?.length && profile.services.some((s) => !s.price) && `price for ${profile.services.filter((s) => !s.price).map((s) => s.name).join(', ')} (Settings); all other listed services have one`,
              !profile?.phone && 'business phone (Settings): not shown to customers; online booking works without it',
              !profile?.description && 'business description (Settings)',
              !profile?.cities?.length && 'towns served (Settings): wording only, ZIPs decide who can book',
              !z.length && 'service-area ZIPs (Settings): anyone anywhere can book',
              !policy.beforeVisit && 'what customers should know before a visit (Settings)',
              !policy.cancellation && 'cancellation policy (Settings)',
            ].filter(Boolean),
          }
        : { not_set: 'could not be read' }),
      not_in_getshowups: ['phone calls', 'why someone did not book', 'costs other than reported ad spend', 'payments nobody recorded'],
    }
  }),
  // ---------- prepare (nothing is saved) ----------
  tool(
    'prepare_outcome',
    'Prepare recording what happened at a past appointment, for the owner to approve. completed = happened and the job is done; happened_not_finished; happened; no_show; undo = back to not recorded.',
    { ref: REF, outcome: { type: 'string', enum: ['completed', 'happened_not_finished', 'happened', 'no_show', 'undo'] } },
    ['ref', 'outcome'],
    async (c, a) => {
      const r = await apptByRef(c, a.ref)
      if (!r) return MISSING
      if (!OUTCOMES[a.outcome]) return { error: 'invalid_outcome' }
      if (r.start_at > c.now) return { error: 'not_past', note: `This appointment is still ahead (${whenText(r.start_at, c.tz)}), so an outcome cannot be recorded yet.` }
      if (!['booked', 'showed', 'no_show'].includes(r.status)) return { error: 'cancelled', note: 'A cancelled appointment has no outcome.' }
      const o = OUTCOMES[a.outcome]
      if (r.status === o.status && (r.work ?? null) === o.work) return { already: true, state: apptState(r, c.now) }
      const out = apptOut(c, r)
      c.proposals.push({
        type: 'outcome',
        id: r.id,
        ref: out.ref,
        name: r.name,
        when: whenText(r.start_at, c.tz),
        outcome: a.outcome,
        before: { status: r.status, work: r.work ?? null },
        from: apptState(r, c.now),
        to: o.label,
        effects: [a.outcome === 'no_show' && 'The inquiry opens again so they can rebook.', ['no_show', 'completed', 'happened', 'happened_not_finished'].includes(a.outcome) && c.env.MESSAGES_LIVE !== 'true' && 'No message goes to the customer: sending isn’t live.', 'You can change it later in Appointments.'].filter(Boolean),
      })
      return { prepared: true, appointment: out, change: `${apptState(r, c.now)} -> ${o.label}`, note: 'Shown to the owner with an Approve button. Not saved.' }
    },
  ),
  tool(
    'prepare_follow_up',
    'Prepare a follow-up message to one person for the owner to edit and send themselves. Write the message without a name, greeting by name, price, promise, time or link.',
    { ref: REF, message: { type: 'string', description: 'The draft, two to four short sentences' } },
    ['ref', 'message'],
    async (c, a) => {
      const r = await leadByRef(c, a.ref)
      if (!r) return MISSING
      const text = String(a.message || '').replace(/\p{Cc}/gu, ' ').replace(/\[?\b[AL]\d{1,3}\b\]?/g, '').replace(/\s+/g, ' ').trim()
      if (text.length < 20 || text.length > 600) return { error: 'message_length', note: 'Two to four short sentences.' }
      if (/https?:|www\.|[$%<>{}]|\b(guarantee\w*|discount|free)\b/i.test(text) || /\d/.test(text)) return { error: 'message_content', note: 'Rewrite without numbers, prices, links, discounts or guarantees.' }
      if (!r.email && !r.phone) return { error: 'no_contact', note: 'No email or phone is on record for this person.' }
      const out = leadOut(c, r)
      c.proposals.push({ type: 'follow_up', id: r.id, ref: out.ref, name: r.name, message: text, effects: ['Opens in Follow-ups for you to edit. Nothing is sent from here.', c.env.MESSAGES_LIVE !== 'true' && 'Sending to customers isn’t live yet, so calling may be quicker.'].filter(Boolean) })
      return { prepared: true, for: out, note: 'Shown to the owner to edit. Not sent.' }
    },
  ),
  tool('prepare_service_area', 'Prepare adding or removing service-area ZIP codes, for the owner to approve. Use ZIPs the owner named, or ones business_settings shows were asked from more than once.', { add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } }, [], async (c, a) => {
    const arr = (v) => (Array.isArray(v) ? v.map(String).slice(0, 20) : [])
    const r = serviceAreaChange(c.customer, arr(a.add), arr(a.remove))
    if (r.proposal) c.proposals.push(r.proposal)
    return r.proposal ? { prepared: true, before: r.proposal.before, after: r.proposal.after, notes: r.proposal.effects, note: 'Shown to the owner with an Approve button. Not saved.' } : { prepared: false, reason: r.text }
  }),
  tool(
    'prepare_hours',
    'Prepare changing booking hours, for the owner to approve. Leave out what stays the same. Days: 0 Sunday to 6 Saturday.',
    { open: { type: 'string', description: 'HH:MM, 24-hour' }, close: { type: 'string', description: 'HH:MM, 24-hour' }, days: { type: 'array', items: { type: 'integer' } }, appointment_minutes: { type: 'integer' } },
    [],
    async (c, a) => {
      const cur = { dayStart: c.customer.dayStart, dayEnd: c.customer.dayEnd, workdays: [...c.customer.workdays].sort(), slotMinutes: c.customer.slotMinutes }
      const [error, v] = validateHours({ dayStart: a.open ?? cur.dayStart, dayEnd: a.close ?? cur.dayEnd, workdays: a.days ?? cur.workdays, slotMinutes: a.appointment_minutes ?? cur.slotMinutes })
      if (error) return { error }
      const after = { dayStart: v.dayStart, dayEnd: v.dayEnd, workdays: v.workdays, slotMinutes: v.slotMinutes }
      if (JSON.stringify(after) === JSON.stringify(cur)) return { already: true, note: 'Those are the current hours.' }
      c.proposals.push({ type: 'hours', before: cur, after, from: hoursText(cur), to: hoursText(after), effects: ['Changes which times people can book from now on. Appointments already booked stay.'] })
      return { prepared: true, before: hoursText(cur), after: hoursText(after), note: 'Shown to the owner with an Approve button. Not saved.' }
    },
  ),
  tool('withdraw_prepared', 'Withdraw the changes prepared earlier that are still waiting for approval, when the owner does not want them.', {}, [], async (c) => {
    c.withdraw = true
    c.proposals.length = 0
    return { withdrawn: true, note: 'Nothing was changed.' }
  }),
  tool('no_lookup_needed', 'Only when nothing about this business has to be read: a greeting, a general business question, a needed clarification, or something already in the records discussed.', { why: { type: 'string', enum: ['greeting', 'general_question', 'clarify', 'already_have_it', 'unrelated'] } }, ['why'], async () => ({ ok: true })),
  tool('show_page', 'Offer a button to a dashboard page, when the owner asks to go there or the next step can only be done there.', { page: { type: 'string', enum: ['overview', 'appointments', 'followups', 'receptionist', 'teach', 'website', 'ads', 'settings'] } }, ['page'], async (c, a) => {
    if (!['overview', 'appointments', 'followups', 'receptionist', 'teach', 'website', 'ads', 'settings'].includes(a.page)) return { error: 'invalid_page' }
    c.go = a.page
    return { offered: a.page, note: 'A button is shown under your answer; nothing was opened or changed. Still answer the question.' }
  }),
]

export const OUTCOMES = {
  completed: { status: 'showed', work: 'completed', label: 'happened, job completed' },
  happened_not_finished: { status: 'showed', work: 'not_completed', label: 'happened, job not finished' },
  happened: { status: 'showed', work: null, label: 'happened' },
  no_show: { status: 'no_show', work: null, label: 'no-show' },
  undo: { status: 'booked', work: null, label: 'outcome not recorded' },
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const clock12 = (t) => {
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}
export const hoursText = (h) => `${h.workdays.map((d) => DAYS[d]).join(', ')} ${clock12(h.dayStart)} to ${clock12(h.dayEnd)}, ${h.slotMinutes} minutes each`

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))
// Runs one tool call. Unknown tools, unknown arguments and wrong types never reach a query.
export async function runTool(c, name, args) {
  const t = BY_NAME.get(name)
  if (!t) return { error: 'unknown_tool' }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { error: 'invalid_arguments' }
  const clean = {}
  for (const [k, spec] of Object.entries(t.parameters.properties)) {
    let v = args[k]
    if (v === undefined || v === null || v === '') continue
    if (spec.type === 'integer' && typeof v === 'string' && /^\d{1,4}$/.test(v)) v = Number(v)
    const ok = spec.type === 'string' ? typeof v === 'string' && v.length <= 1000 : spec.type === 'integer' ? Number.isInteger(v) : Array.isArray(v) && v.length <= 30
    if (!ok || (spec.enum && !spec.enum.includes(v))) return { error: 'invalid_arguments', field: k, ...(spec.enum ? { allowed: spec.enum } : {}) }
    clean[k] = v
  }
  for (const k of t.parameters.required) if (clean[k] === undefined) return { error: 'missing_argument', field: k }
  try {
    return await t.run(c, clean)
  } catch (err) {
    console.error('operator tool failed:', name, err?.name)
    return { error: 'unavailable', note: 'This could not be read right now. Say so; do not guess.' }
  }
}

// The records of this conversation, read again now (so "that one" is true today, and gone records are known to be gone).
// The newest ones, and every one the conversation still names (said: the earlier turns' text).
export async function knownRecords(c, said = '', limit = 10) {
  const out = []
  for (const k of ['A', 'L']) {
    const n = c.refs.book[k].length
    const named = new Set([...said.matchAll(/\[([AL]\d{1,3})\]/g)].map((m) => m[1]).slice(-24))
    for (let i = 0; i < n; i++) {
      const ref = `${k}${i + 1}`
      if (i < n - limit && !named.has(ref)) continue
      const r = k === 'A' ? await apptByRef(c, ref) : await leadByRef(c, ref)
      out.push(r ? (k === 'A' ? apptOut(c, r) : leadOut(c, r)) : { ref, state: 'no longer exists' })
    }
  }
  return out
}

// Lookups whose results a follow-up question needs again. Only these are ever repeated: reads of our own records.
export const REPEATABLE = ['list_appointments', 'get_appointment', 'list_leads', 'get_lead', 'find_person', 'business_numbers', 'compare_periods', 'explain_funnel', 'business_settings']
export async function repeatLookups(c, list) {
  return Promise.all(list.map(async (x) => ({ tool: x.name, args: x.args, result: await runTool(c, x.name, x.args) })))
}
