// Revenue engine: lead follow-ups, booking confirmation, reminders, attendance confirmation, no-show
// rebooking, delivery honesty (nothing "sent" without a provider), SMS consent, scheduler endpoint,
// and tenant isolation. Google, Resend and Twilio are mocked; no real network.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { linkToken } from '../server/links.js'
import { processDueMessages, scheduleAppointmentMessages, TIMING } from '../server/messages.js'
import { sendSms, toE164 } from '../server/sms.js'
import { flushOutbox, enqueue, sendEmail } from '../server/email.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'
import * as bookAppt from '../functions/api/book/[customer]/appointment.js'
import * as outcomeApi from '../functions/api/dashboard/outcome.js'
import * as overviewApi from '../functions/api/dashboard/overview.js'
import * as automationsApi from '../functions/api/dashboard/automations.js'
import * as confirmApi from '../functions/api/appointment/confirm.js'
import * as cronApi from '../functions/api/cron/run.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const CRON = 'c'.repeat(40)
const SECRETS = ['re_SECRET', 'tw_SECRET', CRON, '1//rt', 'ya29.at', KEY]
const MIN = 6e4
const HOUR = 36e5
const DAY = 864e5

function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  const db = {
    sql,
    prepare: (q) => stmt(q),
    batch: async (list) => {
      sql.exec('BEGIN')
      try {
        for (const s of list) sql.prepare(s.q).run(...s.args)
        sql.exec('COMMIT')
      } catch (e) {
        sql.exec('ROLLBACK')
        throw e
      }
    },
  }
  return db
}

let env, db, kv, fetches, resend, twilio, origFetch, origError, logs, responses

async function seed(id, { owner = `owner@${id}.example`, zips = '' } = {}) {
  const t = Date.now()
  db.sql
    .prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', ?, '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)")
    .run(id, `${id} Co`, zips, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(owner, id, t)
  kv.set(
    `google:${id}`,
    JSON.stringify({ customer: id, clientId: 'cid', scope: 'https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }),
  )
}

const withEmail = () => Object.assign(env, { RESEND_API_KEY: 're_SECRET', EMAIL_FROM: 'GetShowUps <bookings@getshowups.com>', MESSAGES_LIVE: 'true' })
const withSms = () => Object.assign(env, { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tw_SECRET', TWILIO_MESSAGING_SERVICE_SID: 'MG123', MESSAGES_LIVE: 'true' })

beforeEach(() => {
  db = d1()
  kv = new Map()
  fetches = []
  responses = []
  env = {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'cs',
    GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`,
    TOKEN_ENCRYPTION_KEY: KEY,
    ADMIN_API_TOKEN: 'a'.repeat(40),
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), list: async () => ({ keys: [], list_complete: true }) },
  }
  resend = () => [200, { id: 'email_1' }]
  twilio = () => [201, { sid: 'SM1' }]
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push({ url: u, init })
    let out
    if (u === 'https://oauth2.googleapis.com/token') out = [200, { access_token: 'ya29.at', scope: 'x' }]
    else if (u.endsWith('/freeBusy')) out = [200, { calendars: { primary: { busy: [] } } }]
    else if (u.endsWith('/events?sendUpdates=all')) out = [200, { id: JSON.parse(init.body).id }]
    else if (u === 'https://api.resend.com/emails') out = resend(JSON.parse(init.body))
    else if (u === 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json') out = twilio(new URLSearchParams(init.body))
    else throw new Error(`unexpected ${u}`)
    return new Response(JSON.stringify(out[1]), { status: out[0] })
  }
  logs = []
  origError = console.error
  console.error = (...a) => logs.push(a.map(String).join(' '))
})

afterEach(() => {
  globalThis.fetch = origFetch
  console.error = origError
  const all = [...responses, ...logs].join('\n')
  for (const s of SECRETS) assert.ok(!all.includes(s), `secret leaked: ${s.slice(0, 6)}`)
  assert.ok(!logs.join('\n').includes('@example.net'), 'lead email in logs')
})

async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}

async function call(mod, method, path, { cookie, origin = ORIGIN, body, headers = {}, params, raw } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.9', ...headers }
  if (cookie) h.Cookie = cookie
  if (method === 'POST') h.Origin = origin
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({
    request: new Request(ORIGIN + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
    env,
    params,
  })
  const text = await res.clone().text()
  responses.push(text)
  return { res, status: res.status, json: () => JSON.parse(text), text }
}

const lead = (customer, extra = {}) =>
  call(bookLead, 'POST', `/api/book/${customer}/lead`, {
    params: { customer },
    body: { name: 'Jamie Rivera', email: 'jamie@example.net', phone: '(843) 555-0142', need: 'Weekly pool cleaning', zip: '29403', ...extra },
  })
const slots = async (customer) => (await call(bookInfo, 'GET', `/api/book/${customer}`, { params: { customer } })).json().slots
// A slot at least `minAheadMs` away, so reminders have room to be scheduled.
const slotAfter = async (customer, minAheadMs) => (await slots(customer)).find((s) => Date.parse(s) > Date.now() + minAheadMs)
const book = (customer, leadId, leadToken, start) => call(bookAppt, 'POST', `/api/book/${customer}/appointment`, { params: { customer }, body: { leadId, leadToken, start } })
const msgs = () => db.sql.prepare('SELECT id, kind, channel, status, error, send_at, attempts FROM messages ORDER BY send_at, id').all().map((r) => ({ ...r }))
const sentEmails = () => fetches.filter((f) => f.url === 'https://api.resend.com/emails').map((f) => JSON.parse(f.init.body))
const sentSms = () => fetches.filter((f) => f.url.includes('api.twilio.com')).map((f) => new URLSearchParams(f.init.body))
const linkIn = (text, re) => new URL(text.match(re)[0])

// ---------- lead follow-ups ----------

test('lead follow-ups: scheduled for qualified leads only, sent as the business, resume link books, then retire', async () => {
  await seed('alpha', { zips: '29403' })
  withEmail()
  const t0 = Date.now()
  const l = (await lead('alpha')).json()
  assert.equal(l.qualified, true)
  assert.deepEqual(
    msgs().map((m) => [m.kind, m.channel, m.status]),
    [['lead_followup_1', 'email', 'scheduled'], ['lead_followup_2', 'email', 'scheduled']],
  )
  assert.equal((await lead('alpha', { email: 'far@example.net', zip: '90210' })).json().qualified, false)
  assert.equal(msgs().length, 2, 'out-of-area lead gets no automated follow-up')

  assert.deepEqual(await processDueMessages(env, t0 + 5 * MIN), { sent: 0, failed: 0, skipped: 0, retry: 0 }, 'not due yet')
  assert.equal((await processDueMessages(env, t0 + TIMING.lead_followup_1.after + MIN)).sent, 1)
  const [email] = sentEmails()
  assert.equal(email.from, '"alpha Co via GetShowUps" <bookings@getshowups.com>')
  assert.deepEqual(email.to, ['jamie@example.net'])
  assert.equal(email.reply_to, 'owner@alpha.example')
  assert.match(email.subject, /Pick a time with alpha Co/)
  assert.match(email.text, /Hi Jamie,/)
  assert.equal(fetches.find((f) => f.url.includes('resend')).init.headers['Idempotency-Key'], `msg:lead_followup_1:email:${l.leadId}`)

  // The link in the email resumes booking for the same lead, without the browser token.
  const url = linkIn(email.text, /https:\/\/getshowups\.com\/book\/alpha\?\S+/)
  assert.equal(url.searchParams.get('lead'), l.leadId)
  const start = await slotAfter('alpha', 2 * DAY)
  assert.equal((await book('alpha', url.searchParams.get('lead'), url.searchParams.get('k'), start)).status, 201)

  await processDueMessages(env, t0 + TIMING.lead_followup_2.after + MIN)
  const second = msgs().find((m) => m.kind === 'lead_followup_2')
  assert.deepEqual([second.status, second.error], ['skipped', 'not_needed'], 'booked lead is not chased again')
  assert.equal(sentEmails().filter((e) => /Still need help/.test(e.subject)).length, 0)
})

test('resume tokens: bound to one lead and one business', async () => {
  await seed('alpha')
  await seed('beta')
  const a = (await lead('alpha')).json()
  const b = (await lead('alpha', { email: 'other@example.net' })).json()
  const start = await slotAfter('alpha', DAY)
  const tokenA = await linkToken(env, 'lead', a.leadId)
  assert.equal((await book('alpha', b.leadId, tokenA, start)).status, 404, "lead A's link cannot book lead B")
  assert.equal((await book('beta', a.leadId, tokenA, start)).status, 404, 'cannot book at another business')
  assert.equal((await book('alpha', a.leadId, await linkToken(env, 'confirm', a.leadId), start)).status, 404, 'a confirm token is not a booking token')
  assert.equal((await book('alpha', a.leadId, tokenA, start)).status, 201)
})

// ---------- delivery honesty ----------

test('no provider: due messages are skipped as no_provider, never sent later, and the dashboard says so', async () => {
  await seed('alpha')
  const t0 = Date.now()
  await lead('alpha')
  const r = await processDueMessages(env, t0 + 20 * MIN)
  assert.deepEqual(r, { sent: 0, failed: 0, skipped: 1, retry: 0 })
  assert.equal(fetches.filter((f) => /resend|twilio/.test(f.url)).length, 0)
  assert.deepEqual(msgs().map((m) => [m.status, m.error]), [['skipped', 'no_provider'], ['scheduled', null]])

  withEmail() // configuring a provider later must not deliver the old message
  await processDueMessages(env, t0 + 30 * MIN)
  assert.equal(sentEmails().length, 0)

  const ov = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie: await session('owner@alpha.example') })).json()
  assert.deepEqual(ov.automation, { enabled: true, email: true, sms: false, testMode: false, sent: 0, scheduled: 1, failed: 0, notSent: 1 })
})

test('retries: provider errors back off and stop after 3 attempts; an interrupted send is never repeated', async () => {
  await seed('alpha')
  withEmail()
  const t0 = Date.now()
  await lead('alpha')
  resend = () => [503, {}]
  let t = t0 + 16 * MIN
  assert.equal((await processDueMessages(env, t)).retry, 1)
  let m = msgs()[0]
  assert.deepEqual([m.status, m.attempts, m.error, m.send_at], ['scheduled', 1, 'http_503', t + 5 * MIN])
  t += 5 * MIN
  await processDueMessages(env, t)
  t += 10 * MIN
  assert.equal((await processDueMessages(env, t)).failed, 1)
  m = msgs()[0]
  assert.deepEqual([m.status, m.attempts], ['failed', 3])

  db.sql.prepare("UPDATE messages SET status = 'sending', updated_at = ? WHERE kind = 'lead_followup_2'").run(t0)
  await processDueMessages(env, t0 + 2 * DAY)
  assert.deepEqual(
    (({ status, error }) => [status, error])(msgs().find((x) => x.kind === 'lead_followup_2')),
    ['failed', 'interrupted'],
  )
})

// ---------- confirmations, reminders, attendance ----------

test('booking: confirmation now, reminders 24 h and 2 h before; the confirm link is read-only until tapped', async () => {
  await seed('alpha')
  withEmail()
  const l = (await lead('alpha')).json()
  const start = await slotAfter('alpha', 2 * DAY)
  const t0 = Date.now()
  assert.equal((await book('alpha', l.leadId, l.leadToken, start)).status, 201)
  const appt = db.sql.prepare('SELECT id, start_at FROM appointments').get()
  const byKind = Object.fromEntries(msgs().map((m) => [m.kind, m]))
  assert.ok(byKind.confirmation.send_at <= Date.now() && byKind.confirmation.send_at >= t0)
  assert.equal(byKind.reminder_24h.send_at, appt.start_at - DAY)
  assert.equal(byKind.reminder_2h.send_at, appt.start_at - 2 * HOUR)

  await processDueMessages(env, Date.now())
  const confirmation = sentEmails().find((e) => /You're booked/.test(e.subject))
  assert.ok(confirmation, 'confirmation sent')
  assert.equal(msgs().find((m) => m.kind === 'lead_followup_1').status, 'scheduled', 'follow-up retires at send time, not before')
  const link = linkIn(confirmation.text, /https:\/\/getshowups\.com\/api\/appointment\/confirm\?\S+/)
  const path = link.pathname + link.search

  const view = await call(confirmApi, 'GET', path)
  assert.equal(view.status, 200)
  assert.match(view.text, /Confirm your appointment/)
  assert.match(view.text, /alpha Co/)
  assert.ok(!view.text.includes('jamie@example.net') && !view.text.includes('Jamie'), 'no lead details on the page')
  assert.equal(db.sql.prepare('SELECT count(*) c FROM appointment_confirmations').get().c, 0, 'GET (link prefetch) changes nothing')

  const form = (a, k) => ({ raw: new URLSearchParams({ a, k }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
  const ok = await call(confirmApi, 'POST', '/api/appointment/confirm', form(appt.id, link.searchParams.get('k')))
  assert.equal(ok.status, 200)
  assert.match(ok.text, /You’re confirmed/)
  assert.equal((await call(confirmApi, 'POST', '/api/appointment/confirm', form(appt.id, link.searchParams.get('k')))).status, 200, 'idempotent')
  assert.equal(db.sql.prepare("SELECT count(*) c FROM events WHERE type = 'appointment_confirmed'").get().c, 1)

  // Tampering: wrong token, or a valid token for a different id.
  assert.equal((await call(confirmApi, 'GET', `/api/appointment/confirm?a=${appt.id}&k=${'x'.repeat(43)}`)).status, 404)
  const other = 'f'.repeat(32)
  assert.equal((await call(confirmApi, 'GET', `/api/appointment/confirm?a=${other}&k=${link.searchParams.get('k')}`)).status, 404)

  const ov = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie: await session('owner@alpha.example') })).json()
  assert.equal(ov.stats.confirmed, 1)
  assert.equal(ov.upcoming[0].confirmed, true)

  // The reminder for a confirmed appointment does not ask again.
  await processDueMessages(env, appt.start_at - DAY + MIN)
  const reminder = sentEmails().find((e) => /^Reminder:/.test(e.subject))
  assert.match(reminder.text, /See you then!/)
  assert.ok(!reminder.text.includes('/api/appointment/confirm'))
  assert.equal(msgs().find((m) => m.kind === 'lead_followup_2').status, 'skipped')
})

test('reminders are only scheduled when there is time for them; late or past ones never go out', async () => {
  const now = Date.now()
  const rows = (startIn) => {
    db = d1()
    env.ONBOARDING_DB = db
    db.sql.exec("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('alpha', 'A', 'UTC', 0, 0); INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES ('l1', 'alpha', 'N', 'n@example.net', '1', 'x', 'booked', 'h', 0, 0); INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, created_at, updated_at) VALUES ('a1', 'alpha', 'l1', 0, 0, 'booked', 0, 0)")
    return scheduleAppointmentMessages(env, { id: 'alpha', automations: true }, { id: 'a1', leadId: 'l1', start: now + startIn }, now).then(() => msgs().map((m) => m.kind).sort())
  }
  assert.deepEqual(await rows(3 * DAY), ['confirmation', 'reminder_24h', 'reminder_2h'])
  assert.deepEqual(await rows(5 * HOUR), ['confirmation', 'reminder_2h'])
  assert.deepEqual(await rows(HOUR), ['confirmation'])

  // A reminder whose appointment has started is skipped even if the scheduler was down.
  await seed('beta')
  withEmail()
  const l = (await lead('beta')).json()
  const start = await slotAfter('beta', 2 * DAY)
  await book('beta', l.leadId, l.leadToken, start)
  await processDueMessages(env, Date.parse(start) + MIN)
  assert.equal(sentEmails().length, 0)
  assert.ok(msgs().every((m) => m.status === 'skipped'))
})

// ---------- no-shows ----------

test('no-show: rebook invitation after a short delay; skipped if the owner corrects it; the lead can rebook', async () => {
  await seed('alpha')
  withEmail()
  const cookie = await session('owner@alpha.example')
  const mk = async (email) => {
    const l = (await lead('alpha', { email })).json()
    const start = (await slots('alpha')).filter((s) => !db.sql.prepare('SELECT 1 FROM appointments WHERE start_at = ?').get(Date.parse(s)))[3]
    await book('alpha', l.leadId, l.leadToken, start)
    return db.sql.prepare('SELECT a.id FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE l.email = ?').get(email).id
  }
  const missed = await mk('missed@example.net')
  const mistaken = await mk('mistake@example.net')
  db.sql.prepare('UPDATE appointments SET start_at = start_at - ?, end_at = end_at - ?').run(3 * DAY, 3 * DAY)
  db.sql.exec("UPDATE messages SET status = 'skipped', error = 'test'") // ignore booking messages here

  const t0 = Date.now()
  for (const id of [missed, mistaken]) assert.equal((await call(outcomeApi, 'POST', '/api/dashboard/outcome', { cookie, body: { id, outcome: 'no_show' } })).status, 200)
  assert.equal((await call(outcomeApi, 'POST', '/api/dashboard/outcome', { cookie, body: { id: mistaken, outcome: 'showed' } })).status, 200)

  assert.equal((await processDueMessages(env, t0 + 10 * MIN)).sent, 0, 'owner has time to fix a mis-click')
  await processDueMessages(env, t0 + TIMING.no_show_rebook.after + MIN)
  const rebook = sentEmails().filter((e) => /Sorry we missed you/.test(e.subject))
  assert.equal(rebook.length, 1)
  assert.deepEqual(rebook[0].to, ['missed@example.net'])
  assert.deepEqual(
    (({ status, error }) => [status, error])(msgs().find((m) => m.id === `no_show_rebook:email:${mistaken}`)),
    ['skipped', 'not_needed'],
  )

  const url = linkIn(rebook[0].text, /https:\/\/getshowups\.com\/book\/alpha\?\S+/)
  const start = await slotAfter('alpha', 2 * DAY)
  assert.equal((await book('alpha', url.searchParams.get('lead'), url.searchParams.get('k'), start)).status, 201, 'rebooked from the message')
})

// ---------- SMS ----------

test('SMS: offered only when configured; sent only with consent (recorded), in E.164; opt-outs are not retried', async () => {
  await seed('alpha')
  assert.equal((await call(bookInfo, 'GET', '/api/book/alpha', { params: { customer: 'alpha' } })).json().offerSms, false)
  withSms()
  withEmail()
  assert.equal((await call(bookInfo, 'GET', '/api/book/alpha', { params: { customer: 'alpha' } })).json().offerSms, true)

  const t0 = Date.now()
  const yes = (await lead('alpha', { smsConsent: true })).json()
  await lead('alpha', { email: 'nosms@example.net', smsConsent: 'yes' }) // only boolean true counts
  assert.deepEqual(
    msgs().filter((m) => m.channel === 'sms').map((m) => m.id),
    [`lead_followup_1:sms:${yes.leadId}`, `lead_followup_2:sms:${yes.leadId}`],
  )
  const consent = db.sql.prepare('SELECT lead_id, customer, wording FROM sms_consents').all().map((r) => ({ ...r }))
  assert.deepEqual(consent, [{ lead_id: yes.leadId, customer: 'alpha', wording: 'booking-sms-v1' }])

  await processDueMessages(env, t0 + 16 * MIN)
  const [sms] = sentSms()
  assert.equal(sms.get('To'), '+18435550142')
  assert.equal(sms.get('MessagingServiceSid'), 'MG123')
  assert.match(sms.get('Body'), /^alpha Co: Hi Jamie,.*Reply STOP to opt out\.$/)
  assert.equal(fetches.find((f) => f.url.includes('twilio')).init.headers.Authorization, `Basic ${btoa('AC123:tw_SECRET')}`)

  twilio = () => [400, { code: 21610, message: 'Attempt to send to unsubscribed recipient' }]
  await processDueMessages(env, t0 + DAY + MIN)
  const m = msgs().find((x) => x.id === `lead_followup_2:sms:${yes.leadId}`)
  assert.deepEqual([m.status, m.error, m.attempts], ['failed', 'twilio_21610', 1])

  assert.equal(toE164('843.555.0142'), '+18435550142')
  assert.equal(toE164('1 (843) 555-0142'), '+18435550142')
  assert.equal(toE164('+44 20 7946 0958'), '+442079460958')
  assert.equal(toE164('555-0142'), null)
})

// ---------- settings, isolation, scheduler ----------

test('automations off: nothing scheduled, due messages skipped, toggle is per business and same-origin only', async () => {
  await seed('alpha')
  await seed('beta')
  withEmail()
  const alpha = await session('owner@alpha.example')
  const t0 = Date.now()
  await lead('alpha') // scheduled while on
  assert.equal((await call(automationsApi, 'POST', '/api/dashboard/automations', { cookie: alpha, origin: 'https://evil.example', body: { enabled: false } })).status, 403)
  assert.equal((await call(automationsApi, 'POST', '/api/dashboard/automations', { cookie: alpha, body: { enabled: 'no' } })).status, 400)
  assert.equal((await call(automationsApi, 'POST', '/api/dashboard/automations', { cookie: alpha, body: { enabled: false } })).status, 200)

  await lead('alpha', { email: 'later@example.net' })
  await lead('beta')
  assert.equal(msgs().filter((m) => m.id.endsWith(db.sql.prepare("SELECT id FROM leads WHERE email = 'later@example.net'").get().id)).length, 0)
  await processDueMessages(env, t0 + 20 * MIN)
  assert.deepEqual(sentEmails().map((e) => e.reply_to), ['owner@beta.example'], 'beta unaffected; alpha sends nothing')
  assert.equal(msgs().find((m) => m.status === 'skipped').error, 'disabled')

  const ovA = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie: alpha })).json()
  const ovB = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie: await session('owner@beta.example') })).json()
  assert.equal(ovA.automation.enabled, false)
  assert.equal(ovA.automation.sent, 0)
  assert.equal(ovB.automation.enabled, true)
  assert.equal(ovB.automation.sent, 1, 'counts are per business')
})

test('scheduler endpoint: fails closed, requires the exact secret, returns counts only', async () => {
  await seed('alpha')
  withEmail()
  await lead('alpha')
  const run = (auth) => call(cronApi, 'POST', '/api/cron/run', { headers: auth ? { Authorization: auth } : {} })
  assert.equal((await run(`Bearer ${CRON}`)).status, 503, 'no CRON_SECRET configured')
  env.CRON_SECRET = 'short'
  assert.equal((await run('Bearer short')).status, 503, 'weak secret refused')
  env.CRON_SECRET = CRON
  assert.equal((await run()).status, 401)
  assert.equal((await run(`Bearer ${CRON.slice(0, -1)}`)).status, 401)
  assert.equal((await run(CRON)).status, 401)
  const ok = await run(`Bearer ${CRON}`)
  assert.equal(ok.status, 200)
  assert.deepEqual(Object.keys(ok.json()).sort(), ['messages', 'onboardingQueued', 'outbox'])
  assert.ok(!ok.text.includes('example.net'))
  assert.equal(cronApi.onRequestGet, undefined, 'POST only')
})

test('launch gate (fails closed): before MESSAGES_LIVE, only test recipients get email/texts; others never burst later', async () => {
  await seed('alpha')
  Object.assign(env, { RESEND_API_KEY: 're_SECRET', EMAIL_FROM: 'GetShowUps <bookings@getshowups.com>' }) // no MESSAGES_LIVE
  const t0 = Date.now()
  await lead('alpha') // jamie@example.net: not a test recipient
  await lead('alpha', { email: 'Tester@Example.org' })
  env.MESSAGE_TEST_RECIPIENTS = ' tester@example.org , +18435550199'
  const r = await processDueMessages(env, t0 + 20 * MIN)
  assert.deepEqual(r, { sent: 1, failed: 0, skipped: 1, retry: 0 })
  assert.deepEqual(sentEmails().map((e) => e.to), [['tester@example.org']])
  assert.equal(db.sql.prepare("SELECT count(*) c FROM messages WHERE status = 'skipped' AND error = 'test_mode'").get().c, 1)

  env.MESSAGES_LIVE = 'true' // going live later must not deliver the held lead message
  await processDueMessages(env, t0 + 30 * MIN)
  assert.equal(sentEmails().length, 1)
  delete env.MESSAGES_LIVE

  // Defense in depth at the provider call, and the account outbox holds (does not fail) other recipients.
  assert.deepEqual(await sendEmail(env, { id: 'x', to: 'someone@example.net', subject: 's', text: 't' }), { ok: false, error: 'test_mode', permanent: true })
  assert.deepEqual(await sendSms({ ...env, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1' }, { to: '8435550142', text: 't' }), { ok: false, error: 'test_mode', permanent: true })
  await enqueue(env, { id: 'held', to: 'owner@other.example', template: 't', subject: 's', body: 'b' })
  const before = sentEmails().length
  assert.deepEqual(await flushOutbox(env), { configured: true, sent: 0, failed: 0 })
  assert.equal(sentEmails().length, before)
  assert.deepEqual({ ...db.sql.prepare("SELECT status, attempts FROM email_outbox WHERE id = 'held'").get() }, { status: 'pending', attempts: 0 })

  const ov = (await call(overviewApi, 'GET', '/api/dashboard/overview', { cookie: await session('owner@alpha.example') })).json()
  assert.equal(ov.automation.testMode, true)
})

test('repeated and overlapping scheduler runs never send a message twice', async () => {
  await seed('alpha')
  withEmail()
  const t0 = Date.now()
  await lead('alpha')
  const runs = await Promise.all([1, 2, 3].map(() => processDueMessages(env, t0 + 20 * MIN)))
  assert.equal(runs.reduce((n, r) => n + r.sent, 0), 1)
  for (let i = 0; i < 3; i++) await processDueMessages(env, t0 + (21 + i) * MIN)
  assert.equal(sentEmails().length, 1)
  const ids = fetches.filter((f) => f.url === 'https://api.resend.com/emails').map((f) => f.init.headers['Idempotency-Key'])
  assert.deepEqual(ids, ['msg:lead_followup_1:email:' + db.sql.prepare('SELECT id FROM leads').get().id])
})
