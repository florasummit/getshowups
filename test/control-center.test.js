// QA & Account Operations Control Center (B1): incident register (detect, dedupe, evidence-based recovery, fixed
// causes), Account + Journey Inspector, overview, admin-only routes, read-only calendar diagnosis. Real handlers +
// migrations on node:sqlite; Google never called (no stored token) unless a test mocks fetch.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { recordEvent } from '../server/auditlog.js'
import { recordAvailability } from '../server/booking.js'
import { syncIncidents, listIncidents, sanitizeEvidence } from '../server/ops/incidents.js'
import { inspectAccount, journeySteps } from '../server/ops/inspector.js'
import { controlOverview } from '../server/ops/control.js'
import { JOURNEYS, linkedTests, matchTest } from '../server/ops/journeys.js'
import { listCapabilities } from '../server/ops/registry.js'
import * as inspectorRoute from '../functions/api/platform/inspector.js'
import * as controlRoute from '../functions/api/platform/control.js'
import * as incidentsRoute from '../functions/api/platform/incidents.js'

const ORIGIN = 'https://getshowups.com'
const MIN = 60000
const DAY = 86400000
const NOW = Date.UTC(2026, 10, 20, 15, 5) // not on the hour: the hourly KV check does not run
function d1() {
  const sql = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q, args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: sql.prepare(q).run(...args).changes } }),
  })
  return { sql, prepare: (q) => stmt(q), batch: async (l) => l.forEach((s) => sql.prepare(s.q).run(...s.args)) }
}
const kvStore = () => {
  const m = new Map()
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k), list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) }
}
let env, db, origError
beforeEach(() => {
  db = d1()
  origError = console.error
  console.error = () => {}
  env = {
    ONBOARDING_DB: db, GOOGLE_TOKENS: kvStore(), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/x`,
    TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_API_TOKEN: 'a'.repeat(40), PLATFORM_ADMIN_EMAILS: 'founder@getshowups.example',
  }
  for (const id of ['alpha', 'beta']) {
    db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES (?, ?, 'UTC', '', '09:00', '17:00', '1,2,3,4,5', 1, 1, 1)").run(id, `${id} Co`)
    db.sql.prepare('INSERT INTO customer_users (email, customer, created_at) VALUES (?, ?, 1)').run(`owner@${id}.example`, id)
  }
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES ('L1', 'alpha', 'Lee Secret', 'lee.secret@example.net', '843-555-0101', 'x', 'booked', 'h', 1, 1)").run()
})
afterEach(() => { console.error = origError })

const failSeq = async (c, status, times) => { for (const t of times) await recordAvailability(env, c, { ok: false, status }, t) }
const rows = () => db.sql.prepare('SELECT * FROM ops_incidents ORDER BY detected_at, id').all()
async function cookie(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
const call = async (route, method, path, { c, body, origin = ORIGIN } = {}) => {
  const headers = { ...(c ? { Cookie: c } : {}), ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) }
  const res = await route[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request: new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env })
  return { status: res.status, json: await res.json() }
}

test('availability failure: opens ONE incident (dedupe across runs, occurrences grow), resolves only on a later success, a new failure is a new episode', async () => {
  await failSeq('alpha', 'calendar_error', [NOW - 20 * MIN, NOW - 14 * MIN])
  assert.equal((await syncIncidents(env, NOW)).opened, 0, 'below the threshold (2 lookups)')
  await failSeq('alpha', 'calendar_error', [NOW - 2 * MIN])
  assert.deepEqual(await syncIncidents(env, NOW), { ready: true, opened: 1, updated: 0, resolved: 0 })
  let [i] = rows()
  assert.equal(i.fingerprint, 'availability:alpha')
  assert.equal(i.kind, 'availability')
  assert.equal(i.feature, 'calendar.google')
  assert.equal(i.journey, 'booking')
  assert.equal(i.step, 'availability')
  assert.equal(i.severity, 'high')
  assert.equal(i.cause, 'unknown', 'no cause is invented for a generic calendar error')
  assert.equal(i.status, 'open')
  // Repeated failures and runs: same row, more occurrences.
  await failSeq('alpha', 'calendar_error', [NOW + 4 * MIN, NOW + 10 * MIN])
  assert.equal((await syncIncidents(env, NOW + 11 * MIN)).opened, 0)
  assert.equal((await syncIncidents(env, NOW + 12 * MIN)).opened, 0)
  assert.equal(rows().length, 1)
  ;[i] = rows()
  assert.equal(i.occurrences, 5)
  assert.equal(i.last_seen, NOW + 10 * MIN)
  // Quiet (nobody visits) is NOT recovery: still open 2 hours later.
  assert.equal((await syncIncidents(env, NOW + 130 * MIN)).resolved, 0)
  // A successful lookup is evidence of recovery.
  await recordAvailability(env, 'alpha', { ok: true }, NOW + 131 * MIN)
  assert.equal((await syncIncidents(env, NOW + 132 * MIN)).resolved, 1)
  ;[i] = rows()
  assert.equal(i.status, 'resolved')
  assert.equal(i.resolution, 'success_seen')
  // Breaks again: a new episode; the resolved one stays as history.
  await failSeq('alpha', 'calendar_error', [NOW + 140 * MIN, NOW + 146 * MIN, NOW + 152 * MIN])
  assert.equal((await syncIncidents(env, NOW + 153 * MIN)).opened, 1)
  assert.deepEqual(rows().map((r) => r.status), ['resolved', 'open'])
  // Each open/resolve is in the permanent audit log (codes only).
  const ev = db.sql.prepare("SELECT action FROM audit_log WHERE capability = 'platform.incidents' ORDER BY seq").all().map((r) => r.action)
  assert.deepEqual(ev, ['incident.opened', 'incident.resolved', 'incident.opened'])
})

test('causes come from the fixed table: invalid grant = confirmed (critical calendar incident), refresh failure = suspected; never inferred', async () => {
  await failSeq('alpha', 'reconnect_required', [NOW - MIN])
  await failSeq('beta', 'token_refresh_failed', [NOW - 12 * MIN])
  await syncIncidents(env, NOW)
  const list = await listIncidents(db, { status: 'open' })
  const a = list.find((x) => x.customer === 'alpha')
  const b = list.find((x) => x.customer === 'beta')
  assert.equal(a.kind, 'calendar')
  assert.equal(a.severity, 'critical')
  assert.equal(a.cause, 'confirmed')
  assert.match(a.causeNote, /invalid_grant/)
  assert.match(a.recovery, /reconnect Google Calendar/)
  assert.match(a.impact, /can’t see or book times/)
  assert.equal(b.cause, 'suspected')
})

test('comms: a failed booking confirmation is a critical incident; it resolves as "no new failures" (never "fixed") after the window', async () => {
  db.sql.prepare("INSERT INTO messages (id, customer, lead_id, kind, channel, send_at, status, attempts, error, created_at, updated_at) VALUES ('confirmation:email:A1', 'alpha', 'L1', 'confirmation', 'email', ?, 'failed', 3, 'http_500', ?, ?)").run(NOW - MIN, NOW - MIN, NOW - MIN)
  await syncIncidents(env, NOW)
  const [i] = await listIncidents(db, { status: 'open' })
  assert.equal(i.kind, 'comms')
  assert.equal(i.severity, 'critical')
  assert.equal(i.code, 'confirmation_failed')
  await syncIncidents(env, NOW + 30 * MIN)
  assert.equal(rows()[0].status, 'open')
  await syncIncidents(env, NOW + 61 * MIN)
  assert.equal(rows()[0].status, 'resolved')
  assert.equal(rows()[0].resolution, 'no_new_failures')
})

test('other failure events become incidents per feature + business + action; follow-up text failures are counted once (comms rule only)', async () => {
  await recordEvent(db, { type: 'booking.failed', actor: 'system:booking', customer: 'beta', capability: 'calendar.google', resource: { type: 'business', id: 'beta' }, outcome: 'failure', details: { error: 'calendar_error' }, at: NOW - MIN })
  for (let k = 0; k < 2; k++) await recordEvent(db, { type: 'followups.send_failed', actor: 'system:followups', customer: 'alpha', capability: 'followups.sms', resource: { type: 'message', id: `m${k}` }, outcome: 'failure', details: { error: 'http_500' }, at: NOW - MIN })
  await syncIncidents(env, NOW)
  const list = await listIncidents(db, { status: 'open' })
  assert.deepEqual(list.map((x) => x.fingerprint), ['failure:calendar.google:beta:booking.failed'])
  assert.equal(list[0].severity, 'high')
  assert.equal(list[0].code, 'calendar_error')
  assert.deepEqual(list[0].evidence.events.length, 1)
  // A later success for the same resource resolves it.
  await recordEvent(db, { type: 'booking.recovered', actor: 'system:booking', customer: 'beta', capability: 'calendar.google', resource: { type: 'business', id: 'beta' }, outcome: 'success', details: {}, at: NOW + MIN })
  await syncIncidents(env, NOW + 2 * MIN)
  assert.equal((await listIncidents(db, { status: 'resolved' })).length, 1)
})

test('test businesses: incidents recorded and tagged, never counted as customer impact; unreadable test list = treated as test', async () => {
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('beta', 1, 'founder@getshowups.example', 1)").run()
  await failSeq('alpha', 'reconnect_required', [NOW - MIN])
  await failSeq('beta', 'reconnect_required', [NOW - MIN])
  await syncIncidents(env, NOW)
  const o = await controlOverview(env, NOW)
  assert.equal(o.incidents.open, 1)
  assert.equal(o.incidents.openTest, 1)
  assert.equal(o.incidents.critical, 1)
  assert.deepEqual(o.affectedBusinesses.map((b) => b.id), ['alpha'])
  assert.ok(o.nextActions.some((a) => a.customer === 'alpha' && /reconnect/.test(a.text)))
  assert.ok(!o.nextActions.some((a) => a.customer === 'beta'))
  // Unreadable test list: new incidents are tagged test (fails closed: never claimed as customer impact).
  db.sql.exec('ALTER TABLE test_businesses RENAME TO tb_gone')
  db.sql.prepare("INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES ('gamma', 'gamma Co', 'UTC', '', '09:00', '17:00', '1', 1, 1, 1)").run()
  await failSeq('gamma', 'reconnect_required', [NOW + MIN])
  await syncIncidents(env, NOW + 2 * MIN)
  assert.equal(db.sql.prepare("SELECT is_test FROM ops_incidents WHERE customer = 'gamma'").get().is_test, 1)
})

test('evidence is allowlisted codes/counts/times only (≤ 2 KB): free text, emails and nested objects are dropped', () => {
  const e = JSON.parse(sanitizeEvidence({ code: 'calendar_error', error: 'lee.secret@example.net <b>', count: 3, events: [1, 2, 'x', 3], body: 'Lee Secret', resource: { id: 'L1' }, firstSeen: 5 }))
  assert.deepEqual(Object.keys(e).sort(), ['code', 'count', 'error', 'events', 'firstSeen'])
  assert.equal(e.error, 'lee.secretexample.netb')
  assert.deepEqual(e.events, [1, 2, 3])
})

test('before migration 0031: sync is a no-op, the inspector and overview still work (empty register)', async () => {
  db.sql.exec('DROP TABLE ops_incidents')
  assert.deepEqual(await syncIncidents(env, NOW), { ready: false })
  assert.deepEqual((await inspectAccount(env, 'alpha', NOW)).incidents, [])
  assert.equal((await controlOverview(env, NOW)).incidents.open, 0)
})

test('journey steps: legacy setup skips self-serve steps; unpaid self-serve is blocked at payment while billing is not live; a calendar incident fails the calendar step and booking', () => {
  const legacy = journeySteps({ onboarding: { selfServe: false, steps: [{ id: 'business', done: true }, { id: 'calendar', done: true }, { id: 'hours', done: true }] }, incidents: [], bookable: true, billingLive: false, messages: { gate: 'test_only', sent7: 0 } })
  assert.deepEqual(legacy.map((s) => `${s.id}:${s.state}`), ['business:completed', 'payment:skipped', 'details:skipped', 'services:skipped', 'calendar:completed', 'hours:completed', 'website:skipped', 'address:skipped', 'publish:skipped', 'launch:skipped', 'booking_live:completed', 'messages:skipped'])
  const unpaid = journeySteps({ onboarding: { selfServe: true, billing: 'required', steps: ['business', 'payment', 'details'].map((id, k) => ({ id, done: k === 0 })) }, incidents: [], bookable: false, billingLive: false, messages: { gate: 'test_only', sent7: 0 } })
  assert.equal(unpaid.find((s) => s.id === 'payment').state, 'blocked')
  assert.equal(unpaid.find((s) => s.id === 'payment').reason, 'billing_not_live')
  assert.equal(unpaid.find((s) => s.id === 'details').state, 'blocked')
  const broken = journeySteps({ onboarding: { selfServe: false, steps: [{ id: 'business', done: true }, { id: 'calendar', done: true }, { id: 'hours', done: true }] }, incidents: [{ id: 'inc_1', status: 'open', kind: 'calendar', code: 'reconnect_required' }], bookable: true, billingLive: false, messages: { gate: 'test_only', sent7: 0 } })
  assert.deepEqual([broken.find((s) => s.id === 'calendar').state, broken.find((s) => s.id === 'booking_live').state], ['failed', 'failed'])
  const unknown = journeySteps({ onboarding: null, incidents: [], bookable: false, billingLive: false, messages: { gate: 'test_only', sent7: 0 } })
  assert.ok(unknown.every((s) => s.state === 'unknown'))
})

test('account inspector: readiness, voice gate, comms, journey, incidents; counts/codes only (no lead contact data); tenant isolation', async () => {
  await failSeq('alpha', 'reconnect_required', [NOW - MIN])
  await failSeq('beta', 'reconnect_required', [NOW - MIN])
  await syncIncidents(env, NOW)
  const a = await inspectAccount(env, 'alpha', NOW)
  assert.equal(a.identity.id, 'alpha')
  assert.equal(a.calendar.connected, false)
  assert.equal(a.booking.ready, false)
  assert.ok(a.booking.reasons.includes('calendar_not_connected'))
  assert.equal(a.voice.status, 'not_configured')
  assert.equal(a.communications.gate, 'test_only')
  assert.equal(a.journey.type.primary, 'existing')
  assert.equal(a.journey.type.recovery, true)
  assert.equal(a.journey.definition, 'calendar-recovery')
  assert.ok(a.incidents.every((i) => i.customer === 'alpha'))
  assert.equal(a.incidents.length, 1)
  const s = JSON.stringify(a)
  assert.doesNotMatch(s, /lee\.secret|Lee Secret|843-555|owner@alpha/)
  assert.equal(await inspectAccount(env, 'nobody', NOW), null)
})

test('routes: admin only (401/403), invalid ids refused, diagnosis is same-origin, rate-limited, audited and read-only (codes only)', async () => {
  const admin = await cookie('founder@getshowups.example')
  const owner = await cookie('owner@alpha.example')
  assert.equal((await call(controlRoute, 'GET', '/api/platform/control')).status, 401)
  assert.equal((await call(controlRoute, 'GET', '/api/platform/control', { c: owner })).status, 403)
  assert.equal((await call(controlRoute, 'GET', '/api/platform/control', { c: admin })).status, 200)
  assert.equal((await call(inspectorRoute, 'GET', '/api/platform/inspector?business=alpha', { c: owner })).status, 403)
  assert.equal((await call(inspectorRoute, 'GET', '/api/platform/inspector?business=../x', { c: admin })).status, 400)
  assert.equal((await call(inspectorRoute, 'GET', '/api/platform/inspector?business=alpha', { c: admin })).status, 200)
  assert.equal((await call(incidentsRoute, 'GET', '/api/platform/incidents?status=bogus', { c: admin })).status, 400)
  assert.equal((await call(incidentsRoute, 'GET', '/api/platform/incidents', { c: owner })).status, 403)
  // Diagnosis
  assert.equal((await call(inspectorRoute, 'POST', '/api/platform/inspector', { c: admin, body: { business: 'alpha', check: 'calendar' }, origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(inspectorRoute, 'POST', '/api/platform/inspector', { c: owner, body: { business: 'alpha', check: 'calendar' } })).status, 403)
  assert.equal((await call(inspectorRoute, 'POST', '/api/platform/inspector', { c: admin, body: { business: 'alpha', check: 'drop' } })).status, 400)
  const d = await call(inspectorRoute, 'POST', '/api/platform/inspector', { c: admin, body: { business: 'alpha', check: 'calendar' } })
  assert.equal(d.status, 200)
  assert.equal(d.json.ok, false)
  assert.equal(d.json.code, 'not_connected')
  assert.deepEqual(Object.keys(d.json).sort(), ['checkedAt', 'code', 'ms', 'ok', 'openTimes'])
  // Not recorded as an availability event (a support check never opens/closes incidents); audited as an admin action.
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM audit_log WHERE resource_type = 'availability'").get().n, 0)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM admin_audit WHERE action = 'support.diagnose_calendar' AND customer = 'alpha'").get().n, 1)
  for (let k = 0; k < 5; k++) await call(inspectorRoute, 'POST', '/api/platform/inspector', { c: admin, body: { business: 'alpha', check: 'calendar' } })
  assert.equal((await call(inspectorRoute, 'POST', '/api/platform/inspector', { c: admin, body: { business: 'alpha', check: 'calendar' } })).status, 429)
})

test('registry: stable unique journey/step/test ids; every step names a registered feature; Playwright results map to tests', () => {
  const ids = JOURNEYS.map((j) => j.id)
  assert.equal(new Set(ids).size, ids.length)
  const features = new Set(listCapabilities().map((c) => c.id))
  for (const j of JOURNEYS) {
    assert.equal(new Set(j.steps.map((s) => s.id)).size, j.steps.length, j.id)
    for (const s of j.steps) assert.ok(features.has(s.feature), `${j.id}.${s.id}: unknown feature ${s.feature}`)
  }
  const tests = linkedTests()
  assert.equal(new Set(tests.map((t) => t.id)).size, tests.length)
  assert.deepEqual(matchTest('test/e2e/booking.spec.js', 'lead books a real appointment; owner sees it').map((t) => t.journey), ['booking'])
  assert.deepEqual(matchTest('test/e2e/booking.spec.js', 'something else'), [])
})
