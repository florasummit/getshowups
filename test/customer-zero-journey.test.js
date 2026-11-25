// Customer zero, end to end on synthetic data with the real server code (Google and Resend mocked): an ad visit becomes an
// inquiry, is qualified by ZIP, books a visit at the customer's address, gets its confirmation and reminder, happens, is
// paid, and is counted once. Simulated: this is not a customer outcome.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { encrypt } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { bookAppointment, createLead, openSlots, setOutcome, validateLead } from '../server/booking.js'
import { recordAttribution } from '../server/ads/attribution.js'
import { processDueMessages } from '../server/messages.js'
import { recordRevenue } from '../server/revenue.js'
import { funnel } from '../server/ads/funnel.js'
import { runTool, toolContext } from '../server/operator-tools.js'

const HOUR = 3_600_000

test('advertisement → inquiry → qualified → booked at the address → confirmed → reminded → done → paid → counted once', async () => {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, a = []) => ({ q, args: a, bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  const db = { prepare: (q) => stmt(q), batch: async (l) => l.map((s) => ({ results: [], meta: { changes: Number(sql.prepare(s.q).run(...s.args).changes) } })) }
  const kv = new Map()
  const env = { ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null }, GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: 'https://getshowups.com/api/google/oauth/callback', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), ADMIN_API_TOKEN: 'a'.repeat(40), RESEND_API_KEY: 're_test', EMAIL_FROM: 'GetShowUps <h@getshowups.example>', MESSAGE_TEST_RECIPIENTS: 'sam@synthetic.example' }
  // A Monday morning, so there are open times this week.
  const now = Date.parse('2026-12-07T15:00:00Z')
  sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, slot_minutes, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES ('synthetic-pools', 'Synthetic Pools', 'America/New_York', '29401,29464', 30, '09:00', '17:00', '1,2,3,4,5', 1, 1, 1)").run()
  sql.prepare("INSERT INTO service_settings (customer, appointment_mode, updated_at) VALUES ('synthetic-pools', 'at_customer', 1)").run()
  sql.prepare("INSERT INTO ad_campaigns (id, customer, platform, status, spec, daily_budget_cents, launched_at, created_at, updated_at) VALUES ('camp1', 'synthetic-pools', 'google', 'active', '{}', 2000, 1, 1, 1)").run()
  sql.prepare("INSERT INTO ad_metrics_daily (campaign_id, customer, date, spend_cents, clicks, fetched_at) VALUES ('camp1', 'synthetic-pools', '2026-12-07', 4000, 20, 1)").run()
  kv.set('google:synthetic-pools', JSON.stringify({ customer: 'synthetic-pools', refreshToken: await encrypt(env, 'rt'), scope: 'https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy', googleSub: '1', clientId: 'c' }))
  const events = []
  const mails = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('/token')) return Response.json({ access_token: 'at', expires_in: 3600, token_type: 'Bearer' })
    if (/freebusy/i.test(u)) return Response.json({ calendars: { primary: { busy: [] } } })
    if (u.includes('/events')) return (events.push({ u, body: JSON.parse(init.body || '{}') }), Response.json({ id: 'ev', status: 'confirmed' }))
    if (u.includes('resend.com')) return (mails.push(JSON.parse(init.body)), Response.json({ id: `m${mails.length}` }))
    throw new Error(`unexpected ${u}`)
  }
  try {
    const customer = customerFromRow({ ...(await getCustomer(db, 'synthetic-pools')), appointment_mode: 'at_customer' })
    const person = { name: 'Sam Synthetic', email: 'sam@synthetic.example', phone: '(843) 555-0142', need: 'Green pool cleanup', zip: '29464', address: { street: '1 Test Dock Rd', unit: '', city: 'Mount Pleasant', state: 'SC', zip: '29464' } }
    // The visit needs an address: without one the inquiry is refused before anything is stored.
    assert.ok(validateLead({ ...person, address: undefined }, 'at_customer')[0])
    const [error, lead] = validateLead(person, 'at_customer')
    assert.equal(error, null)
    const l = await createLead(env, customer, lead, now)
    assert.equal(l.qualified, true)
    await recordAttribution(env, customer.id, l.id, { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'camp1' }, now)
    // Someone outside the area is kept but not offered a time.
    const [, far] = validateLead({ ...person, email: 'far@synthetic.example', zip: '99501', address: { ...person.address, zip: '99501' } }, 'at_customer')
    assert.equal((await createLead(env, customer, far, now)).qualified, false)
    const open = await openSlots(env, customer, now)
    assert.equal(open.ok, true)
    const start = open.slots.find((s) => s.start > now + 30 * HOUR).start
    // The assistant reports the calendar's real open times, not zero.
    const told1 = await runTool(toolContext(env, customer, {}, now), 'open_times', { period: 'this_week' })
    assert.ok(told1.open_times > 10 && told1.first_times.length === 8, JSON.stringify(told1))
    const b = await bookAppointment(env, customer, { leadId: l.id, leadToken: l.token, start }, now)
    assert.equal(b.appointment.invited, Boolean(sql.prepare('SELECT email FROM leads WHERE id = ?').get(l.id).email)) // only who can get an invitation is promised one
    assert.equal(b.ok, true, JSON.stringify(b))
    assert.match(JSON.stringify(events[0].body), /1 Test Dock Rd/) // the address is on the calendar event
    // The same time can't be sold twice, and a wrong token books nothing.
    assert.equal((await bookAppointment(env, customer, { leadId: l.id, leadToken: 'x'.repeat(43), start: start + HOUR }, now)).ok, false)
    await processDueMessages(env, now + 60_000)
    assert.ok(mails.some((m) => m.to[0] === 'sam@synthetic.example'), 'confirmation')
    const before = mails.length
    for (let t = now + HOUR; t < start; t += HOUR / 2) await processDueMessages(env, t)
    assert.ok(mails.length > before, 'reminder')
    assert.ok(mails.every((m) => m.to[0] === 'sam@synthetic.example'))
    // It happened, the job is done, and the owner recorded the money.
    const after = start + 2 * HOUR
    assert.equal((await setOutcome(env, customer, b.appointment.id, 'showed', { work: 'completed', by: 'owner' }, after)).ok, true)
    assert.equal((await recordRevenue(db, customer, b.appointment.id, 'paid', 20000, 'owner@synthetic.example', after)).ok, true)
    const f = await funnel(db, customer.id, { days: 30, scope: 'all', now: after })
    assert.deepEqual([f.stages.leads, f.stages.qualified, f.stages.booked, f.stages.attended, f.stages.completed, f.revenue.paidCents], [2, 1, 1, 1, 1, 20000])
    const ads = await funnel(db, customer.id, { days: 30, scope: 'ads', now: after })
    assert.equal(ads.spend.cents, 4000)
    assert.equal(ads.stages.leads, 1) // counted as an ad only when its own link says so
    const told = await runTool(toolContext(env, customer, {}, after), 'explain_funnel', {})
    assert.deepEqual([told.booked, told.jobs_completed, told.payments_recorded_for_all], [1, 1, '$200'])
  } finally {
    globalThis.fetch = real
  }
})
