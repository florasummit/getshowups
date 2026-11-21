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
import { syncIncidents, listIncidents, sanitizeEvidence, incidentDetail } from '../server/ops/incidents.js'
import { INTEGRATION_STATES, integrationState, incidentPhase, triage, accountReadiness, withPhase } from '../server/ops/states.js'
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
  const [res] = await listIncidents(db, { status: 'resolved' })
  assert.equal(res.resolution, 'success_seen')
  // A failure that ages out of the 14-day lookback WITHOUT a success is never reported as recovered.
  await recordEvent(db, { type: 'sms.webhook_rejected', actor: 'system:twilio', capability: 'followups.sms_inbound', resource: { type: 'sender', id: 'unknown' }, outcome: 'failure', details: { reason: 'bad_signature' }, at: NOW })
  await syncIncidents(env, NOW + 3 * MIN)
  assert.equal((await listIncidents(db, { status: 'open' })).length, 1)
  await syncIncidents(env, NOW + 15 * DAY)
  const aged = (await listIncidents(db, { status: 'resolved' })).find((i) => i.feature === 'followups.sms_inbound')
  assert.equal(aged.resolution, 'no_new_failures')
})

test('bounded per run: at most 50 new incidents open per cron run; the rest open next run without duplicates; the step runs after every existing cron job', async () => {
  for (let k = 0; k < 60; k++) await recordEvent(db, { type: `x.failed_${k}`, actor: 'system:test', capability: 'platform.test', resource: { type: 'thing', id: `t${k}` }, outcome: 'failure', details: { error: 'e' }, at: NOW - MIN })
  assert.equal((await syncIncidents(env, NOW)).opened, 50)
  assert.deepEqual(await syncIncidents(env, NOW + MIN), { ready: true, opened: 10, updated: 50, resolved: 0 })
  assert.equal(rows().length, 60)
  // Cron order: the incident register is the last step (it cannot use up the budget of delivery / ads / billing jobs).
  const src = readFileSync(new URL('../functions/api/cron/run.js', import.meta.url), 'utf8')
  assert.ok(src.indexOf("adsStep('incidents'") > src.indexOf("adsStep('audit'"), 'incidents after the audit checkpoint')
  assert.ok(src.indexOf("adsStep('incidents'") > src.indexOf('flushOutbox(env)'), 'incidents after the outbox flush')
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

// ---------- Control Center experience: vocabulary, triage, investigation (read side) ----------
test('integration states are evidence-based: credentials alone are never healthy; disabled is never failed', () => {
  const s = (mode, health, extra = {}) => integrationState({ mode, health, ...extra })
  assert.equal(s('disabled', 'not_applicable'), 'disabled')
  assert.equal(s('disabled', 'failing'), 'disabled', 'switched off on purpose is not a failure')
  assert.equal(s('missing', 'not_applicable'), 'setup_required')
  assert.equal(s('live', 'unknown'), 'unknown', 'configured + live but no evidence = not verified')
  assert.equal(s('live', 'healthy'), 'healthy')
  assert.equal(s('live', 'degraded'), 'degraded')
  assert.equal(s('live', 'failing'), 'failed')
  assert.equal(s('sandbox', 'unknown'), 'testing')
  assert.equal(s('sandbox', 'failing'), 'failed')
  assert.equal(integrationState(null), 'unknown')
  assert.equal(INTEGRATION_STATES.unknown.label, 'Not verified')
})

test('incident phases: quiet ≠ recovered; only a recorded success (or reconnect) is a recovery', () => {
  const base = { status: 'open', lastSeen: NOW - 2 * 3600000, severity: 'medium' }
  assert.equal(incidentPhase(base, NOW), 'active')
  assert.equal(incidentPhase({ ...base, lastSeen: NOW - 3 * DAY }, NOW), 'quiet')
  assert.match(withPhase({ ...base, lastSeen: NOW - 3 * DAY }, NOW).phaseLabel, /No new failures for 3 days · awaiting verification/)
  assert.equal(incidentPhase({ status: 'resolved', resolution: 'success_seen' }, NOW), 'recovered')
  assert.equal(incidentPhase({ status: 'resolved', resolution: 'connected' }, NOW), 'recovered')
  assert.equal(incidentPhase({ status: 'resolved', resolution: 'no_new_failures' }, NOW), 'closed_unverified')
  assert.match(withPhase({ status: 'resolved', resolution: 'no_new_failures' }, NOW).phaseLabel, /not confirmed fixed/)
  // Triage: a real customer's critical/high problem is never "monitor".
  assert.equal(triage({ severity: 'critical', customer: 'alpha', test: false }).action, 'act')
  assert.equal(triage({ severity: 'medium', customer: 'alpha', test: false }).action, 'act')
  assert.equal(triage({ severity: 'critical', customer: 'alpha', test: true }).action, 'monitor')
  assert.equal(triage({ severity: 'medium', customer: null, test: false }).action, 'monitor')
  assert.equal(triage({ severity: 'high', customer: null, test: false }).action, 'act')
})

test('platform-wide incident: plain title, platform next step (never "this business"), listed in Needs attention with a reason; detail = history + events + no contact data', async () => {
  await recordEvent(db, { type: 'sms.webhook_rejected', actor: 'system:twilio', capability: 'followups.sms_inbound', resource: { type: 'webhook', id: 'inbound' }, outcome: 'failure', details: { reason: 'bad_signature', note: 'lee.secret@example.net' }, at: NOW - MIN })
  await syncIncidents(env, NOW)
  const [i] = await listIncidents(db, { status: 'open' })
  assert.equal(i.scope, 'platform')
  assert.equal(i.title, 'Text-message webhook refused a request')
  assert.equal(i.featureName, 'Incoming text messages')
  assert.doesNotMatch(`${i.next} ${i.impact}`, /this business|for this account/)
  assert.match(i.next, /Twilio Console/)
  const o = await controlOverview(env, NOW)
  assert.ok(!o.nextActions.some((a) => a.incident === i.id), 'medium platform incident is not a "next action" (old behaviour)')
  const att = o.attention.find((a) => a.id === i.id)
  assert.ok(att, 'but it IS in Needs attention: never "nothing needs action" while something is open')
  assert.equal(att.action, 'monitor')
  assert.match(att.why, /Platform-wide/)
  assert.equal(att.phase, 'active')
  const d = await incidentDetail(db, i.id, NOW) // the frozen clock, so the phase stays "active" whenever the test runs
  assert.equal(d.incident.id, i.id)
  assert.equal(d.incident.phase, 'active')
  assert.deepEqual(d.history.map((h) => h.action), ['incident.opened'])
  assert.deepEqual(d.events.map((e) => [e.action, e.outcome, e.code]), [['sms.webhook_rejected', 'failure', 'bad_signature']])
  assert.equal(d.lastSuccess, null)
  assert.doesNotMatch(JSON.stringify(d), /lee\.secret/)
  assert.equal(await incidentDetail(db, 'inc_nope000000'), null)
})

test('account incident detail links recovery evidence; account readiness never calls "connected" working without a recorded success', async () => {
  await failSeq('alpha', 'reconnect_required', [NOW - MIN])
  await syncIncidents(env, NOW)
  const [inc] = await listIncidents(db, { customer: 'alpha', status: 'open' })
  assert.equal(inc.title, 'Google Calendar connection broken')
  assert.equal(inc.scope, 'account')
  const a = await inspectAccount(env, 'alpha', NOW)
  assert.equal(typeof a.website.hosting, 'string', 'hosting is a status, never [object Object]')
  const r = Object.fromEntries(a.readiness.map((x) => [x.id, x.state]))
  assert.equal(r.calendar, 'failed')
  assert.equal(r.booking, 'failed')
  assert.equal(r.messages, 'test_mode')
  assert.equal(r.voice, 'disabled')
  assert.ok(a.incidents[0].phaseLabel)
  assert.ok(a.journey.steps.filter((s) => s.reason === 'legacy_setup').every((s) => /created before self-serve/.test(s.reasonText)))
  // Pure readiness: connected but no lookup = configured (not verified); a success = verified.
  const base = { incidents: [], calendar: { connected: true, lastLookup: null }, booking: { ready: true, reasons: [] }, website: { live: false, hosting: 'active' }, communications: { gate: 'test_only', sent7: 0, failed7: 0, skipped7: 0 }, voice: { status: 'testing', receptionist: false }, billing: { selfServe: false } }
  assert.equal(accountReadiness(base).find((x) => x.id === 'calendar').state, 'configured')
  assert.equal(accountReadiness({ ...base, calendar: { connected: true, lastLookup: { outcome: 'success', at: NOW } } }).find((x) => x.id === 'calendar').state, 'verified')
  assert.equal(accountReadiness(base).find((x) => x.id === 'voice').state, 'not_applicable')
})

test('incident route: ?id is admin-only, validated, 404 when unknown; overview carries integration states and pending approvals', async () => {
  await recordEvent(db, { type: 'booking.failed', actor: 'system:booking', customer: 'beta', capability: 'calendar.google', resource: { type: 'business', id: 'beta' }, outcome: 'failure', details: { error: 'calendar_error' }, at: NOW - MIN })
  await syncIncidents(env, NOW)
  const [i] = await listIncidents(db, { status: 'open' })
  const admin = await cookie('founder@getshowups.example')
  const owner = await cookie('owner@alpha.example')
  assert.equal((await call(incidentsRoute, 'GET', `/api/platform/incidents?id=${i.id}`)).status, 401)
  assert.equal((await call(incidentsRoute, 'GET', `/api/platform/incidents?id=${i.id}`, { c: owner })).status, 403)
  assert.equal((await call(incidentsRoute, 'GET', '/api/platform/incidents?id=../x', { c: admin })).status, 400)
  assert.equal((await call(incidentsRoute, 'GET', '/api/platform/incidents?id=inc_unknown000', { c: admin })).status, 404)
  const ok = await call(incidentsRoute, 'GET', `/api/platform/incidents?id=${i.id}`, { c: admin })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.incident.customer, 'beta')
  assert.match(ok.json.incident.next, /Open the account/)
  const o = (await call(controlRoute, 'GET', '/api/platform/control', { c: admin })).json
  assert.ok(o.integrations.every((c) => c.state in INTEGRATION_STATES && c.stateLabel && c.tone))
  assert.ok(o.integrations.every((c) => !/\.js\)/.test(c.description || '')), 'no source file paths in descriptions')
  assert.ok(Array.isArray(o.approvals))
  assert.ok(o.businesses.every((b) => Array.isArray(b.labels) && typeof b.affected === 'boolean'))
  assert.equal(o.businesses.find((b) => b.id === 'beta').affected, true)
})
