// Follow-up engine (server/followups/): website form → lead → permitted acknowledgment; texts only when the business
// is ready (provider + own sender + APPROVED registration) and the person consented; two-way texts with fixed
// STOP/HELP/START/human handling and a constrained assistant; booking stops sales follow-ups; idempotent webhooks and
// sends; quiet hours and limits; pause / kill switch / test mode; tenant isolation; registration honesty.
// Twilio, Resend, Google and the AI model are mocked; no real network, no paid calls.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { encrypt, sha256Hex } from '../server/google-oauth.js'
import { processDueMessages } from '../server/messages.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { formToken, submitSiteForm } from '../server/site-form.js'
import { twilioSignature, segmentsOf } from '../server/followups/transport.js'
import { classify, checkReply } from '../server/followups/assistant.js'
import { inQuietHours, validateSettings, smsReadiness, registrationOf } from '../server/followups/settings.js'
import { processReplies, sendQueued, handleInbound } from '../server/followups/engine.js'
import { validateFacts } from '../server/followups/registration.js'
import { sealToken } from '../server/followups/twilio.js'
import * as bookInfo from '../functions/api/book/[customer]/index.js'
import * as bookLead from '../functions/api/book/[customer]/lead.js'
import * as bookAppt from '../functions/api/book/[customer]/appointment.js'
import * as inboundApi from '../functions/api/sms/twilio/inbound.js'
import * as statusApi from '../functions/api/sms/twilio/status.js'
import * as followupsApi from '../functions/api/dashboard/followups/index.js'
import * as threadApi from '../functions/api/dashboard/followups/thread.js'
import * as textingApi from '../functions/api/dashboard/followups/texting.js'
import * as platformApi from '../functions/api/platform/messaging.js'
import * as termsPage from '../functions/sms-terms/[customer].js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const SECRETS = ['re_SECRET', 'tw_SECRET', '1//rt', 'ya29.at', KEY]
const MIN = 6e4
const DAY = 864e5
const PHONE = '+18435550142'
const SENDER = { alpha: '+18435550100', beta: '+18435550200' }
// Each business's own Twilio subaccount (sid + its own auth token, stored sealed like production).
const SUB = { alpha: `AC${'a'.repeat(32)}`, beta: `AC${'b'.repeat(32)}` }
const SUB_TOKEN = { alpha: 'sub_alpha_SECRET_token_1234', beta: 'sub_beta_SECRET_token_5678' }
const SEALED = { alpha: await sealToken({ TOKEN_ENCRYPTION_KEY: KEY }, 'alpha', SUB.alpha, SUB_TOKEN.alpha), beta: await sealToken({ TOKEN_ENCRYPTION_KEY: KEY }, 'beta', SUB.beta, SUB_TOKEN.beta) }
const accountOfSender = (to) => Object.keys(SENDER).find((k) => SENDER[k] === to)

function d1({ skip = [] } = {}) {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) if (!skip.some((s) => f.startsWith(s))) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q,
    args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return {
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
}

let env, db, kv, fetches, twilio, ai, origFetch, origError, logs, responses

async function seed(id) {
  const t = Date.now()
  db.sql
    .prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '00:00', '23:00', '0,1,2,3,4,5,6', ?, ?, ?)")
    .run(id, `${id} Co`, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '(843) 555-0199', 'pool', '', ?, '[\"Charleston\"]', ?)").run(id, JSON.stringify([{ name: 'Weekly pool care', price: '$280' }, { name: 'Green pool cleanup' }]), t)
  kv.set(`google:${id}`, JSON.stringify({ customer: id, clientId: 'cid', scope: 'https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy', refreshToken: await encrypt({ TOKEN_ENCRYPTION_KEY: KEY }, '1//rt') }))
}
const withEmail = () => Object.assign(env, { RESEND_API_KEY: 're_SECRET', EMAIL_FROM: 'GetShowUps <bookings@getshowups.com>', MESSAGES_LIVE: 'true' })
const withTwilio = () => Object.assign(env, { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tw_SECRET', TWILIO_MESSAGING_SERVICE_SID: 'MGplatform', SMS_LIVE: 'true', MESSAGES_LIVE: 'true' })
// A business's texting setup as a platform admin would record it (status = what the provider reported).
const register = (id, status, { quiet = false } = {}) => {
  db.sql.prepare("INSERT OR REPLACE INTO sms_registrations (customer, legal_name, status, approved_at, sender_phone, updated_at) VALUES (?, 'x', ?, 1, ?, 1)").run(id, status, SENDER[id])
  db.sql.prepare("INSERT OR IGNORE INTO sms_accounts (customer, account_sid, auth_token_enc, status, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, 1)").run(id, SUB[id], SEALED[id])
  if (!quiet) db.sql.prepare('INSERT OR REPLACE INTO followup_settings (customer, quiet_start, quiet_end, updated_at) VALUES (?, 0, 0, 1)').run(id)
}

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
    PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com',
    ONBOARDING_DB: db,
    GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), list: async () => ({ keys: [], list_complete: true }) },
  }
  twilio = () => [201, { sid: `SM${fetches.length}` }]
  ai = () => ({ response: { intent: 'question', answerable: true, reply: 'Weekly pool care is $280.' }, usage: { prompt_tokens: 900, completion_tokens: 40 } })
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push({ url: u, init })
    let out
    if (u === 'https://oauth2.googleapis.com/token') out = [200, { access_token: 'ya29.at', scope: 'x' }]
    else if (u.endsWith('/freeBusy')) out = [200, { calendars: { primary: { busy: [] } } }]
    else if (u.endsWith('/events?sendUpdates=all')) out = [200, { id: JSON.parse(init.body).id }]
    else if (u === 'https://api.resend.com/emails') out = [200, { id: 'email_1' }]
    // Texts are sent only under a business's OWN subaccount (parent credentials, subaccount path).
    else if (Object.values(SUB).some((s) => u === `https://api.twilio.com/2010-04-01/Accounts/${s}/Messages.json`)) out = twilio(new URLSearchParams(init.body))
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
  assert.ok(!logs.join('\n').includes('555-0142') && !logs.join('\n').includes(PHONE), 'phone number in logs')
})

const withAi = () => Object.assign(env, { FOLLOWUP_AI: 'true', AI: { run: async (model, body) => ai(body) } })

async function session(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}

async function call(mod, method, path, { cookie, origin = ORIGIN, body, headers = {}, params, raw } = {}) {
  const h = { 'CF-Connecting-IP': '203.0.113.9', ...headers }
  if (cookie) h.Cookie = cookie
  if (method === 'POST') h.Origin = origin
  const waits = []
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({
    request: new Request(ORIGIN + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
    env,
    params,
    waitUntil: (p) => waits.push(p),
  })
  await Promise.all(waits)
  const text = await res.clone().text()
  responses.push(text)
  return { res, status: res.status, json: () => JSON.parse(text), text }
}

// A Twilio webhook, signed like Twilio signs it: by the subaccount that owns the business number (AccountSid).
async function inbound(fields, { sign = true, path = '/api/sms/twilio/inbound', token } = {}) {
  const biz = accountOfSender(fields.To) || accountOfSender(fields.From) || 'alpha'
  const params = new URLSearchParams({ AccountSid: SUB[biz], ...fields })
  const sig = sign ? await twilioSignature(token || SUB_TOKEN[biz], ORIGIN + path, params) : 'bad'
  return call(path.includes('status') ? statusApi : inboundApi, 'POST', path, { raw: params.toString(), headers: { 'X-Twilio-Signature': sig, 'Content-Type': 'application/x-www-form-urlencoded' } })
}
const text = (from, body, sid, to = SENDER.alpha) => inbound({ From: from, To: to, Body: body, MessageSid: sid })

const bookingLead = (customer, extra = {}) =>
  call(bookLead, 'POST', `/api/book/${customer}/lead`, { params: { customer }, body: { name: 'Jamie Rivera', email: 'jamie@example.net', phone: '(843) 555-0142', need: 'Weekly pool cleaning', zip: '29403', ...extra } })
async function formLead(customer, extra = {}) {
  const c = customerFromRow(await getCustomer(db, customer))
  const t0 = Date.now() - 10_000
  return submitSiteForm(env, c, { t: await formToken(env, customer, t0), name: 'Jamie Rivera', email: 'jamie@example.net', phone: '(843) 555-0142', need: 'Green pool, need help', kind: 'contact', ...extra }, Date.now())
}
const sentSms = () => fetches.filter((f) => f.url.includes('api.twilio.com')).map((f) => new URLSearchParams(f.init.body))
const sentEmails = () => fetches.filter((f) => f.url === 'https://api.resend.com/emails').map((f) => JSON.parse(f.init.body))
const threadMsgs = (lead) => db.sql.prepare('SELECT id, direction, channel, author, body, status, error, cost_micros FROM thread_messages WHERE lead_id = ? ORDER BY created_at, id').all(lead).map((r) => ({ ...r }))
const thread = (lead) => ({ ...db.sql.prepare('SELECT * FROM lead_threads WHERE lead_id = ?').get(lead) })
const smsConsentLead = async (customer = 'alpha') => (await bookingLead(customer, { smsConsent: true })).json().leadId

// ---------- lead → acknowledgment ----------

test('website form → lead (source website_form) → acknowledgment email right away, shown in the conversation; no text without consent', async () => {
  await seed('alpha')
  withEmail()
  const r = await formLead('alpha')
  assert.equal(r.state, 'sent')
  assert.equal(thread(r.leadId).source, 'website_form')
  const kinds = db.sql.prepare('SELECT kind, channel FROM messages WHERE lead_id = ? ORDER BY send_at').all(r.leadId).map((m) => `${m.kind}:${m.channel}`)
  assert.deepEqual(kinds, ['lead_ack:email', 'lead_followup_2:email'])
  const out = await processDueMessages(env, Date.now() + 1000)
  assert.equal(out.sent, 1)
  const [mail] = sentEmails()
  assert.match(mail.subject, /alpha Co got your message/)
  assert.match(mail.text, /Green pool, need help/)
  assert.match(mail.text, /\/book\/alpha\?/)
  assert.equal(sentSms().length, 0)
  const tm = threadMsgs(r.leadId)
  assert.deepEqual(tm.map((m) => [m.direction, m.channel, m.author, m.status]), [['out', 'email', 'auto', 'sent']])
  assert.equal(thread(r.leadId).stage, 'contacted')
})

test('preferences: no acknowledgment and no nudges → nothing scheduled; booking-page leads keep the 15-minute first nudge by default', async () => {
  await seed('alpha')
  withEmail()
  db.sql.prepare('INSERT INTO followup_settings (customer, acknowledge, nudges, updated_at) VALUES (?, 0, 0, 1)').run('alpha')
  const r = await formLead('alpha')
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM messages WHERE lead_id = ?').get(r.leadId).n, 0)
  db.sql.prepare('DELETE FROM followup_settings').run()
  const b = (await bookingLead('alpha')).json()
  assert.deepEqual(db.sql.prepare('SELECT kind FROM messages WHERE lead_id = ? ORDER BY send_at').all(b.leadId).map((m) => m.kind), ['lead_followup_1', 'lead_followup_2'])
  assert.equal(thread(b.leadId).source, 'booking_page')
  assert.deepEqual(validateSettings({ quietStart: 22, quietEnd: 23 }), ['quiet_hours_too_short', null])
  assert.equal(validateSettings({ nudges: 5 })[0], 'invalid_settings')
})

// ---------- texting readiness ----------

test('consent box before approval (carriers review it), but never a text before the provider approves; approved → text from the business sender', async () => {
  await seed('alpha')
  withEmail()
  withTwilio()
  const offer = async () => (await call(bookInfo, 'GET', '/api/book/alpha', { params: { customer: 'alpha' } })).json().offerSms
  // No registration, details only, or not yet approved by the owner → no box, and consent sent anyway is NOT recorded.
  assert.equal(await offer(), false)
  const sneaky = (await bookingLead('alpha', { smsConsent: true, email: 'sneaky@example.net', phone: '843-555-0166' })).json().leadId
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM sms_consents WHERE lead_id = ?').get(sneaky).n, 0, 'consent only where the box is offered')
  db.sql.prepare("INSERT INTO sms_registrations (customer, legal_name, status, updated_at) VALUES ('alpha', 'x', 'ready', 1)").run()
  assert.equal(await offer(), false, 'details saved but the owner has not approved submission')
  // Owner approved submission → box shown (status ready, then pending with the provider), still no texts.
  db.sql.prepare("UPDATE sms_registrations SET approved_at = 1 WHERE customer = 'alpha'").run()
  assert.equal(await offer(), true)
  register('alpha', 'pending')
  assert.equal(await offer(), true, 'carriers review the live opt-in while the registration is pending')
  env.MESSAGING_KILL_SWITCH = 'true'
  assert.equal(await offer(), false, 'kill switch closes it')
  delete env.MESSAGING_KILL_SWITCH
  for (const s of ['rejected', 'suspended']) {
    db.sql.prepare('UPDATE sms_registrations SET status = ? WHERE customer = ?').run(s, 'alpha')
    assert.equal(await offer(), false, `${s} closes it`)
  }
  register('alpha', 'pending')
  assert.deepEqual(smsReadiness(env, await registrationOf(db, 'alpha')).reasons, ['registration_pending'])
  // Without its own subaccount a business can never text (never from the parent or another business's account).
  assert.ok(smsReadiness(env, db.sql.prepare('SELECT * FROM sms_registrations').get()).reasons.includes('no_account'))
  const l = await smsConsentLead()
  await processDueMessages(env, Date.now() + 16 * MIN)
  assert.equal(sentSms().length, 0, 'never texted before approval')
  assert.equal(db.sql.prepare("SELECT error FROM messages WHERE lead_id = ? AND channel = 'sms' AND kind = 'lead_followup_1'").get(l).error, 'sms_not_ready')

  register('alpha', 'approved')
  assert.equal((await call(bookInfo, 'GET', '/api/book/alpha', { params: { customer: 'alpha' } })).json().offerSms, true)
  const l2 = (await bookingLead('alpha', { smsConsent: true, email: 'other@example.net', phone: '843-555-0177' })).json().leadId
  await processDueMessages(env, Date.now() + 16 * MIN)
  const [sms] = sentSms()
  assert.equal(sms.get('From'), SENDER.alpha, "the business's own number, not the platform's")
  assert.ok(fetches.some((f) => f.url === `https://api.twilio.com/2010-04-01/Accounts/${SUB.alpha}/Messages.json`), "sent under the business's own subaccount")
  assert.equal(sms.get('To'), '+18435550177')
  assert.ok(threadMsgs(l2).some((m) => m.channel === 'sms' && m.status === 'sent'))
})

test('production test mode: SMS_LIVE off → texts only to MESSAGE_TEST_RECIPIENTS (even with MESSAGES_LIVE on)', async () => {
  await seed('alpha')
  withEmail()
  withTwilio()
  register('alpha', 'approved')
  env.SMS_LIVE = undefined
  env.MESSAGE_TEST_RECIPIENTS = '+18435550111'
  const l = await smsConsentLead()
  await processDueMessages(env, Date.now() + 16 * MIN)
  assert.equal(sentSms().length, 0)
  assert.equal(db.sql.prepare("SELECT error FROM messages WHERE lead_id = ? AND channel = 'sms' AND kind = 'lead_followup_1'").get(l).error, 'test_mode')
  assert.equal(sentEmails().length, 1, 'email still allowed (MESSAGES_LIVE)')
})

// ---------- two-way texts ----------

test('incoming text → assistant answer from verified facts + booking link, sent once; a repeated webhook changes nothing', async () => {
  await seed('alpha')
  withEmail()
  withTwilio()
  withAi()
  register('alpha', 'approved')
  const l = await smsConsentLead()
  const r = await text('(843) 555-0142', 'How much is weekly pool care?', 'SMin1')
  assert.equal(r.status, 200)
  assert.match(r.text, /<Response><\/Response>/)
  const msgs = threadMsgs(l)
  const reply = msgs.find((m) => m.author === 'ai')
  assert.equal(reply.status, 'sent')
  assert.match(reply.body, /^Weekly pool care is \$280\. Pick a time: https:\/\/getshowups\.com\/book\/alpha\?/)
  assert.ok(reply.cost_micros > 0, 'cost recorded (model + text estimate)')
  assert.equal(sentSms().length, 1)
  assert.equal(sentSms()[0].get('StatusCallback').startsWith(`${ORIGIN}/api/sms/twilio/status?m=`), true)
  // Same MessageSid again (Twilio retry): nothing new stored or sent.
  await text('(843) 555-0142', 'How much is weekly pool care?', 'SMin1')
  assert.equal(threadMsgs(l).length, msgs.length)
  assert.equal(sentSms().length, 1)
  assert.equal(thread(l).stage, 'replied')
  // Replied but not booked: one nudge a day later.
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM messages WHERE lead_id = ? AND kind = 'interested_followup'").get(l).n, 2)
})

test('STOP → immediate suppression: nothing more is texted (queued, scheduled or new); START resubscribes; HELP is a fixed answer', async () => {
  await seed('alpha')
  withEmail()
  withTwilio()
  register('alpha', 'approved')
  const l = await smsConsentLead()
  await text(PHONE, 'stop', 'SMs1')
  assert.equal(thread(l).stage, 'opted_out')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM message_optouts WHERE customer = 'alpha' AND channel = 'sms'").get().n, 1)
  assert.ok(db.sql.prepare("SELECT status, error FROM messages WHERE lead_id = ? AND channel = 'sms'").all(l).every((m) => m.status === 'skipped' && m.error === 'opted_out'))
  assert.equal(sentSms().length, 0, 'the provider confirms STOP; we send nothing')
  await processDueMessages(env, Date.now() + 2 * DAY)
  assert.equal(sentSms().length, 0)
  await text(PHONE, 'START', 'SMs2')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM message_optouts WHERE customer = 'alpha'").get().n, 0)
  assert.match(sentSms().at(-1).get('Body'), /subscribed to texts .* Reply STOP to opt out/)
  await text(PHONE, 'HELP', 'SMs3')
  assert.match(sentSms().at(-1).get('Body'), /^alpha Co: .*Call \(843\) 555-0199\..*Reply STOP to opt out\.$/)
  assert.equal(classify('Cancel').kind, 'stop', 'carrier keyword CANCEL is an opt-out')
  assert.equal(classify('I need to cancel my appointment').kind, 'cancel_request')
})

test('human takeover: asking for a person stops the assistant; owner replies go out; handing back resumes answers', async () => {
  await seed('alpha')
  withEmail()
  withTwilio()
  withAi()
  register('alpha', 'approved')
  const l = await smsConsentLead()
  await text(PHONE, 'Can I talk to a real person?', 'SMh1')
  assert.match(sentSms().at(-1).get('Body'), /will reply to you personally/)
  assert.equal(thread(l).needs_owner, 'human_requested')
  const before = sentSms().length
  await text(PHONE, 'Also, what about Saturday?', 'SMh2')
  assert.equal(sentSms().length, before, 'no assistant answer while a person is in charge')
  const owner = await session('owner@alpha.example')
  const r = await call(threadApi, 'POST', '/api/dashboard/followups/thread', { cookie: owner, body: { id: l, action: 'reply', text: 'Hi Jamie, Saturday works. I will text you a time.' } })
  assert.equal(r.status, 200)
  assert.equal(r.json().sent.channel, 'sms')
  assert.equal(sentSms().at(-1).get('Body'), 'Hi Jamie, Saturday works. I will text you a time.')
  await call(threadApi, 'POST', '/api/dashboard/followups/thread', { cookie: owner, body: { id: l, action: 'release' } })
  await text(PHONE, 'How much is weekly pool care?', 'SMh3')
  assert.match(sentSms().at(-1).get('Body'), /\$280/)
})

test('booking stops pending sales follow-ups (nudges, interested follow-up) and the conversation shows booked', async () => {
  await seed('alpha')
  withEmail()
  withTwilio()
  register('alpha', 'approved')
  const lr = (await bookingLead('alpha', { smsConsent: true })).json()
  await text(PHONE, 'Thinking about it', 'SMb1')
  const slot = (await call(bookInfo, 'GET', '/api/book/alpha', { params: { customer: 'alpha' } })).json().slots.find((s) => Date.parse(s) > Date.now() + 3 * DAY)
  assert.equal((await call(bookAppt, 'POST', '/api/book/alpha/appointment', { params: { customer: 'alpha' }, body: { leadId: lr.leadId, leadToken: lr.leadToken, start: slot } })).status, 201)
  assert.equal(thread(lr.leadId).stage, 'booked')
  await processDueMessages(env, Date.now() + 16 * MIN)
  await processDueMessages(env, Date.now() + DAY + 5 * MIN)
  const sales = db.sql.prepare("SELECT kind, status, error FROM messages WHERE lead_id = ? AND kind IN ('lead_followup_1', 'lead_followup_2', 'interested_followup')").all(lr.leadId)
  assert.ok(sales.length >= 4 && sales.every((m) => m.status === 'skipped' && m.error === 'not_needed'), JSON.stringify(sales))
})

test('retries: a temporary failure is retried once later and sent once; an unknown outcome is never resent', async () => {
  await seed('alpha')
  withTwilio()
  register('alpha', 'approved')
  const l = await smsConsentLead()
  let n = 0
  twilio = () => (++n === 1 ? [503, { code: 20503 }] : [201, { sid: `SMr${n}` }])
  await text(PHONE, 'HELP', 'SMr0')
  const help = () => threadMsgs(l).find((m) => m.author === 'system')
  assert.equal(help().status, 'queued')
  await sendQueued(env, Date.now() + 10 * MIN)
  assert.equal(help().status, 'sent')
  assert.equal(sentSms().length, 2)
  await sendQueued(env, Date.now() + 60 * MIN)
  assert.equal(sentSms().length, 2, 'not sent again')
  // A send that died mid-way (status 'sending', outcome unknown) is marked failed, never retried.
  db.sql.prepare("INSERT INTO thread_messages (id, customer, lead_id, direction, channel, author, body, status, attempts, created_at, updated_at) VALUES ('x1', 'alpha', ?, 'out', 'sms', 'owner', 'hi', 'sending', 1, 1, 1)").run(l)
  await sendQueued(env, Date.now())
  assert.deepEqual([threadMsgs(l).find((m) => m.id === 'x1').status, threadMsgs(l).find((m) => m.id === 'x1').error], ['failed', 'interrupted'])
  assert.equal(sentSms().length, 2)
})

test('assistant timeout or an invented price → fixed safe reply with the booking link, the owner is asked to look; no model text sent', async () => {
  await seed('alpha')
  withTwilio()
  withAi()
  register('alpha', 'approved')
  const l = await smsConsentLead()
  ai = () => new Promise(() => {}) // never answers
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...a) => realTimeout(fn, Math.min(ms, 5), ...a)
  try {
    await text(PHONE, 'Do you do green pools?', 'SMt1')
  } finally {
    globalThis.setTimeout = realTimeout
  }
  assert.match(sentSms().at(-1).get('Body'), /^Thanks for your message! alpha Co got it and will reply soon\. If you'd like to book, pick a time here: https:\/\/getshowups\.com\/book\/alpha/)
  assert.equal(thread(l).needs_owner, 'ai_fallback')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'followups.ai_fallback' AND outcome = 'failure'").get().n, 1)
  // Missing fact: the green-pool price isn't recorded; a model that makes one up is never sent.
  ai = () => ({ response: { intent: 'question', answerable: true, reply: 'Green pool cleanup is $99.' }, usage: {} })
  await text(PHONE, 'How much is a green pool cleanup?', 'SMt2')
  assert.doesNotMatch(sentSms().at(-1).get('Body'), /\$99/)
  const biz = { name: 'alpha Co', services: [{ name: 'Weekly pool care', price: '$280' }] }
  assert.equal(checkReply({ intent: 'question', answerable: true, reply: 'It is $99.' }, biz).reason, 'ai_invented_number')
  assert.equal(checkReply({ intent: 'question', answerable: true, reply: 'Weekly pool care is $280.' }, biz).ok, true)
  assert.equal(checkReply({ intent: 'question', answerable: true, reply: 'Weekly pool care is $2,800.' }, biz).reason, 'ai_invented_number')
  assert.equal(checkReply({ intent: 'question', answerable: true, reply: 'We clean 50 pools a week.' }, biz).reason, 'ai_invented_number')
  assert.equal(checkReply({ intent: 'wants_to_book', answerable: true, reply: "You're booked for Tuesday!" }, biz).reason, 'ai_commitment')
  assert.equal(checkReply({ intent: 'question', answerable: true, reply: 'We guarantee results.' }, biz).reason, 'ai_commitment')
  assert.equal(checkReply({ intent: 'question', answerable: false, reply: 'Let me check.' }, biz).reason, 'ai_unsure')
  assert.equal(checkReply({ intent: 'question', answerable: true, reply: 'See www.x.com' }, biz).reason, 'ai_link')
})

test('assistant off (FOLLOWUP_AI unset): every question gets the fixed reply and the owner is asked; no model call', async () => {
  await seed('alpha')
  withTwilio()
  register('alpha', 'approved')
  let calls = 0
  env.AI = { run: async () => (calls++, {}) }
  const l = await smsConsentLead()
  await text(PHONE, 'Price?', 'SMo1')
  assert.equal(calls, 0)
  assert.equal(thread(l).needs_owner, 'needs_reply')
  assert.match(sentSms().at(-1).get('Body'), /^Thanks for your message!/)
})

// ---------- limits, quiet hours, pause, kill switch ----------

test('quiet hours: automatic texts wait for morning; a direct answer to their text may go out', async () => {
  const s = { quietStart: 21, quietEnd: 8 }
  assert.equal(inQuietHours(Date.UTC(2026, 0, 5, 22), 'UTC', s), true)
  assert.equal(inQuietHours(Date.UTC(2026, 0, 5, 7), 'UTC', s), true)
  assert.equal(inQuietHours(Date.UTC(2026, 0, 5, 12), 'UTC', s), false)
  await seed('alpha')
  withEmail()
  withTwilio()
  register('alpha', 'approved', { quiet: true })
  db.sql.prepare('INSERT INTO followup_settings (customer, quiet_start, quiet_end, updated_at) VALUES (?, 21, 8, 1)').run('alpha')
  const l = await smsConsentLead()
  const night = Date.UTC(2030, 0, 7, 23)
  db.sql.prepare("UPDATE messages SET send_at = ?, created_at = ? WHERE lead_id = ? AND kind = 'lead_followup_1'").run(night, night, l)
  await processDueMessages(env, night + MIN)
  const m = db.sql.prepare("SELECT status, error, send_at FROM messages WHERE lead_id = ? AND kind = 'lead_followup_1' AND channel = 'sms'").get(l)
  assert.equal(m.status, 'scheduled')
  assert.equal(new Date(m.send_at).getUTCHours(), 8, 'moved to the end of quiet hours')
  assert.equal(sentSms().length, 0)
  // A text that can't go out at all is skipped at night with its real reason, never postponed to the next morning.
  db.sql.prepare("UPDATE sms_registrations SET status = 'pending' WHERE customer = 'alpha'").run()
  db.sql.prepare("UPDATE messages SET status = 'scheduled', error = NULL, send_at = ?, created_at = ? WHERE lead_id = ? AND kind = 'lead_followup_2' AND channel = 'sms'").run(night, night, l)
  await processDueMessages(env, night + 2 * MIN)
  const blocked = db.sql.prepare("SELECT status, error FROM messages WHERE lead_id = ? AND kind = 'lead_followup_2' AND channel = 'sms'").get(l)
  assert.deepEqual({ ...blocked }, { status: 'skipped', error: 'sms_not_ready' })
  db.sql.prepare("UPDATE sms_registrations SET status = 'approved' WHERE customer = 'alpha'").run()
  // Direct answer (HELP) at night is allowed within 30 minutes of their message.
  await handleInbound(env, { from: PHONE, to: SENDER.alpha, body: 'HELP', providerId: 'SMq1' }, night)
  await sendQueued(env, night + MIN)
  assert.equal(sentSms().length, 1)
})

test('limits: the assistant answers one person at most 6 times a day, then hands over; automatic texts per person are capped', async () => {
  await seed('alpha')
  withTwilio()
  withAi()
  register('alpha', 'approved')
  const l = await smsConsentLead()
  for (let i = 0; i < 8; i++) await text(PHONE, `Question number ${i}?`, `SMl${i}`)
  assert.equal(threadMsgs(l).filter((m) => m.author === 'ai').length, 6)
  assert.equal(thread(l).needs_owner, 'ai_limit')
})

test('owner pause, takeover, platform kill switch and inactive businesses stop automatic messages', async () => {
  await seed('alpha')
  withEmail()
  withTwilio()
  withAi()
  register('alpha', 'approved')
  const owner = await session('owner@alpha.example')
  const l = await smsConsentLead()
  assert.equal((await call(followupsApi, 'POST', '/api/dashboard/followups', { cookie: owner, body: { action: 'automations', enabled: false } })).status, 200)
  await processDueMessages(env, Date.now() + 16 * MIN)
  assert.equal(sentEmails().length + sentSms().length, 0)
  await text(PHONE, 'Price?', 'SMp1')
  assert.equal(threadMsgs(l).filter((m) => m.direction === 'out').length, 0, 'paused: no assistant or fixed answer is even queued')
  assert.equal(thread(l).needs_owner, 'needs_reply', 'the owner is asked to answer')
  await call(followupsApi, 'POST', '/api/dashboard/followups', { cookie: owner, body: { action: 'automations', enabled: true } })
  env.MESSAGING_KILL_SWITCH = 'true'
  await text(PHONE, 'HELP', 'SMp2')
  await processDueMessages(env, Date.now() + 2 * DAY)
  assert.equal(sentEmails().length + sentSms().length, 0, 'kill switch: nothing at all')
  assert.ok(threadMsgs(l).filter((m) => m.direction === 'out').every((m) => m.status === 'skipped'))
  env.MESSAGING_KILL_SWITCH = undefined
  db.sql.prepare("UPDATE customers SET status = 'suspended' WHERE id = 'alpha'").run()
  await text(PHONE, 'HELP', 'SMp3')
  assert.equal(sentSms().length, 0)
})

// ---------- webhooks ----------

test('webhooks: unsigned or wrongly signed requests are refused and record nothing; delivery updates move forward only', async () => {
  await seed('alpha')
  withTwilio()
  register('alpha', 'approved')
  const l = await smsConsentLead()
  const bad = await inbound({ From: PHONE, To: SENDER.alpha, Body: 'hi', MessageSid: 'SMx' }, { sign: false })
  assert.equal(bad.status, 403)
  assert.equal(threadMsgs(l).length, 0)
  await text(PHONE, 'HELP', 'SMd1')
  const sent = threadMsgs(l).find((m) => m.direction === 'out')
  const cb = new URL(sentSms()[0].get('StatusCallback'))
  const path = `${cb.pathname}${cb.search}`
  assert.equal((await inbound({ MessageSid: 'SM1', MessageStatus: 'delivered' }, { path })).status, 204)
  assert.equal(threadMsgs(l).find((m) => m.id === sent.id).status, 'delivered')
  await inbound({ MessageSid: 'SM1', MessageStatus: 'sent' }, { path })
  assert.equal(threadMsgs(l).find((m) => m.id === sent.id).status, 'delivered', 'no going back')
  assert.equal((await inbound({ MessageSid: 'SM1', MessageStatus: 'failed' }, { path: path.replace(/\.[^.]+$/, '.forged') })).status, 403)
  // A number that unsubscribed at the carrier (21610) is recorded as opted out.
  await text(PHONE, 'HELP', 'SMd2')
  const cb2 = new URL(sentSms()[1].get('StatusCallback'))
  await inbound({ MessageSid: 'SM2', MessageStatus: 'undelivered', ErrorCode: '21610' }, { path: `${cb2.pathname}${cb2.search}` })
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM message_optouts WHERE customer = 'alpha'").get().n, 1)
})

test('a text from an unknown number starts a conversation (source sms); its sender may be answered, no follow-ups are scheduled', async () => {
  await seed('alpha')
  withTwilio()
  register('alpha', 'approved')
  await text('+18435550999', 'HELP', 'SMu1')
  const t = db.sql.prepare("SELECT * FROM lead_threads WHERE source = 'sms'").get()
  assert.ok(t)
  assert.equal(sentSms().length, 1)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM messages WHERE lead_id = ?').get(t.lead_id).n, 0)
})

// ---------- tenant isolation ----------

test('tenant isolation: texts route only to the business that owns the sender; owners see and act only on their own conversations', async () => {
  await seed('alpha')
  await seed('beta')
  withEmail()
  withTwilio()
  register('alpha', 'approved')
  register('beta', 'approved')
  const la = await smsConsentLead('alpha')
  await text(PHONE, 'hello alpha', 'SMi1', SENDER.alpha)
  await text(PHONE, 'hello beta', 'SMi2', SENDER.beta)
  assert.deepEqual(threadMsgs(la).filter((m) => m.direction === 'in').map((m) => m.body), ['hello alpha'])
  const beta = db.sql.prepare("SELECT lead_id FROM lead_threads WHERE customer = 'beta'").get().lead_id
  assert.notEqual(beta, la)
  const ownerB = await session('owner@beta.example')
  assert.equal((await call(threadApi, 'GET', `/api/dashboard/followups/thread?id=${la}`, { cookie: ownerB })).status, 404)
  assert.equal((await call(threadApi, 'POST', '/api/dashboard/followups/thread', { cookie: ownerB, body: { id: la, action: 'reply', text: 'hi' } })).status, 404)
  assert.equal((await call(threadApi, 'POST', '/api/dashboard/followups/thread', { cookie: ownerB, body: { id: la, action: 'takeover' } })).status, 404)
  const list = (await call(followupsApi, 'GET', '/api/dashboard/followups', { cookie: ownerB })).json()
  assert.deepEqual(list.threads.map((t) => t.id), [beta])
  assert.ok(!JSON.stringify(list).includes('hello alpha'))
  // Cross-site writes refused; the platform view is admin-only and has no personal data.
  assert.equal((await call(threadApi, 'POST', '/api/dashboard/followups/thread', { cookie: ownerB, origin: 'https://evil.example', body: { id: beta, action: 'takeover' } })).status, 403)
  assert.equal((await call(platformApi, 'GET', '/api/platform/messaging', { cookie: ownerB })).status, 403)
  const admin = await session('staff@getshowups.com')
  const ops = await call(platformApi, 'GET', '/api/platform/messaging', { cookie: admin })
  assert.equal(ops.status, 200)
  assert.ok(!/hello|jamie|555-0142|example\.net/i.test(ops.text), 'counts only')
})

// ---------- registration ----------

test('texting registration: owner details validated, explicit approval required; only a platform admin records the provider status, never before the owner approved', async () => {
  await seed('alpha')
  const owner = await session('owner@alpha.example')
  const admin = await session('staff@getshowups.com')
  const details = { legalName: 'Alpha Pools LLC', businessType: 'llc', ein: '12-3456789', street: '1 King St', city: 'Charleston', region: 'sc', postalCode: '29401', website: 'alphapools.example.com', firstName: 'Pat', lastName: 'Alpha', repTitle: 'Owner', repJobPosition: 'CEO', industry: 'PROFESSIONAL', contactEmail: 'pat@alpha.example', contactPhone: '843-555-0123' }
  assert.deepEqual(validateFacts({ ...details, ein: '', website: 'localhost' })[0], ['ein', 'website'])
  assert.deepEqual(validateFacts({ ...details, region: 'XX', postalCode: '123', industry: 'GAMBLING', repJobPosition: 'Boss' })[0], ['region', 'postalCode', 'repJobPosition', 'industry'])
  // The registration path follows the business type: an LLC (it has an EIN) is never registered as a sole proprietor.
  assert.equal(validateFacts(details)[1].path, 'low_volume_standard')
  const soleFacts = validateFacts({ ...details, businessType: 'sole_proprietor', ein: '99-9999999', repTitle: '', repJobPosition: '' })
  assert.deepEqual([soleFacts[0], soleFacts[1].path, soleFacts[1].ein], [[], 'sole_proprietor', ''])
  assert.equal(validateFacts(details)[1].address, '1 King St, Charleston, SC 29401')
  const save = await call(textingApi, 'POST', '/api/dashboard/followups/texting', { cookie: owner, body: { action: 'save', details } })
  assert.equal(save.status, 200)
  assert.deepEqual([save.json().texting.status, save.json().texting.next], ['ready', 'approve'])
  assert.equal(save.json().texting.facts.ein, '•••6789')
  // Admin can't mark it pending/approved before the owner approved submission.
  assert.equal((await call(platformApi, 'POST', '/api/platform/messaging', { cookie: admin, body: { customer: 'alpha', status: 'approved', confirm: true } })).json().error, 'owner_approval_missing')
  assert.equal((await call(textingApi, 'POST', '/api/dashboard/followups/texting', { cookie: owner, body: { action: 'approve' } })).json().error, 'confirmation_required')
  assert.equal((await call(textingApi, 'POST', '/api/dashboard/followups/texting', { cookie: owner, body: { action: 'approve', confirm: true } })).json().texting.next, 'waiting_for_submission')
  // Owners have no way to set a status.
  assert.equal((await call(platformApi, 'POST', '/api/platform/messaging', { cookie: owner, body: { customer: 'alpha', status: 'approved', confirm: true } })).status, 403)
  assert.equal((await call(platformApi, 'POST', '/api/platform/messaging', { cookie: admin, body: { customer: 'alpha', status: 'pending', confirm: true } })).status, 200)
  assert.equal((await call(textingApi, 'POST', '/api/dashboard/followups/texting', { cookie: owner, body: { action: 'save', details } })).json().error, 'registration_in_progress')
  await call(platformApi, 'POST', '/api/platform/messaging', { cookie: admin, body: { customer: 'alpha', status: 'rejected', note: 'Website must show texting terms', confirm: true } })
  const view = (await call(followupsApi, 'GET', '/api/dashboard/followups', { cookie: owner })).json().texting
  assert.deepEqual([view.status, view.next, view.note], ['rejected', 'fix_and_resubmit', 'Website must show texting terms'])
  assert.equal((await call(platformApi, 'POST', '/api/platform/messaging', { cookie: admin, body: { customer: 'alpha', messagingService: 'nope', confirm: true } })).json().error, 'invalid_messaging_service')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM audit_log WHERE action LIKE 'sms.registration%'").get().n, 3)
  const terms = await call(termsPage, 'GET', '/sms-terms/alpha', { params: { customer: 'alpha' } })
  assert.equal(terms.status, 200)
  assert.match(terms.text, /Reply <strong>STOP<\/strong>/)
  assert.match(terms.text, /not shared with or sold to third parties/)
  assert.doesNotMatch(terms.text, /<script/i)
  // Opt-in evidence carriers can open without signing in: both boxes, unchecked and inactive, with their exact wording.
  assert.equal((terms.text.match(/<input type="checkbox" disabled>/g) || []).length, 2)
  assert.doesNotMatch(terms.text, /<input[^>]*\schecked/)
  assert.match(terms.text, /Text me about this appointment \(confirmation and reminders\) from alpha Co via GetShowUps\. Message frequency varies\. Msg &amp; data rates may apply\. Reply STOP to opt out, HELP for help\. Not required to book\./)
  assert.match(terms.text, /Text me about my request from alpha Co via GetShowUps\./)
  // The owner sees the exact description, opt-in flow and samples carriers will see (real links, [variables]).
  assert.match(view.messageFlow, /https:\/\/getshowups\.com\/book\/alpha/)
  assert.match(view.messageFlow, /sms-terms\/alpha/)
  assert.ok(view.samples.length >= 2 && view.samples.every((x) => x.startsWith('alpha Co:') && /Reply STOP/.test(x)))
  assert.ok(view.samples.every((x) => !x.includes('…')), 'no placeholder ellipses')
})

test('Twilio already answered a keyword (OptOutType): its verdict wins and we never send a second answer', async () => {
  await seed('alpha')
  withTwilio()
  register('alpha', 'approved')
  const l = await smsConsentLead()
  await inbound({ From: PHONE, To: SENDER.alpha, Body: 'info', MessageSid: 'SMk1', OptOutType: 'HELP' })
  await inbound({ From: PHONE, To: SENDER.alpha, Body: 'arret', MessageSid: 'SMk2', OptOutType: 'STOP' })
  assert.equal(thread(l).stage, 'opted_out', "a keyword only Twilio knows still stops everything here")
  await inbound({ From: PHONE, To: SENDER.alpha, Body: 'unstop', MessageSid: 'SMk3', OptOutType: 'START' })
  await sendQueued(env, Date.now() + MIN)
  assert.equal(threadMsgs(l).filter((m) => m.direction === 'out').length, 0, 'no duplicate HELP/START reply')
  assert.equal(sentSms().length, 0)
  // Without OptOutType (provider left the keyword to us) our fixed HELP answer goes out once.
  await text(PHONE, 'HELP', 'SMk4')
  await sendQueued(env, Date.now() + MIN)
  assert.equal(sentSms().length, 1)
})

// ---------- before the migration ----------

test('before migration 0024: Follow-ups reports not ready and every existing flow keeps working (leads, booking, emails)', async () => {
  db = d1({ skip: ['0024'] })
  env.ONBOARDING_DB = db
  await seed('alpha')
  withEmail()
  const owner = await session('owner@alpha.example')
  assert.deepEqual((await call(followupsApi, 'GET', '/api/dashboard/followups', { cookie: owner })).json(), { ready: false })
  const l = (await bookingLead('alpha')).json()
  assert.equal(l.qualified, true)
  assert.equal((await processDueMessages(env, Date.now() + 16 * MIN)).sent, 1)
  // Website-form leads keep the previous schedule until the migration (no new instant acknowledgment yet).
  const f = await formLead('alpha', { email: 'form@example.net' })
  assert.deepEqual(db.sql.prepare('SELECT kind FROM messages WHERE lead_id = ? ORDER BY send_at').all(f.leadId).map((m) => m.kind), ['lead_followup_1', 'lead_followup_2'])
  assert.equal((await processReplies(env)).answered, 0)
  assert.equal(segmentsOf('a'.repeat(161)), 2)
})
