// GetShowUps' own customer acquisition, in Admin → Growth → Activities. Nothing here is a second tracking system:
//   results  = server/sales-attribution.js (prospects of the sales business by the link's utm_campaign code → qualified →
//              demo booked → attended → business created → paying → paid revenue), read, never stored here
//   status   = what only the founder knows about each tracking code (approved, sent, followed up, answered, declined) and
//              what it cost, recorded BY THE FOUNDER after the fact (acquisition_codes, migration 0044). Recording "sent"
//              sends nothing: nothing in GetShowUps contacts a prospect or spends money from this page.
// The catalog below is the prepared plan (codes only; who each code was sent to stays in the founder's own notes, never
// in this repository). A code is the utm_campaign of its links, so a result needs no manual entry.
// Recorded cost is self-reported and kept apart from ad spend measured by the platforms; it never feeds server/ads/funnel.js.
export const STATUSES = ['prepared', 'approved', 'sent', 'followed_up', 'replied', 'declined']
export const ACTIVITIES = [
  { key: 'email-local', title: 'Emails to Charleston owners', channel: 'Email, sent by hand', source: 'outreach', medium: 'email', outreach: true, codes: ['out-01', 'out-02', 'out-03', 'out-04', 'out-05'] },
  { key: 'email-regional', title: 'Emails to owners outside Charleston', channel: 'Email or the company’s contact form, by hand', source: 'outreach', medium: 'email', outreach: true, codes: ['out-53', 'out-49', 'out-58', 'out-52', 'out-38'] },
  { key: 'follow-up', title: 'Day-4 follow-up', channel: 'Same thread, once', derived: 'followUp', codes: [] },
  { key: 'referral', title: 'Referral asks', channel: 'In person or by phone', source: 'referral', medium: 'word', outreach: true, codes: ['ref-01', 'ref-02', 'ref-03'] },
  { key: 'counter-card', title: 'Supply-counter card', channel: 'Print, QR code to the chat', source: 'counter', medium: 'print', codes: ['counter-01'] },
  { key: 'founder-post', title: 'Founder post', channel: 'Your own LinkedIn or Facebook', source: 'social', medium: 'post', codes: ['social-01'] },
  { key: 'live-demo', title: 'Live demo for an owner you know', channel: 'In person', source: 'demo', medium: 'inperson', outreach: true, codes: ['demo-01'] },
  { key: 'listing', title: 'Association or chamber listing', channel: 'Directory listing', source: 'listing', medium: 'directory', codes: ['assoc-01'] },
  { key: 'landing', title: 'Pool-company landing page', channel: 'Destination for the others; not published', derived: 'destination', codes: [] },
  { key: 'paid-test', title: 'Capped paid test', channel: 'ChatGPT Ads, set up by you in Ads Manager', source: 'openai', medium: 'paid', paid: true, codes: ['oai-01'] },
]
const DAY = 86_400_000
export const FOLLOW_UP_DAYS = 4
const CODE_RE = /^[a-z0-9][a-z0-9-]{1,31}$/
const MAX_CODES = 300
const MAX_COST_CENTS = 10_000_000
const byKey = new Map(ACTIVITIES.map((a) => [a.key, a]))
const catalogActivity = (code) => ACTIVITIES.find((a) => a.codes.includes(code)) || null
const missing = (err) => String(err?.message).includes('no such table')

// A label names a company or a place for the founder's own reading ("Mount Pleasant supply counter"); never an email
// address or a phone number.
export function cleanLabel(v) {
  // eslint-disable-next-line no-control-regex
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (s.length > 60 || /@/.test(s) || /\d[\d\s().-]{5,}\d/.test(s)) return null
  return s
}

async function stored(db) {
  try {
    return { available: true, rows: (await db.prepare('SELECT code, activity, label, status, cost_cents, approved_at, sent_at, followed_up_at, replied_at, updated_at FROM acquisition_codes ORDER BY code LIMIT ?1').bind(MAX_CODES).all()).results }
  } catch (err) {
    if (!missing(err)) throw err
    return { available: false, rows: [] }
  }
}

// Paying and revenue are counted only in live billing (0 = none yet); in test mode they stay null (unavailable).
const zero = (live) => ({ prospects: 0, qualified: 0, consultationsBooked: 0, consultationsAttended: 0, businessesCreated: 0, paying: live ? 0 : null, revenueCents: live ? 0 : null })
const add = (t, r) => {
  for (const k of ['prospects', 'qualified', 'consultationsBooked', 'consultationsAttended', 'businessesCreated']) t[k] += Number(r[k] || 0)
  for (const k of ['paying', 'revenueCents']) if (r[k] != null) t[k] = (t[k] ?? 0) + Number(r[k])
  return t
}

// → the Activities view. `attribution` = salesAttribution() (null/unavailable → results are null, never zeros).
export async function acquisitionOverview(env, attribution, { origin = 'https://getshowups.com', now = Date.now() } = {}) {
  const { available, rows } = await stored(env.ONBOARDING_DB)
  const saved = new Map(rows.map((r) => [r.code, r]))
  const measured = attribution && !attribution.unavailable ? attribution : null
  const known = new Set()
  const ZERO = () => zero(Boolean(measured?.live))
  const link = (a, code, page) => `${origin}/${page}/getshowups?utm_source=${a.source}&utm_medium=${a.medium}&utm_campaign=${code}`
  const codeView = (a, code) => {
    known.add(code)
    const r = saved.get(code)
    const status = r?.status || 'prepared'
    const results = measured ? measured.bySource.filter((s) => s.campaign === code).reduce(add, ZERO()) : null
    return {
      code,
      label: r?.label || '',
      status,
      approvedAt: r?.approved_at ?? null,
      sentAt: r?.sent_at ?? null,
      followedUpAt: r?.followed_up_at ?? null,
      repliedAt: r?.replied_at ?? null,
      followUpDue: Boolean(a.outreach && status === 'sent' && r?.sent_at && now - r.sent_at >= FOLLOW_UP_DAYS * DAY),
      costCents: Number(r?.cost_cents || 0),
      links: { book: link(a, code, 'book'), chat: link(a, code, 'chat') },
      results,
    }
  }
  const activities = ACTIVITIES.map((a, i) => {
    const codes = a.derived ? [] : [...a.codes, ...rows.filter((r) => r.activity === a.key && !a.codes.includes(r.code)).map((r) => r.code)].map((c) => codeView(a, c))
    const count = (s) => codes.filter((c) => c.status === s).length
    return {
      n: i + 1,
      key: a.key,
      title: a.title,
      channel: a.channel,
      derived: a.derived || null,
      outreach: Boolean(a.outreach),
      paid: Boolean(a.paid),
      codes,
      status: Object.fromEntries(STATUSES.map((s) => [s, count(s)])),
      followUpsDue: codes.filter((c) => c.followUpDue).length,
      costCents: codes.reduce((n, c) => n + c.costCents, 0),
      results: measured && !a.derived ? codes.reduce((t, c) => add(t, c.results), ZERO()) : null,
    }
  })
  const all = activities.flatMap((a) => a.codes)
  const results = measured ? all.reduce((t, c) => add(t, c.results), ZERO()) : null
  // Prospects that did not arrive through a tracking code above (homepage buttons, a typed address, an ad campaign).
  const other = measured ? measured.bySource.filter((s) => !known.has(s.campaign)).map((s) => ({ source: s.source.replace(/^link:/, ''), campaign: s.campaign, ...add(ZERO(), s) })) : null
  const recorded = all.reduce((n, c) => n + c.costCents, 0)
  const reached = (...ss) => all.filter((c) => ss.includes(c.status)).length
  return {
    available,
    live: measured ? measured.live : null,
    days: measured?.days ?? null,
    statuses: STATUSES,
    activities,
    other,
    totals: {
      codes: all.length,
      approved: reached('approved'),
      sent: reached('sent', 'followed_up', 'replied', 'declined'),
      replied: reached('replied'),
      declined: reached('declined'),
      followUpsDue: all.filter((c) => c.followUpDue).length,
      results,
      recordedCostCents: recorded,
      adSpendCents: measured?.spendCents ?? null,
      // Everything it cost (your recorded costs + measured ad spend of GetShowUps' own campaigns) per paying customer
      // won through a tracking code: only in live billing with at least one, otherwise unavailable.
      costPerPayingCents: results?.paying > 0 ? Math.round((recorded + Number(measured.spendCents || 0)) / results.paying) : null,
    },
  }
}

// One change to one tracking code, by a platform admin. → { ok, code, from, to } | { ok: false, httpStatus, error }
export async function saveAcquisitionCode(env, input, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const code = String(input?.code || '')
  if (!CODE_RE.test(code)) return { ok: false, httpStatus: 400, error: 'invalid_code' }
  let existing, total
  try {
    existing = await db.prepare('SELECT * FROM acquisition_codes WHERE code = ?1').bind(code).first()
    total = existing ? 0 : (await db.prepare('SELECT count(*) AS n FROM acquisition_codes').first()).n
  } catch (err) {
    if (!missing(err)) throw err
    return { ok: false, httpStatus: 409, error: 'not_ready' }
  }
  // The activity comes from the catalog or the stored row; a NEW code names one that takes codes.
  const activity = catalogActivity(code)?.key || existing?.activity || (byKey.get(input?.activity)?.derived ? null : byKey.get(input?.activity)?.key) || null
  if (!activity) return { ok: false, httpStatus: 400, error: 'invalid_activity' }
  if (!existing && total >= MAX_CODES) return { ok: false, httpStatus: 409, error: 'too_many' }
  const next = { status: existing?.status || 'prepared', label: existing?.label || '', cost: Number(existing?.cost_cents || 0) }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) return { ok: false, httpStatus: 400, error: 'invalid_status' }
    next.status = input.status
  }
  if (input.label !== undefined) {
    const l = cleanLabel(input.label)
    if (l == null) return { ok: false, httpStatus: 400, error: 'invalid_label' }
    next.label = l
  }
  if (input.costCents !== undefined) {
    if (!Number.isInteger(input.costCents) || input.costCents < 0 || input.costCents > MAX_COST_CENTS) return { ok: false, httpStatus: 400, error: 'invalid_cost' }
    next.cost = input.costCents
  }
  // Times follow the status: the first time a step was reached is kept; stepping back clears the later ones.
  const rank = STATUSES.indexOf(next.status)
  const at = (col, from, also = true) => (rank >= from && also ? (existing?.[col] ?? now) : null)
  const times = [at('approved_at', 1, Boolean(existing?.approved_at) || next.status === 'approved'), at('sent_at', 2), at('followed_up_at', 3, Boolean(existing?.followed_up_at) || next.status === 'followed_up'), at('replied_at', 4)]
  await db
    .prepare(
      `INSERT INTO acquisition_codes (code, activity, label, status, cost_cents, approved_at, sent_at, followed_up_at, replied_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(code) DO UPDATE SET label = excluded.label, status = excluded.status, cost_cents = excluded.cost_cents, approved_at = excluded.approved_at, sent_at = excluded.sent_at, followed_up_at = excluded.followed_up_at, replied_at = excluded.replied_at, updated_at = excluded.updated_at`,
    )
    .bind(code, activity, next.label, next.status, next.cost, ...times, now)
    .run()
  return { ok: true, code, activity, created: !existing, from: { status: existing?.status || 'prepared', costCents: Number(existing?.cost_cents || 0) }, to: { status: next.status, costCents: next.cost } }
}
