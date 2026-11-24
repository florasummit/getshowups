// GetShowUps selling itself (server/sales.js, /api/platform/sales-business): one confirmed admin click creates the
// sales business (real) or the Lab test business, with the Software playbook, hours, the listed plan and the approved
// answers; idempotent; admin-only; audited. The sales chat stays unreachable until the founder connects a calendar.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { customerFromRow } from '../server/auth.js'
import { getCustomer } from '../server/customers.js'
import { knowledgeFor, systemPrompt, LIMITS } from '../server/receptionist/knowledge.js'
import { getSettings } from '../server/receptionist/engine.js'
import { SALES_NOTES, SALES_GREETING } from '../server/sales.js'
import { salesChatAvailable } from '../server/public.js'
import * as api from '../functions/api/platform/sales-business.js'
import * as enrollment from '../functions/api/enrollment.js'
import * as labStatus from '../functions/api/platform/voice-lab/status.js'

const ORIGIN = 'https://getshowups.com'
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({ q, args, bind: (...a) => stmt(q, a), first: async () => sql.prepare(q).get(...args) ?? null, all: async () => ({ results: sql.prepare(q).all(...args) }), run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }) })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => list.map((s) => ({ meta: { changes: Number(sql.prepare(s.q).run(...s.args).changes) } })) }
}
let env, db, kv
const cookieFor = async (email) => {
  const token = ('tok_' + email.replace(/\W/g, '') + 'x'.repeat(43)).slice(0, 43)
  db.sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + 864e5)
  return `__Host-gsu_session=${token}`
}
const call = async (mod, method, path, { cookie, origin = ORIGIN, body } = {}) => {
  const h = { 'CF-Connecting-IP': '203.0.113.9' }
  if (cookie) h.Cookie = cookie
  if (method === 'POST') h.Origin = origin
  const res = await mod[`onRequest${method === 'GET' ? 'Get' : 'Post'}`]({ request: new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, waitUntil: () => {} })
  const text = await res.text()
  return { status: res.status, json: () => JSON.parse(text) }
}
beforeEach(() => {
  db = d1()
  kv = new Map()
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40), PLATFORM_ADMIN_EMAILS: 'staff@getshowups.com', ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async () => ({ keys: [], list_complete: true }) }, RECEPTIONIST_ANTHROPIC_API_KEY: 'sk-ant-test', VOICE_LAB_ENABLED: 'true' }
})

test('admin creates the sales business once: Software playbook, hours, the listed plan only, approved answers within the limit; idempotent; audited; owner is the admin', async () => {
  const staff = await cookieFor('staff@getshowups.com')
  assert.equal((await call(api, 'GET', '/api/platform/sales-business')).status, 401)
  assert.equal((await call(api, 'POST', '/api/platform/sales-business', { cookie: staff, body: { kind: 'sales' } })).status, 400) // confirm
  assert.equal((await call(api, 'POST', '/api/platform/sales-business', { cookie: staff, origin: 'https://evil.example', body: { kind: 'sales', confirm: true } })).status, 403)
  const before = await call(api, 'GET', '/api/platform/sales-business', { cookie: staff })
  assert.deepEqual(before.json(), { sales: { exists: false }, lab: { exists: false } })
  const r = await call(api, 'POST', '/api/platform/sales-business', { cookie: staff, body: { kind: 'sales', confirm: true } })
  assert.equal(r.status, 200)
  assert.deepEqual([r.json().created, r.json().id, r.json().status.receptionistOn, r.json().status.calendarConnected, r.json().status.hoursConfirmed], [true, 'getshowups', true, false, true])
  const customer = customerFromRow(await getCustomer(db, 'getshowups'))
  assert.deepEqual([customer.name, customer.serviceZips, customer.slotMinutes, customer.appointmentMode], ['GetShowUps', [], 20, 'at_business'])
  assert.equal(db.sql.prepare("SELECT email FROM customer_users WHERE customer = 'getshowups'").get().email, 'staff@getshowups.com')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM test_businesses WHERE customer = 'getshowups' AND is_test = 1").get().n, 0, 'the sales business is real')
  const settings = await getSettings(db, 'getshowups')
  assert.deepEqual([settings.enabled, settings.greeting], [true, SALES_GREETING])
  assert.ok(SALES_NOTES.length <= LIMITS.knowledge && SALES_GREETING.length <= LIMITS.greeting)
  assert.doesNotMatch(SALES_NOTES, /\$(?!499)\d/, 'the notes name no price other than the listed plan')
  const k = await knowledgeFor(env, customer, settings)
  assert.equal(k.playbook.key, 'sales')
  assert.match(systemPrompt(k, 'chat'), /sales assistant for GetShowUps/)
  assert.match(systemPrompt(k, 'chat'), /Growth plan: \$499\/month\n- Enterprise plan: Starting at \$10,000\/month/)
  assert.doesNotMatch(SALES_NOTES, /Founding/)
  assert.match(SALES_NOTES, /one login across businesses, shared reporting and one invoice are not live/)
  assert.equal((await call(api, 'GET', '/api/platform/sales-business', { cookie: staff })).json().sales.answers.current, true)
  // Second click: reported, not changed.
  const again = await call(api, 'POST', '/api/platform/sales-business', { cookie: staff, body: { kind: 'sales', confirm: true } })
  assert.deepEqual([again.json().created, again.json().status.exists], [false, true])
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM customers WHERE name LIKE 'GetShowUps%'").get().n, 1)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM admin_audit WHERE action = 'sales_business.created'").get().n, 1)
  // The public sales chat and the homepage entry stay off until a calendar is connected (bookableCustomer), then on.
  assert.equal(await salesChatAvailable(env), false)
  assert.equal((await call(enrollment, 'GET', '/api/enrollment')).json().salesChat, false)
  kv.set('google:getshowups', JSON.stringify({ customer: 'getshowups', refreshToken: 'x' }))
  assert.equal(await salesChatAvailable(env), true)
  assert.equal((await call(enrollment, 'GET', '/api/enrollment')).json().salesChat, true)
})

test('the Lab test business is admin-marked, offered by the Voice Lab status, and never the real sales record', async () => {
  const staff = await cookieFor('staff@getshowups.com')
  const r = await call(api, 'POST', '/api/platform/sales-business', { cookie: staff, body: { kind: 'lab', confirm: true } })
  assert.equal(r.status, 200)
  assert.equal(r.json().id, 'getshowups-lab')
  assert.equal(db.sql.prepare("SELECT is_test FROM test_businesses WHERE customer = 'getshowups-lab'").get().is_test, 1)
  const st = await call(labStatus, 'GET', '/api/platform/voice-lab/status', { cookie: staff })
  assert.deepEqual(st.json().businesses.map((b) => b.id), ['getshowups-lab'])
  assert.equal((await call(api, 'GET', '/api/platform/sales-business', { cookie: staff })).json().sales.exists, false)
  assert.equal((await call(api, 'POST', '/api/platform/sales-business', { cookie: staff, body: { kind: 'other', confirm: true } })).status, 400)
})

test('approved answers: shown when outdated, applied only by a confirmed admin with the current version; nothing else changes; audited', async () => {
  const staff = await cookieFor('staff@getshowups.com')
  const owner = await cookieFor('someone@else.example')
  const post = (body, cookie = staff, origin) => call(api, 'POST', '/api/platform/sales-business', { cookie, ...(origin ? { origin } : {}), body: { kind: 'sales', action: 'refresh_answers', ...body } })
  assert.equal((await post({ version: 'x', confirm: true })).status, 404)
  await call(api, 'POST', '/api/platform/sales-business', { cookie: staff, body: { kind: 'sales', confirm: true } })
  db.sql.exec("UPDATE receptionist_settings SET knowledge = 'Old notes', enabled = 0, greeting = 'Hey', updated_at = 5 WHERE customer = 'getshowups'")
  db.sql.exec(`UPDATE business_profiles SET services = '[{"name":"Founding plan","price":"$499/month"}]', phone = '+18435550100', updated_at = 7 WHERE customer = 'getshowups'`)
  const st = (await call(api, 'GET', '/api/platform/sales-business', { cookie: staff })).json().sales.answers
  assert.deepEqual([st.current, st.stored.notes, st.version], [false, 'Old notes', '7:5'])
  assert.equal((await post({ version: st.version })).status, 400)
  assert.equal((await post({ version: st.version, confirm: true }, owner)).status, 403)
  assert.equal((await post({ version: st.version, confirm: true }, staff, 'https://evil.example')).status, 403)
  assert.equal((await post({ version: '7:4', confirm: true })).status, 409)
  assert.equal(db.sql.prepare("SELECT knowledge FROM receptionist_settings WHERE customer = 'getshowups'").get().knowledge, 'Old notes')
  const r = await post({ version: st.version, confirm: true })
  assert.deepEqual([r.status, r.json().changed, r.json().status.answers.current], [200, true, true])
  const row = db.sql.prepare("SELECT enabled, greeting, knowledge FROM receptionist_settings WHERE customer = 'getshowups'").get()
  assert.deepEqual([row.enabled, row.greeting, row.knowledge], [0, 'Hey', SALES_NOTES])
  assert.equal(db.sql.prepare("SELECT phone FROM business_profiles WHERE customer = 'getshowups'").get().phone, '+18435550100')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM admin_audit WHERE action = 'sales_business.answers_refreshed'").get().n, 1)
  assert.equal((await call(api, 'POST', '/api/platform/sales-business', { cookie: staff, body: { kind: 'sales', action: 'other', confirm: true } })).status, 400)
})
