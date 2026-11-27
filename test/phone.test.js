// Business phone lines (server/telephony/, migration 0049): routing plan, signed Twilio webhooks (tenant isolation by
// subaccount), idempotency, screening, fallbacks (AI receptionist over Retell SIP, or a callback task), loop and toll-fraud
// guards, limits, destination verification, number purchase gates, owner route, assistant tool, retention, deletion.
// Twilio and Retell are mocked; no real network, no paid calls.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { twilioSignature } from '../server/followups/transport.js'
import { sealToken } from '../server/followups/twilio.js'
import { ERASED_TABLES } from '../server/deletion.js'
import { callerOf, matchCaller, planCall, purgeOldCalls, CALL_RETENTION_MS } from '../server/telephony/calls.js'
import { destinationNumber, phoneSetup, resetReadyCache, usage } from '../server/telephony/lines.js'
import { runTool, toolContext } from '../server/operator-tools.js'
import { setupCheck } from '../server/setup-check.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import * as hook from '../functions/api/phone/twilio/[step].js'
import * as phoneApi from '../functions/api/dashboard/phone.js'

const ORIGIN = 'https://getshowups.com'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const DAY = 864e5
const SUB = { alpha: `AC${'a'.repeat(32)}`, beta: `AC${'b'.repeat(32)}` }
const SUB_TOKEN = { alpha: 'sub_alpha_SECRET_token_1234', beta: 'sub_beta_SECRET_token_5678' }
const SEALED = { alpha: await sealToken({ TOKEN_ENCRYPTION_KEY: KEY }, 'alpha', SUB.alpha, SUB_TOKEN.alpha), beta: await sealToken({ TOKEN_ENCRYPTION_KEY: KEY }, 'beta', SUB.beta, SUB_TOKEN.beta) }
const LINE = { alpha: '+18435550100', beta: '+18435550200' }
const CELL = '+18435550111'
const CALLER = '+18435550142'
const SECRETS = ['tw_SECRET', SUB_TOKEN.alpha, SUB_TOKEN.beta, 'key_RETELL_SECRET', KEY]
const sid = (n) => `CA${String(n).padStart(32, '0')}`

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

let env, db, fetches, retell, twilioApi, origFetch, origError, logs, responses
function seed(id, { line = true, verified = true } = {}) {
  const t = Date.now()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '00:00', '23:59', '0,1,2,3,4,5,6', ?, ?, ?)").run(id, `${id} Pools LLC`, t, t, t)
  db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, ?)').run(`owner@${id}.example`, id, t)
  db.sql.prepare("INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES (?, '', 'pool', '', '[]', '[]', ?)").run(id, t)
  db.sql.prepare("INSERT INTO sms_accounts (customer, account_sid, auth_token_enc, status, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, 1)").run(id, SUB[id], SEALED[id])
  if (line) db.sql.prepare("INSERT INTO phone_lines (id, customer, number, provider_sid, account_sid, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'website', 'active', 1, 1)").run(`pl_${id}`, id, LINE[id], `PN${'1'.repeat(32)}`, SUB[id])
  if (verified) db.sql.prepare('INSERT INTO phone_destinations (id, customer, number, label, verified_at, created_at) VALUES (?, ?, ?, ?, 1, 1)').run(`pd_${id}`, id, id === 'alpha' ? CELL : '+18435550222', 'Owner')
}

beforeEach(() => {
  resetReadyCache()
  db = d1()
  fetches = []
  responses = []
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, ADMIN_API_TOKEN: 'a'.repeat(40), TOKEN_ENCRYPTION_KEY: KEY, ONBOARDING_DB: db, TWILIO_ACCOUNT_SID: `AC${'f'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'tw_SECRET', PHONE_ENABLED: 'true', GOOGLE_TOKENS: { get: async () => null } }
  retell = () => [201, { call_id: 'call_ai_0001', call_status: 'registered' }]
  twilioApi = (u) => (u.endsWith('/Calls.json') ? [201, { sid: sid(900) }] : null)
  origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetches.push({ url: u, init })
    let out
    if (u === 'https://api.retellai.com/v2/register-phone-call') out = retell(JSON.parse(init.body))
    else if (u.startsWith('http://127.0.0.1:9/2010-04-01/') || u.startsWith('https://api.twilio.com/2010-04-01/')) out = twilioApi(u, init)
    if (!out) throw new Error(`unexpected ${u}`)
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
  assert.ok(!logs.join('\n').includes(CALLER), 'caller number in logs')
})

async function post(step, fields, { biz = 'alpha', sign = true, query = '', token } = {}) {
  const path = `/api/phone/twilio/${step}${query}`
  const p = new URLSearchParams({ AccountSid: SUB[biz] || biz, ...fields })
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.9' }
  if (sign) headers['X-Twilio-Signature'] = await twilioSignature(token || SUB_TOKEN[biz] || 'x', ORIGIN + path, p)
  const res = await hook.onRequestPost({ request: new Request(ORIGIN + path, { method: 'POST', headers, body: p.toString() }), env, params: { step } })
  const text = await res.text()
  responses.push(text)
  return { status: res.status, text }
}
const ring = (n, extra = {}, biz = 'alpha') => post('voice', { CallSid: sid(n), From: CALLER, To: LINE[biz], ...extra }, { biz })
const callRow = (n) => db.sql.prepare('SELECT * FROM phone_calls WHERE call_sid = ?').get(sid(n))
const requests = () => db.sql.prepare('SELECT * FROM receptionist_requests').all()

async function owner(id) {
  const token = `tok_${id}`.padEnd(43, 'Q')
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), `owner@${id}.example`, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function api(method, cookie, body) {
  const headers = { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.9', ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}) }
  const res = await phoneApi[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(`${ORIGIN}/api/dashboard/phone`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env })
  const text = await res.text()
  responses.push(text)
  return { status: res.status, data: JSON.parse(text) }
}

// ---------- pure rules ----------
test('plan: team first with verified phones; skipped when asked, after hours, already-missed forwarding, nobody verified; limits win', () => {
  const settings = { answer: 'team', ringSeconds: 20, fallback: 'ai', afterHours: 'fallback' }
  const line = { forward_mode: 'none' }
  const v = [{ number: CELL }]
  assert.deepEqual(planCall({ settings, line, verified: v, open: true, aiOk: true, limited: false }), { route: 'team', fallback: 'ai', ring: [CELL], ringSeconds: 20 })
  assert.equal(planCall({ settings, line, verified: v, open: false, aiOk: true }).route, 'fallback')
  assert.equal(planCall({ settings: { ...settings, afterHours: 'same' }, line, verified: v, open: false, aiOk: true }).route, 'team')
  assert.equal(planCall({ settings, line: { forward_mode: 'no_answer' }, verified: v, open: true, aiOk: true }).route, 'fallback')
  assert.equal(planCall({ settings, line, verified: [], open: true, aiOk: true }).route, 'fallback')
  assert.equal(planCall({ settings: { ...settings, answer: 'fallback' }, line, verified: v, open: true, aiOk: true }).route, 'fallback')
  // AI chosen but not available → callback, never a silent AI promise.
  assert.equal(planCall({ settings, line, verified: [], open: true, aiOk: false }).fallback, 'callback')
  assert.deepEqual(planCall({ settings, line, verified: v, open: true, aiOk: true, limited: true }), { route: 'limited', fallback: 'callback', ring: [], ringSeconds: 0 })
})

test('caller id: withheld and malformed numbers are never stored as a number', () => {
  assert.deepEqual(callerOf('+18435550142'), { caller: '+18435550142', state: 'known' })
  for (const w of ['+266696687', 'anonymous', 'Restricted', '+86282452253', '']) assert.equal(callerOf(w).state, 'withheld')
  assert.deepEqual(callerOf('8435550142'), { caller: null, state: 'unknown' })
})

test('destinations: US only; premium-rate, N11 and malformed numbers refused (toll fraud)', () => {
  assert.equal(destinationNumber('(843) 555-0111'), '+18435550111')
  for (const bad of ['+19005550111', '+19765550111', '+18434115555', '+447700900123', '555-0111', '+10005550111']) assert.equal(destinationNumber(bad), null, bad)
})

// ---------- webhooks ----------
test('webhook auth: unsigned, wrong signature and parent-account requests are refused and route nowhere', async () => {
  seed('alpha')
  assert.equal((await post('voice', { CallSid: sid(1), From: CALLER, To: LINE.alpha }, { sign: false })).status, 403)
  assert.equal((await post('voice', { CallSid: sid(1), From: CALLER, To: LINE.alpha }, { token: 'wrong' })).status, 403)
  assert.equal((await post('voice', { CallSid: sid(1), From: CALLER, To: LINE.alpha }, { biz: env.TWILIO_ACCOUNT_SID, token: 'tw_SECRET' })).status, 403)
  assert.equal(callRow(1), undefined)
})

test('tenant isolation: a number is answered only for the business whose subaccount signed the call', async () => {
  seed('alpha')
  seed('beta')
  const r = await post('voice', { CallSid: sid(2), From: CALLER, To: LINE.alpha }, { biz: 'beta' })
  assert.match(r.text, /not in service/)
  assert.equal(callRow(2), undefined)
  // A call of alpha's can't be continued by beta's subaccount either.
  await ring(3)
  const d = await post('dial', { CallSid: sid(3), DialCallStatus: 'no-answer' }, { biz: 'beta', query: `?c=${sid(3)}` })
  assert.match(d.text, /<Hangup\/>/)
  assert.equal(requests().length, 0)
})

test('incoming call rings verified phones with screening; repeat webhook is idempotent; never records', async () => {
  seed('alpha')
  db.sql.prepare("INSERT INTO phone_destinations (id, customer, number, label, created_at) VALUES ('pd_unverified', 'alpha', '+18435550333', '', 1)").run()
  const r = await ring(4)
  assert.equal(r.status, 200)
  assert.match(r.text, /<Dial timeout="20" action="https:\/\/getshowups\.com\/api\/phone\/twilio\/dial\?c=CA0+4" method="POST" answerOnBridge="true">/)
  assert.match(r.text, /<Number url="https:\/\/getshowups\.com\/api\/phone\/twilio\/screen\?c=CA0+4" method="POST">\+18435550111<\/Number>/)
  assert.ok(!r.text.includes('+18435550333'), 'unverified number never rung')
  assert.ok(!/record/i.test(r.text), 'no recording')
  await ring(4)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM phone_calls').get().n, 1)
  assert.equal(callRow(4).route, 'team')
  assert.equal(callRow(4).source, 'website')
})

test('screening: only pressing 1 connects; anything else hangs up that leg (voicemail never counts as answered)', async () => {
  seed('alpha')
  await ring(5)
  const prompt = await post('screen', {}, { query: `?c=${sid(5)}` })
  assert.match(prompt.text, /<Gather input="dtmf" numDigits="1"/)
  assert.match(prompt.text, /Press 1 to answer/)
  assert.equal((await post('screen', { Digits: '1' }, { query: `?c=${sid(5)}&r=1` })).text.includes('<Hangup/>'), false)
  assert.match((await post('screen', { Digits: '' }, { query: `?c=${sid(5)}&r=1` })).text, /<Hangup\/>/)
})

test('answered by the team: outcome answered; a later status keeps it and records the length', async () => {
  seed('alpha')
  await ring(6)
  await post('dial', { CallSid: sid(6), DialCallStatus: 'completed', DialBridged: 'true' }, { query: `?c=${sid(6)}` })
  await post('status', { CallSid: sid(6), CallStatus: 'completed', CallDuration: '95' })
  const c = callRow(6)
  assert.equal(c.outcome, 'answered')
  assert.equal(c.duration_seconds, 95)
  assert.equal(requests().length, 0)
})

test('nobody answers, fallback callback: polite message, one callback task in Needs attention; repeats add nothing', async () => {
  seed('alpha')
  await ring(7)
  const r = await post('dial', { CallSid: sid(7), DialCallStatus: 'no-answer' }, { query: `?c=${sid(7)}` })
  assert.match(r.text, /Your number has been saved so they can call you back/)
  assert.ok(!/notified|will call you (at|in|by)/i.test(r.text), 'no promise beyond what happened')
  await post('dial', { CallSid: sid(7), DialCallStatus: 'no-answer' }, { query: `?c=${sid(7)}` })
  await post('status', { CallSid: sid(7), CallStatus: 'completed', CallDuration: '30' })
  const rq = requests()
  assert.equal(rq.length, 1)
  assert.deepEqual([rq[0].kind, rq[0].phone, rq[0].status, rq[0].customer], ['callback', CALLER, 'open', 'alpha'])
  assert.equal(callRow(7).outcome, 'callback')
  assert.equal(callRow(7).request_id, rq[0].id)
})

test('team answered with voicemail but no key press (not bridged) still goes to the fallback', async () => {
  seed('alpha')
  await ring(8)
  const r = await post('dial', { CallSid: sid(8), DialCallStatus: 'completed', DialBridged: 'false' }, { query: `?c=${sid(8)}` })
  assert.match(r.text, /call you back/)
  assert.equal(callRow(8).outcome, 'callback')
})

test('hidden caller: no callback task (nothing to call), told so; team phone shows the business line', async () => {
  seed('alpha')
  const r = await ring(9, { From: '+266696687' })
  assert.match(r.text, /callerId="\+18435550100"/)
  const d = await post('dial', { CallSid: sid(9), DialCallStatus: 'no-answer' }, { query: `?c=${sid(9)}` })
  assert.match(d.text, /your number was hidden/)
  assert.equal(requests().length, 0)
  assert.deepEqual([callRow(9).caller, callRow(9).caller_state, callRow(9).outcome], [null, 'withheld', 'missed'])
})

test('caller hangs up while ringing: the status callback makes it a missed call with a callback task', async () => {
  seed('alpha')
  await ring(10)
  await post('status', { CallSid: sid(10), CallStatus: 'completed', CallDuration: '12' })
  assert.equal(callRow(10).outcome, 'missed')
  assert.equal(requests().length, 1)
})

test('AI fallback: registers a Retell phone call, dials its SIP address, routes the call id to the business', async () => {
  seed('alpha')
  Object.assign(env, { RETELL_API_KEY: 'key_RETELL_SECRET', RETELL_AGENT_ID: 'agent_abcdef123', RETELL_WS_SECRET: 's'.repeat(40), RECEPTIONIST_VOICE_BUSINESSES: 'alpha' })
  db.sql.prepare("INSERT INTO receptionist_settings (customer, enabled, mode, greeting, knowledge, updated_at) VALUES ('alpha', 1, 'ai_first', '', '', 1)").run()
  db.sql.prepare("INSERT INTO phone_settings (customer, answer, ring_seconds, fallback, after_hours, screen, version, updated_at) VALUES ('alpha', 'team', 20, 'ai', 'same', 1, 1, 1)").run()
  await ring(11)
  const r = await post('dial', { CallSid: sid(11), DialCallStatus: 'no-answer' }, { query: `?c=${sid(11)}` })
  assert.match(r.text, /<Sip>sip:call_ai_0001@sip\.retellai\.com<\/Sip>/)
  const reg = JSON.parse(fetches.find((f) => f.url.endsWith('/v2/register-phone-call')).init.body)
  assert.deepEqual([reg.agent_id, reg.direction, reg.to_number, reg.metadata.business], ['agent_abcdef123', 'inbound', LINE.alpha, 'alpha'])
  assert.deepEqual(reg.agent_override, { agent: { max_call_duration_ms: 900_000 } }, 'Retell ends the AI leg at 15 minutes')
  const rc = db.sql.prepare("SELECT * FROM receptionist_calls WHERE call_id = 'call_ai_0001'").get()
  assert.equal(rc.customer, 'alpha')
  assert.equal(callRow(11).conversation_id, rc.conversation_id)
  await post('ai', { CallSid: sid(11), DialCallStatus: 'completed' }, { query: `?c=${sid(11)}` })
  assert.equal(callRow(11).outcome, 'ai')
  assert.equal(requests().length, 0)
})

test('AI fallback unavailable (Retell refuses): the caller still gets the callback path, the failure is an event', async () => {
  seed('alpha')
  Object.assign(env, { RETELL_API_KEY: 'key_RETELL_SECRET', RETELL_AGENT_ID: 'agent_abcdef123', RETELL_WS_SECRET: 's'.repeat(40), RECEPTIONIST_VOICE_BUSINESSES: 'alpha' })
  db.sql.prepare("INSERT INTO receptionist_settings (customer, enabled, mode, greeting, knowledge, updated_at) VALUES ('alpha', 1, 'ai_first', '', '', 1)").run()
  db.sql.prepare("INSERT INTO phone_settings (customer, answer, ring_seconds, fallback, after_hours, screen, version, updated_at) VALUES ('alpha', 'fallback', 20, 'ai', 'same', 1, 1, 1)").run()
  retell = () => [402, { error: 'billing' }]
  const r = await ring(12)
  assert.match(r.text, /call you back/)
  assert.equal(requests().length, 1)
  const ev = db.sql.prepare("SELECT outcome, details FROM audit_log WHERE action = 'phone.ai_unavailable'").get()
  assert.equal(ev.outcome, 'failure')
  assert.equal(JSON.parse(ev.details).reason, 'ai_billing')
})

test('loops: a call forwarded back from a team phone, or from one of our own lines, is rejected', async () => {
  seed('alpha')
  assert.match((await ring(13, { ForwardedFrom: CELL })).text, /<Reject reason="busy"\/>/)
  assert.match((await ring(14, { From: LINE.alpha })).text, /<Reject/)
  assert.equal(callRow(13), undefined)
})

test('limits: calls at once and minutes per day go straight to the callback message, no ringing, no AI', async () => {
  seed('alpha')
  env.PHONE_CONCURRENT = '1'
  await ring(15)
  const r = await ring(16)
  assert.ok(!r.text.includes('<Dial'))
  assert.equal(callRow(16).route, 'limited')
  env.PHONE_CONCURRENT = '5'
  env.PHONE_DAILY_MINUTES = '1'
  db.sql.prepare('UPDATE phone_calls SET duration_seconds = 61, ended_at = 1').run()
  assert.ok(!(await ring(17)).text.includes('<Dial'))
})

test('line switched off: a polite message, nothing rung, recorded as off', async () => {
  seed('alpha')
  env.PHONE_ENABLED = 'false'
  const r = await ring(18)
  assert.match(r.text, /can&apos;t take calls on this line right now/)
  assert.ok(!r.text.includes('<Dial'))
  assert.equal(callRow(18).outcome, 'off')
})

test('matching: one person with that number is linked; a number shared by different people is not', async () => {
  seed('alpha')
  const lead = (id, name, phone) => db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES (?, 'alpha', ?, 'x@example.net', ?, 'pool', 'new', 'h', 1, 1)").run(id, name, phone)
  lead('l1', 'Jamie Rivera', '(843) 555-0142')
  lead('l2', 'Jamie Rivera', '843-555-0142')
  assert.deepEqual(await matchCaller(db, 'alpha', CALLER), { match: 'single', leadId: 'l2' })
  lead('l3', 'Sam Rivera', '8435550142')
  assert.deepEqual(await matchCaller(db, 'alpha', CALLER), { match: 'ambiguous', leadId: null })
  assert.deepEqual(await matchCaller(db, 'alpha', null), { match: 'none', leadId: null })
})

// ---------- verification ----------
test('verification: the owner gets a code, Twilio calls the phone, only the right digits (3 tries) verify it', async () => {
  seed('alpha', { verified: false })
  const cookie = await owner('alpha')
  const add = await api('POST', cookie, { action: 'add_destination', number: '(843) 555-0144', label: 'Cell' })
  assert.equal(add.status, 200)
  const id = add.data.id
  const v = await api('POST', cookie, { action: 'verify_destination', id })
  assert.equal(v.status, 200)
  assert.match(v.data.code, /^\d{4}$/)
  const placed = fetches.find((f) => f.url === `https://api.twilio.com/2010-04-01/Accounts/${SUB.alpha}/Calls.json`)
  const form = new URLSearchParams(placed.init.body)
  assert.deepEqual([form.get('To'), form.get('From')], ['+18435550144', LINE.alpha])
  assert.ok(!String(placed.init.body).includes(v.data.code), 'the code is never sent to the provider')
  // Another business's subaccount can't verify it.
  seed('beta', { verified: false })
  await post('verify', { Digits: v.data.code }, { biz: 'beta', query: `?d=${id}&r=1` })
  assert.equal(db.sql.prepare('SELECT verified_at FROM phone_destinations WHERE id = ?').get(id).verified_at, null)
  const wrong = v.data.code === '0000' ? '1111' : '0000'
  assert.match((await post('verify', { Digits: wrong }, { query: `?d=${id}&r=1` })).text, /try again/)
  assert.match((await post('verify', { Digits: v.data.code }, { query: `?d=${id}&r=1` })).text, /verified/)
  assert.ok(db.sql.prepare('SELECT verified_at FROM phone_destinations WHERE id = ?').get(id).verified_at)
})

test('destinations refuse loops: our own line, or the owner number that forwards to the line', async () => {
  seed('alpha', { verified: false })
  const cookie = await owner('alpha')
  assert.equal((await api('POST', cookie, { action: 'add_destination', number: LINE.alpha })).data.error, 'forwarding_loop')
  db.sql.prepare("UPDATE phone_lines SET forwarded_from = '+18435550155', forward_mode = 'no_answer' WHERE id = 'pl_alpha'").run()
  assert.equal((await api('POST', cookie, { action: 'add_destination', number: '+18435550155' })).data.error, 'forwarding_loop')
  assert.equal((await api('POST', cookie, { action: 'add_destination', number: '+19005550100' })).data.error, 'invalid_phone')
})

// ---------- owner route ----------
test('owner route: 404 when off; same-origin; settings versioned (409 stale); AI fallback only when available', async () => {
  seed('alpha')
  const cookie = await owner('alpha')
  env.PHONE_ENABLED = 'false'
  assert.equal((await api('GET', cookie)).status, 404)
  env.PHONE_ENABLED = 'true'
  const g = await api('GET', cookie)
  assert.equal(g.status, 200)
  assert.equal(g.data.recording, false)
  assert.equal(g.data.lines[0].number, LINE.alpha)
  const body = { action: 'settings', answer: 'team', ringSeconds: 25, fallback: 'callback', afterHours: 'fallback', screen: true, version: 0 }
  assert.equal((await api('POST', cookie, body)).status, 200)
  assert.equal((await api('POST', cookie, body)).status, 409)
  assert.equal((await api('POST', cookie, { ...body, version: 1, fallback: 'ai' })).data.error, 'ai_unavailable')
  const res = await phoneApi.onRequestPost({ request: new Request(`${ORIGIN}/api/dashboard/phone`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env })
  assert.equal(res.status, 403)
})

test('buying a number: off unless PHONE_NUMBER_PURCHASE; needs confirm; configures our webhooks in the business subaccount', async () => {
  seed('alpha', { line: false })
  const cookie = await owner('alpha')
  assert.equal((await api('POST', cookie, { action: 'search_numbers', areaCode: '843' })).data.error, 'purchase_off')
  Object.assign(env, { PHONE_NUMBER_PURCHASE: 'true', TWILIO_API_MOCK_ORIGIN: 'http://127.0.0.1:9' })
  twilioApi = (u) =>
    u.includes('/AvailablePhoneNumbers/US/Local.json') ? [200, { available_phone_numbers: [{ phone_number: '+18435550177', locality: 'Charleston', region: 'SC' }] }] : u.endsWith('/IncomingPhoneNumbers.json') ? [201, { sid: `PN${'2'.repeat(32)}`, phone_number: '+18435550177' }] : null
  const s = await api('POST', cookie, { action: 'search_numbers', areaCode: '843' })
  assert.deepEqual(s.data.numbers, [{ number: '+18435550177', place: 'Charleston, SC' }])
  assert.equal((await api('POST', cookie, { action: 'buy_number', number: '+18435550177' })).data.error, 'confirmation_required')
  const b = await api('POST', cookie, { action: 'buy_number', number: '+18435550177', confirm: true })
  assert.equal(b.status, 200)
  const bought = new URLSearchParams(fetches.find((f) => f.url.endsWith(`/Accounts/${SUB.alpha}/IncomingPhoneNumbers.json`)).init.body)
  assert.deepEqual([bought.get('VoiceUrl'), bought.get('StatusCallback')], [`${ORIGIN}/api/phone/twilio/voice`, `${ORIGIN}/api/phone/twilio/status`])
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM phone_lines WHERE customer = 'alpha' AND status = 'active'").get().n, 1)
})

test('test businesses never place a real verification call or buy a real number', async () => {
  seed('alpha', { verified: false })
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_at, marked_by) VALUES ('alpha', 1, 1, 'ref:x')").run()
  const cookie = await owner('alpha')
  const add = await api('POST', cookie, { action: 'add_destination', number: '(843) 555-0144' })
  assert.equal((await api('POST', cookie, { action: 'verify_destination', id: add.data.id })).data.error, 'test_business')
  env.PHONE_NUMBER_PURCHASE = 'true'
  assert.equal((await api('POST', cookie, { action: 'buy_number', number: '+18435550177', confirm: true })).data.error, 'test_business')
  assert.equal(fetches.length, 0)
})

test('show number: the line becomes the website phone only with confirmation and an unchanged base', async () => {
  seed('alpha')
  const cookie = await owner('alpha')
  assert.equal((await api('POST', cookie, { action: 'show_number', id: 'pl_alpha' })).data.error, 'confirmation_required')
  assert.equal((await api('POST', cookie, { action: 'show_number', id: 'pl_alpha', confirm: true, base: '(843) 555-9999' })).status, 409)
  const r = await api('POST', cookie, { action: 'show_number', id: 'pl_alpha', confirm: true, base: '' })
  assert.equal(r.status, 200)
  assert.equal(db.sql.prepare("SELECT phone FROM business_profiles WHERE customer = 'alpha'").get().phone, '(843) 555-0100')
  assert.equal(r.data.state.lines[0].shown, true)
})

// ---------- shared views ----------
test('setup: phoneSetup states; Setup check flags a line that rings nobody', async () => {
  seed('alpha', { verified: false })
  assert.equal((await phoneSetup(env, 'alpha')).state, 'needs_owner')
  const customer = customerFromRow(await getCustomer(db, 'alpha'))
  const items = (await setupCheck(env, customer)).items.map((i) => i.id)
  assert.ok(items.includes('phone_rings_nobody'))
  env.PHONE_ENABLED = 'false'
  assert.equal((await phoneSetup(env, 'alpha')).state, 'unavailable')
})

test('assistant: list_calls gives outcomes and refs, never a phone number; usage is an estimate, never verified unless priced', async () => {
  seed('alpha')
  await ring(20)
  await post('dial', { CallSid: sid(20), DialCallStatus: 'no-answer' }, { query: `?c=${sid(20)}` })
  const customer = customerFromRow(await getCustomer(db, 'alpha'))
  const c = toolContext(env, customer, {})
  const r = await runTool(c, 'list_calls', { which: 'missed' })
  assert.equal(r.total, 1)
  assert.equal(r.calls[0].call_back_waiting, true)
  assert.ok(!JSON.stringify(r).includes('555'), 'no phone numbers to the model')
  const u = await usage(db, 'alpha')
  assert.equal(u.calls, 1)
  assert.equal(u.verifiedUsd, null)
  assert.ok(u.estimatedUsd > 0)
})

test('retention and deletion: calls older than 365 days go with their callback task; phone tables are erased with the account', async () => {
  seed('alpha')
  await ring(21)
  await post('dial', { CallSid: sid(21), DialCallStatus: 'no-answer' }, { query: `?c=${sid(21)}` })
  db.sql.prepare('UPDATE phone_calls SET started_at = ?').run(Date.now() - CALL_RETENTION_MS - 1)
  assert.equal(await purgeOldCalls(env), 1)
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM phone_calls').get().n, 0)
  assert.equal(requests().length, 0)
  for (const t of ['phone_calls', 'phone_destinations', 'phone_settings', 'phone_lines']) assert.ok(ERASED_TABLES.includes(t), t)
})

test('spending guard: with the platform’s Retell minutes used up, or AI off for the business, the caller gets the callback path, never the AI', async () => {
  seed('alpha')
  Object.assign(env, { RETELL_API_KEY: 'key_RETELL_SECRET', RETELL_AGENT_ID: 'agent_abcdef123', RETELL_WS_SECRET: 's'.repeat(40), RECEPTIONIST_VOICE_BUSINESSES: 'alpha' })
  db.sql.prepare("INSERT INTO receptionist_settings (customer, enabled, mode, greeting, knowledge, updated_at) VALUES ('alpha', 1, 'ai_first', '', '', 1)").run()
  db.sql.prepare("INSERT INTO phone_settings (customer, answer, ring_seconds, fallback, after_hours, screen, version, updated_at) VALUES ('alpha', 'fallback', 20, 'ai', 'same', 1, 1, 1)").run()
  // Four Retell calls still open = 60 minutes at their 15-minute ceiling: no room for another.
  for (let i = 0; i < 4; i++) db.sql.prepare("INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at) VALUES (?, 'alpha', 'c', 'retell', ?)").run(`open_${i}`, Date.now() - 1000)
  const r = await ring(30)
  assert.match(r.text, /call you back/)
  assert.ok(!r.text.includes('<Sip>'))
  assert.equal(fetches.filter((f) => f.url.endsWith('/v2/register-phone-call')).length, 0)
  db.sql.prepare('DELETE FROM receptionist_calls').run()
  env.AI_OFF_BUSINESSES = 'alpha'
  assert.ok(!(await ring(31)).text.includes('<Sip>'))
  delete env.AI_OFF_BUSINESSES
  assert.match((await ring(32)).text, /<Sip>sip:call_ai_0001@sip\.retellai\.com<\/Sip>/)
})
