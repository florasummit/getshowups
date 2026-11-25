// Test sessions: only one admin-marked test business, only a short route list, nothing sent or queued, refused on any error.
// Real middleware, handlers, migrations and database; fetch is forbidden unless a test says otherwise.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { onRequest } from '../functions/_middleware.js'
import * as pairApi from '../functions/api/acceptance/pair.js'
import * as sessionApi from '../functions/api/acceptance/session.js'
import * as adminApi from '../functions/api/platform/acceptance.js'
import { ROUTES } from '../server/acceptance-routes.js'
import { CODE, COOKIE, GRANT_MS, PAIR_MS, SESSION_MS } from '../server/acceptance.js'
import { ACCEPTANCE, acceptanceEnv, checkSql, guardedDb } from '../server/acceptance-env.js'
import { runTool, toolContext } from '../server/operator-tools.js'
import { queueOwnerNotices } from '../server/notify.js'
import { detectIncidents, founderAlerts } from '../server/alerts.js'
import { customerRows, growth } from '../server/metrics.js'
import { growthMeasure } from '../server/growth.js'
import { getCustomer } from '../server/customers.js'
import { customerFromRow } from '../server/auth.js'

const ORIGIN = 'https://getshowups.com'
const ADMIN = 'admin@getshowups.com'
let sql, env, kv, realFetch, realError, realNow
const secret = (n = 's') => n.repeat(43).slice(0, 43)
beforeEach(async () => {
  sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, a = []) => ({ q, args: a, bind: (...x) => stmt(q, x), first: async () => sql.prepare(q).get(...a) ?? null, all: async () => ({ results: sql.prepare(q).all(...a) }), run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...a).changes) } }) })
  const batch = async (l) => {
    sql.exec('BEGIN')
    try {
      const out = l.map((s) => ({ meta: { changes: Number(sql.prepare(s.q).run(...s.args).changes) } }))
      sql.exec('COMMIT')
      return out
    } catch (e) {
      sql.exec('ROLLBACK')
      throw e
    }
  }
  kv = new Map([['google:testbiz', 'SEALED']])
  env = {
    GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44), ADMIN_API_TOKEN: 'a'.repeat(40), PLATFORM_ADMIN_EMAILS: ADMIN,
    ONBOARDING_DB: { prepare: (q) => stmt(q), batch }, GOOGLE_TOKENS: { get: async (k) => kv.get(k) ?? null, list: async () => ({ keys: [...kv.keys()].map((name) => ({ name })), list_complete: true }), put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k) },
    ACCEPTANCE_SESSIONS_ENABLED: 'true', OPERATOR_PROVIDER: 'claude', OPERATOR_ANTHROPIC_API_KEY: 'k', ANTHROPIC_CLIENT: { messages: { create: async () => ({ content: [{ type: 'text', text: 'All good.' }], usage: {} }) } },
    RESEND_API_KEY: 're', EMAIL_FROM: 'a@b.example', MESSAGES_LIVE: 'true', SMS_LIVE: 'true', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'w', GHL_ENABLED: 'true', ADS_LIVE_LAUNCH: 'true', ANTHROPIC_API_KEY: 'x', RECEPTIONIST_ANTHROPIC_API_KEY: 'x', CF_API_TOKEN: 'x',
  }
  for (const [id, t] of [['testbiz', 1], ['othertest', 1], ['realbiz', 0]]) {
    sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'America/New_York', '29401', 1, 1, 1)").run(id, `${id} Co`)
    sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, 1)').run(`owner@${id}.example`, id)
    if (t) sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?, 1, 'x', 1)").run(id)
  }
  sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES ('real-lead', 'realbiz', 'Real Secret Person', 'r@x.example', '8', 'Real need', 'new', 'x', ?, 1)").run(Date.now() - 864e5)
  for (const [email, tok] of [[ADMIN, 'admin'], ['owner@realbiz.example', 'real']]) sql.prepare('INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, 1, ?)').run(await sha256Hex(tok.padEnd(43, 'x')), email, Date.now() + 864e5)
  realFetch = globalThis.fetch
  globalThis.fetch = async (u) => {
    throw new Error(`outside call: ${u}`)
  }
  realError = console.error
  console.error = () => {}
  realNow = Date.now
})
afterEach(() => {
  globalThis.fetch = realFetch
  console.error = realError
  Date.now = realNow
})
const body = async (r) => ({ status: r.status, cookie: r.headers.get('set-cookie'), body: await r.json().catch(() => null) })
const normal = (tok) => `__Host-gsu_session=${tok.padEnd(43, 'x')}`
const pair = async (s = secret()) => body(await pairApi.onRequestPost({ env, request: new Request(`${ORIGIN}/api/acceptance/pair`, { method: 'POST', headers: { 'CF-Connecting-IP': '1.1.1.1' }, body: JSON.stringify({ secretHash: await sha256Hex(s) }) }) }))
const admin = async (b, { cookie = normal('admin'), origin = ORIGIN } = {}) => body(await adminApi.onRequestPost({ env, request: new Request(`${ORIGIN}/api/platform/acceptance`, { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: JSON.stringify(b) }) }))
const open = async (s = secret()) => body(await sessionApi.onRequestPost({ env, request: new Request(`${ORIGIN}/api/acceptance/session`, { method: 'POST', headers: { Authorization: `Bearer ${s}`, 'CF-Connecting-IP': '1.1.1.1' } }) }))
const approve = (code, customer = 'testbiz', more = {}) => admin({ action: 'approve', code, customer, confirmCustomer: customer, confirm: true, ...more })
const ready = async () => {
  const p = await pair()
  const g = await approve(p.body.code)
  const o = await open()
  return { grant: g.body.grant, cookie: o.cookie.split(';')[0], session: o }
}
let passed
const go = async (path, { method = 'GET', cookie, data, origin = ORIGIN, host = ORIGIN, e = env } = {}) => {
  passed = false
  const r = await onRequest({ env: e, request: new Request(`${host}${path}`, { method, headers: { Cookie: cookie, ...(method === 'GET' ? {} : { Origin: origin }) }, ...(data ? { body: JSON.stringify(data) } : {}) }), next: async () => ((passed = true), new Response('{"through":true}')) })
  return body(r)
}
const me = (cookie) => go('/api/dashboard/me', { cookie })

test('pairing, approval and session: one test business, hashes only, an hour, strict cookie', async () => {
  const p = await pair()
  assert.match(p.body.code, CODE)
  assert.equal((await open()).status, 202)
  const g = await approve(p.body.code)
  assert.deepEqual([g.status, g.body.grant.customer, g.body.grant.expiresAt - Date.now() <= GRANT_MS], [200, 'testbiz', true])
  const s = await open()
  assert.deepEqual([s.status, s.body.customer, s.body.expiresAt - Date.now() <= SESSION_MS], [200, 'testbiz', true])
  assert.match(s.cookie, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600$`))
  const token = /=([^;]+)/.exec(s.cookie)[1]
  const stored = JSON.stringify(['acceptance_pairings', 'acceptance_grants', 'acceptance_sessions', 'audit_log', 'admin_audit', 'events'].map((t) => sql.prepare(`SELECT * FROM ${t}`).all()))
  for (const x of [token, secret(), p.body.code, p.body.code.replace('-', '')]) assert.ok(!stored.includes(x))
  const r = await me(s.cookie.split(';')[0])
  assert.deepEqual([r.status, r.body.customer.id, r.body.testBusiness, r.body.email], [200, 'testbiz', true, 'acceptance-test@getshowups.invalid'])
  assert.equal(passed, false)
})

test('codes: single use, no replay, expire, need an admin, the typed business, a confirm, a test business; guesses are limited', async () => {
  const p = await pair()
  const c = p.body.code
  for (const more of [{ confirm: false }, { confirm: 'true' }, { confirmCustomer: 'othertest' }, { confirmCustomer: undefined }]) assert.equal((await approve(c, 'testbiz', more)).status, 400)
  for (const biz of ['realbiz', 'nobody-here']) assert.ok([403, 404].includes((await approve(c, biz)).status), biz)
  sql.exec("DELETE FROM rate_limits")
  assert.equal((await approve(c, 'testbiz')).status, 200)
  assert.equal((await approve(c, 'testbiz')).body.error, 'code_not_valid')
  assert.equal((await approve(c, 'othertest')).body.error, 'code_not_valid')
  assert.equal(sql.prepare('SELECT count(*) AS n FROM acceptance_grants').get().n, 1)
  for (const opt of [{ cookie: '' }, { cookie: normal('real') }, { origin: 'https://evil.example' }]) assert.ok([401, 403].includes((await admin({ action: 'approve', code: c, customer: 'testbiz', confirmCustomer: 'testbiz', confirm: true }, opt)).status))
  // Two approvals at the same moment spend it once.
  sql.exec("DELETE FROM rate_limits")
  const q = await pair(secret('q'))
  const both = await Promise.all([approve(q.body.code), approve(q.body.code, 'othertest')])
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 404])
  // Expired.
  sql.exec("DELETE FROM rate_limits")
  const e = await pair(secret('e'))
  const t = Date.now()
  Date.now = () => t + PAIR_MS + 1
  assert.equal((await approve(e.body.code)).body.error, 'code_not_valid')
  Date.now = realNow
  let limited = 0
  for (let i = 0; i < 15; i++) if ((await approve('ABCD-EFGH')).status === 429) limited++
  assert.ok(limited >= 4)
  let pairs = 0
  for (let i = 0; i < 8; i++) if ((await pair(secret(String(i)))).status === 429) pairs++
  assert.ok(pairs >= 2)
  // A used secret can't be paired again.
  sql.exec("DELETE FROM rate_limits")
  assert.equal((await pair()).status, 409)
})

test('revocation, expiry, unmarking, suspension, deletion and the switch all end access on the next request', async () => {
  const cases = {
    revoke: async (x) => assert.equal((await admin({ action: 'revoke', id: x.grant.id, confirm: true })).status, 200),
    grantExpired: async () => sql.exec('UPDATE acceptance_grants SET expires_at = 1'),
    sessionExpired: async () => sql.exec('UPDATE acceptance_sessions SET expires_at = 1'),
    unmarked: async () => sql.exec("UPDATE test_businesses SET is_test = 0 WHERE customer = 'testbiz'"),
    markGone: async () => sql.exec("DELETE FROM test_businesses WHERE customer = 'testbiz'"),
    suspended: async () => sql.exec("UPDATE customers SET status = 'suspended' WHERE id = 'testbiz'"),
    moved: async () => sql.exec("UPDATE acceptance_sessions SET customer = 'realbiz'"),
    switchOff: async () => (env.ACCEPTANCE_SESSIONS_ENABLED = 'TRUE'),
    switchGone: async () => delete env.ACCEPTANCE_SESSIONS_ENABLED,
  }
  for (const [name, end] of Object.entries(cases)) {
    sql.exec("DELETE FROM rate_limits; DELETE FROM acceptance_sessions; DELETE FROM acceptance_grants; DELETE FROM acceptance_pairings; UPDATE customers SET status = 'active'; INSERT OR REPLACE INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('testbiz', 1, 'x', 1)")
    env.ACCEPTANCE_SESSIONS_ENABLED = 'true'
    const x = await ready()
    assert.equal((await me(x.cookie)).status, 200, name)
    await end(x)
    assert.equal((await me(x.cookie)).status, 403, name)
    assert.equal((await go('/api/dashboard/assist', { method: 'POST', cookie: x.cookie, data: { question: 'hello there', view: 'overview' } })).status, 403, name)
    assert.equal((await go('/api/acceptance/fixture', { method: 'POST', cookie: x.cookie })).status, 403, name)
    if (!['sessionExpired', 'moved'].includes(name)) assert.notEqual((await open()).status, 200, name)
    assert.equal(passed, false)
  }
})

test('every error refuses: missing tables, storage failing, odd cookies, no configuration', async () => {
  const x = await ready()
  for (const c of [`${COOKIE}=short`, `${COOKIE}=${'a'.repeat(43)}`, `${COOKIE}=' OR 1=1`, `${COOKIE}=${normal('admin').split('=')[1]}`, `${COOKIE}=${normal('real').split('=')[1]}`]) {
    assert.equal((await me(c)).status, 403, c)
    assert.equal(passed, false)
  }
  for (const t of ['test_businesses', 'acceptance_grants', 'customers', 'account_deletions', 'customer_settings']) {
    const prepare = env.ONBOARDING_DB.prepare
    const broken = { ...env, ONBOARDING_DB: { ...env.ONBOARDING_DB, prepare: (q) => (q.includes(t) ? { bind: () => ({ first: async () => { throw new Error('D1 down') } }) } : prepare(q)) } }
    assert.equal((await go('/api/dashboard/me', { cookie: x.cookie, e: broken })).status, 403, t)
    assert.equal(passed, false)
  }
  assert.equal((await go('/api/dashboard/me', { cookie: x.cookie, e: { ...env, GOOGLE_CLIENT_ID: '' } })).status, 403)
  assert.equal((await go('/api/dashboard/me', { cookie: x.cookie, host: 'https://customer-site.example' })).status, 403)
  sql.exec('DROP TABLE acceptance_sessions')
  assert.equal((await me(x.cookie)).status, 403)
  assert.equal((await open()).status, 503)
  sql.exec('DROP TABLE acceptance_grants')
  sql.exec('DROP TABLE acceptance_pairings')
  assert.equal((await pair(secret('z'))).status, 503)
  for (const s of ['', 'x', 'Bearer', secret('w')]) assert.notEqual((await open(s)).status, 200)
})

const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(new URL(f, dir)).isDirectory() ? files(new URL(`${f}/`, dir)) : [new URL(f, dir)]))
test('every API route in the repository is refused to a test session, except the exact list', async () => {
  const x = await ready()
  const all = files(new URL('../functions/api/', import.meta.url)).map((u) => u.pathname.split('/functions')[1].replace(/\.js$/, '').replace(/\/index$/, '').replace(/\[\[?(\w+)\]?\]/g, 'realbiz'))
  assert.ok(all.length > 100)
  let checked = 0
  for (const p of all) {
    if (/^\/api\/acceptance\/(pair|session)$/.test(p)) continue
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      if (Object.hasOwn(ROUTES, `${method} ${p}`)) continue
      const r = await go(p, { method, cookie: x.cookie, ...(method === 'POST' ? { data: { customer: 'realbiz', confirm: true } } : {}) })
      assert.equal(r.status, 403, `${method} ${p}`)
      assert.equal(passed, false, `${method} ${p}`)
      checked++
    }
  }
  assert.ok(checked > 700, String(checked))
  for (const p of ['/api/dashboard/me/', '/api/dashboard//me', '/api/dashboard/ME', '/api/dashboard/%6de', '/api/dashboard/me/../../platform/overview', '/api/__proto__', '/api/constructor']) assert.equal((await go(p, { cookie: x.cookie })).status, 403, p)
  assert.deepEqual(Object.keys(ROUTES).filter((k) => /billing|stripe|calendar|\/ads|domain|website|settings|hours|profile|business|account|platform|admin|voice|receptionist|texting|thread|ghl|key|cron|publish/.test(k)), [])
})

test('no tenant switch or privilege: parameters, forged references, another business’s proposals; a normal session is never combined', async () => {
  const x = await ready()
  for (const p of ['/api/dashboard/overview?customer=realbiz', '/api/dashboard/results?customer=realbiz&days=30&scope=all', '/api/dashboard/insights?customer=realbiz', '/api/dashboard/me?customer=realbiz']) {
    const r = await go(p, { cookie: x.cookie })
    assert.equal(r.status, 200, p)
    assert.doesNotMatch(JSON.stringify(r.body), /realbiz|Real Secret/, p)
  }
  const seen = []
  env.ANTHROPIC_CLIENT = { messages: { create: async (b) => (seen.push(b), { content: [{ type: 'text', text: 'Nothing there.' }], usage: {} }) } }
  const r = await go('/api/dashboard/assist', { method: 'POST', cookie: x.cookie, data: { customer: 'realbiz', question: 'tell me about that lead', view: 'followups', selected: 'real-lead', refs: { L: ['real-lead'] }, looked: [{ name: 'get_lead', args: { ref: 'L1' } }] } })
  assert.equal(r.status, 200)
  assert.doesNotMatch(JSON.stringify([r, seen]), /Real Secret|Real need/)
  sql.prepare("INSERT INTO receptionist_conversations (id, customer, channel, created_at, updated_at) VALUES ('cv', 'realbiz', 'chat', 1, 1)").run()
  sql.prepare("INSERT INTO receptionist_requests (id, customer, conversation_id, kind, created_at, updated_at) VALUES ('rr', 'realbiz', 'cv', 'callback', 1, 1)").run()
  assert.equal((await go('/api/dashboard/proposal', { method: 'POST', cookie: x.cookie, data: { type: 'call_back_done', id: 'rr', confirm: true } })).status, 404)
  assert.equal(sql.prepare("SELECT status FROM receptionist_requests WHERE id = 'rr'").get().status, 'open')
  assert.equal((await go('/api/dashboard/assist', { method: 'POST', cookie: x.cookie, origin: 'https://evil.example', data: { question: 'hello there' } })).status, 403)
  // With a normal session present the test cookie counts for nothing, and the other way round.
  await go('/api/dashboard/me', { cookie: `${x.cookie}; ${normal('real')}` })
  assert.equal(passed, true)
  assert.equal((await admin({ action: 'revoke', id: x.grant.id, confirm: true }, { cookie: x.cookie })).status, 401)
})

test('actions: revoked between the request and the action, nothing runs; tools stop too', async () => {
  const x = await ready()
  await go('/api/acceptance/fixture', { method: 'POST', cookie: x.cookie })
  let ok = true
  const grant = { customer: 'testbiz', session: { email: 'a@b.invalid', customer: customerFromRow(await getCustomer(env.ONBOARDING_DB, 'testbiz')) }, recheck: async () => ok }
  const e = acceptanceEnv(env, grant)
  const c = toolContext(e, grant.session.customer, {})
  assert.equal((await runTool(c, 'who_is_waiting', {})).call_backs_waiting, 1)
  assert.equal((await runTool(c, 'open_times', {})).error, 'calendar_unavailable')
  ok = false
  assert.equal((await runTool(c, 'who_is_waiting', {})).error, 'not_allowed')
  const { applyProposal } = await import('../server/proposals.js')
  assert.deepEqual(await applyProposal(e, { ...grant.session }, { type: 'call_back_done', id: 'acc-r-vera', confirm: true }), { ok: false, error: 'not_allowed', status: 403 })
  grant.recheck = async () => { throw new Error('x') }
  assert.equal((await runTool(c, 'who_is_waiting', {})).error, 'not_allowed')
  assert.equal(sql.prepare("SELECT status FROM receptionist_requests WHERE id = 'acc-r-vera'").get().status, 'open')
})

const QUEUES = ['messages', 'email_outbox', 'thread_messages', 'ghl_links', 'ad_actions', 'ad_campaigns', 'sms_consents', 'sessions', 'customer_users', 'subscriptions', 'websites', 'website_versions']
test('approved changes work in the test business and send, queue and connect nothing', async () => {
  const x = await ready()
  const before = QUEUES.map((t) => sql.prepare(`SELECT count(*) AS n FROM ${t}`).get().n)
  assert.equal((await go('/api/acceptance/fixture', { method: 'POST', cookie: x.cookie })).status, 200)
  assert.equal((await go('/api/acceptance/fixture', { method: 'POST', cookie: x.cookie })).status, 200)
  const p = (data) => go('/api/dashboard/proposal', { method: 'POST', cookie: x.cookie, data: { confirm: true, ...data } })
  assert.equal((await p({ type: 'call_back_done', id: 'acc-r-vera' })).status, 200)
  assert.equal((await p({ type: 'outcome', id: 'acc-a-kai', outcome: 'no_show', before: { status: 'booked', work: null } })).status, 200)
  assert.equal((await p({ type: 'outcome', id: 'acc-a-kai', outcome: 'completed', before: { status: 'no_show', work: null } })).status, 200)
  assert.equal((await p({ type: 'service_zips', before: ['29401'], after: ['29401', '29464'] })).status, 200)
  assert.deepEqual(QUEUES.map((t) => sql.prepare(`SELECT count(*) AS n FROM ${t}`).get().n), before)
  assert.equal(sql.prepare("SELECT status FROM appointments WHERE id = 'acc-a-kai'").get().status, 'showed')
  assert.equal(sql.prepare("SELECT service_zips FROM customers WHERE id = 'realbiz'").get().service_zips, '29401')
  assert.equal((await go('/api/acceptance/fixture', { method: 'POST', cookie: x.cookie })).status, 200)
  assert.equal(sql.prepare("SELECT status FROM receptionist_requests WHERE id = 'acc-r-vera'").get().status, 'open')
  assert.deepEqual(sql.prepare("SELECT count(*) AS n FROM leads WHERE customer = 'realbiz'").get().n, 1)
  // The scheduled jobs find nothing to tell anyone about.
  const q = await queueOwnerNotices(env)
  assert.equal(q.queued, 0)
  assert.equal(sql.prepare('SELECT count(*) AS n FROM email_outbox').get().n, 0)
  assert.equal(sql.prepare("SELECT count(*) AS n FROM leads WHERE customer = 'testbiz' AND email NOT LIKE '%.invalid'").get().n, 0)
})

test('the stripped environment: no sending or connecting credentials, tokens unreadable, writes only where allowed', async () => {
  const grant = { customer: 'testbiz', recheck: async () => true }
  const e = acceptanceEnv(env, grant)
  for (const k of ['RESEND_API_KEY', 'EMAIL_FROM', 'MESSAGES_LIVE', 'SMS_LIVE', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'GHL_ENABLED', 'ADS_LIVE_LAUNCH', 'ANTHROPIC_API_KEY', 'RECEPTIONIST_ANTHROPIC_API_KEY', 'CF_API_TOKEN', 'AI', 'A_NEW_SETTING']) assert.equal(e[k], undefined, k)
  assert.ok(Object.isFrozen(e))
  assert.deepEqual([await e.GOOGLE_TOKENS.get('google:testbiz'), await e.GOOGLE_TOKENS.get('google:realbiz')], ['{}', null])
  await assert.rejects(() => e.GOOGLE_TOKENS.put('a', 'b'))
  await assert.rejects(() => e.GOOGLE_TOKENS.delete('google:testbiz'))
  const bad = ['INSERT INTO messages (id) VALUES (?1)', 'INSERT INTO email_outbox (id) VALUES (?1)', 'UPDATE customers SET status = ?2 WHERE id = ?1', "UPDATE customers SET name = 'x' WHERE id = ?1 and 1", 'DELETE FROM leads WHERE customer = ?1', 'DROP TABLE leads', 'SELECT * FROM sessions', 'SELECT * FROM acceptance_grants', 'SELECT 1; DELETE FROM leads', 'WITH x AS (SELECT 1) DELETE FROM leads', 'PRAGMA writable_schema = 1', 'ATTACH DATABASE ?1 AS y', 'INSERT INTO customer_users (email) VALUES (?1)', 'INSERT INTO sessions (token_hash) VALUES (?1)', 'UPDATE test_businesses SET is_test = 0', 'INSERT INTO leads (id) VALUES (?1)', '/* x */ DELETE /* y */ FROM leads', 'REPLACE INTO leads (id) VALUES (?1)', 'UPDATE leads SET customer = ?1', 'INSERT INTO lead_threads (lead_id) VALUES (?1)', 'UPDATE appointments SET customer = ?1', 'UPDATE subscriptions SET status = ?1']
  for (const s of bad) assert.throws(() => checkSql(s, 'testbiz'), /acceptance_blocked/, s)
  assert.equal(checkSql("SELECT replace(phone, ' ', '') FROM leads WHERE note = 'DELETE FROM x; y'", 'testbiz'), null)
  const db = guardedDb(env.ONBOARDING_DB, 'testbiz')
  assert.throws(() => db.prepare("UPDATE leads SET status = ?3 WHERE id = ?1 AND customer = ?2").bind('real-lead', 'realbiz', 'booked'), /acceptance_blocked/)
  assert.throws(() => db.prepare("UPDATE leads SET status = 'booked'").run(), /acceptance_blocked/)
  assert.equal(env[ACCEPTANCE], undefined)
  assert.equal({ ...env, acceptance: grant, 'Symbol(acceptance)': grant }[ACCEPTANCE], undefined)
})

test('synthetic activity stays out of platform figures and founder alerts', async () => {
  const now = Date.now()
  // Everything the console counts, with real and test businesses present.
  const figures = async () => JSON.stringify([await growth(env, await customerRows(env, now), now), await growthMeasure(env, now)])
  const base = await figures()
  assert.ok(base.length > 200)
  const x = await ready()
  await go('/api/acceptance/fixture', { method: 'POST', cookie: x.cookie })
  for (let i = 0; i < 5; i++) sql.prepare("INSERT INTO events (id, type, customer, at, props) VALUES (?, 'ai_ask', 'testbiz', ?, '{\"ok\":false,\"reason\":\"setup\"}')").run(`f${i}`, Date.now())
  sql.prepare("INSERT INTO revenue_entries (appointment_id, customer, kind, amount_cents, recorded_by, recorded_at) VALUES ('acc-a-kai', 'testbiz', 'paid', 99900, 'ref:x', 1)").run()
  assert.equal(await figures(), base)
  assert.deepEqual((await detectIncidents(env)).filter((i) => i.customer === 'testbiz'), [])
env.FOUNDER_ALERTS_ENABLED = 'true'
  await founderAlerts(env)
  assert.equal(sql.prepare("SELECT count(*) AS n FROM email_outbox WHERE body LIKE '%assistant%' OR subject LIKE '%assistant%'").get().n, 0)
  // The same failures at a real business do alert, so the test proves something.
  for (let i = 0; i < 5; i++) sql.prepare("INSERT INTO events (id, type, customer, at, props) VALUES (?, 'ai_ask', 'realbiz', ?, '{\"ok\":false,\"reason\":\"setup\"}')").run(`g${i}`, Date.now())
  const n = sql.prepare('SELECT count(*) AS n FROM email_outbox').get().n
  await founderAlerts(env)
  assert.ok(sql.prepare('SELECT count(*) AS n FROM email_outbox').get().n > n)
})

test('off by default: nothing is offered, and normal requests never reach any of this', async () => {
  delete env.ACCEPTANCE_SESSIONS_ENABLED
  assert.deepEqual([(await pair()).status, (await open()).status, (await approve('ABCD-EFGH')).body.error], [404, 404, 'switched_off'])
  assert.equal((await go('/api/dashboard/me', { cookie: `${COOKIE}=${'a'.repeat(43)}` })).status, 403)
  await go('/api/dashboard/me', { cookie: normal('real') })
  assert.equal(passed, true)
  await go('/api/book/realbiz', { cookie: '' })
  assert.equal(passed, true)
  const l = await body(await adminApi.onRequestGet({ env, request: new Request(ORIGIN, { headers: { Cookie: normal('admin') } }) }))
  assert.deepEqual([l.status, l.body.enabled], [200, false])
  assert.equal((await adminApi.onRequestGet({ env, request: new Request(ORIGIN, { headers: { Cookie: normal('real') } }) })).status, 403)
})

test('approvals, sessions, refused writes and revocations are in the permanent audit log', async () => {
  const x = await ready()
  await go('/api/dashboard/hours', { method: 'POST', cookie: x.cookie, data: {} })
  await admin({ action: 'revoke', id: x.grant.id, confirm: true })
  const actions = sql.prepare("SELECT action FROM audit_log WHERE action LIKE 'acceptance.%' ORDER BY seq").all().map((r) => r.action)
  assert.deepEqual(actions, ['acceptance.approve', 'acceptance.session', 'acceptance.refused', 'acceptance.revoke'])
})
