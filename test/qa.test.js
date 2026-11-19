// Control Center B2: automated QA run ingestion (bounded, redacted, mocked vs real), guided human QA (same journey ids,
// server-side step times, defects vs improvements), activation measured only from finished observer runs, retest
// history, retention, admin-only routes. Real handlers + migrations on node:sqlite.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { addFinding, finishHumanRun, ingestAutomatedRun, purgeQa, qaOverview, recordStep, redact, runDetail, startHumanRun, testHistory } from '../server/ops/qa.js'
import * as ingestRoute from '../functions/api/qa/runs.js'
import * as qaRoute from '../functions/api/platform/qa.js'
import * as controlRoute from '../functions/api/platform/control.js'

const ORIGIN = 'https://getshowups.com'
const MIN = 60000
const DAY = 86400000
const NOW = Date.UTC(2026, 10, 20, 15, 5)
const TOKEN = 'qa-ingest-token-not-a-secret-0123456789abcdef'
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
  return { sql, prepare: (q) => stmt(q) }
}
let env, db, origError
beforeEach(() => {
  db = d1()
  origError = console.error
  console.error = () => {}
  env = { ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async () => null }, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/x`, TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_API_TOKEN: 'a'.repeat(40), PLATFORM_ADMIN_EMAILS: 'founder@getshowups.example', QA_INGEST_TOKEN: TOKEN }
})
afterEach(() => { console.error = origError })

const REPORT = {
  revision: 'abcdef1234567',
  source: 'ci',
  provider: 'mocked',
  artifactsUrl: 'https://github.com/florasummit/getshowups/actions/runs/123',
  results: [
    { file: 'test/e2e/booking.spec.js', title: 'lead books a real appointment; owner sees it', project: 'desktop', status: 'passed', durationMs: 1200 },
    { file: 'test/e2e/booking.spec.js', title: 'the same slot cannot be booked twice', project: 'desktop', status: 'failed', durationMs: 900, error: '\u001b[31mExpected 409\u001b[0m for lee.secret@example.net token e2eSessionTokenForPrimaryCustomer0000000001 call 843-555-0101' },
    { file: 'test/e2e/site.spec.js', title: 'an unregistered passing test', project: 'desktop', status: 'passed' },
    { file: 'test/e2e/site.spec.js', title: 'an unregistered failing test', project: 'mobile', status: 'failed', error: 'boom' },
    { file: 'test/e2e/site.spec.js', title: 'skipped one', status: 'skipped' },
  ],
}

test('automated ingest: registered tests + failures only, redacted errors, counts, run status; mocked vs real recorded', async () => {
  const r = await ingestAutomatedRun(db, REPORT, NOW)
  assert.equal(r.status, 'failed')
  assert.deepEqual(r.counts, { pass: 2, fail: 2, blocked: 0, not_tested: 1, total: 5 })
  assert.equal(r.stored, 3) // 2 linked booking tests + the unlinked failure; unlinked passes/skips are not stored
  const d = await runDetail(db, r.id)
  assert.equal(d.run.provider, 'mocked')
  assert.equal(d.run.artifactsUrl, REPORT.artifactsUrl)
  const failed = d.results.find((x) => x.test_id.startsWith('booking:booking:the-same-slot'))
  assert.equal(failed.status, 'fail')
  assert.equal(failed.journey, 'booking')
  assert.equal(failed.observed, 'Expected 409 for [email] token [token] call [phone]')
  assert.ok(d.results.some((x) => x.test_id.startsWith('unlinked:site:an-unregistered-failing') && x.test_id.endsWith('@mobile')))
  // Invalid input is refused; a forged artifacts URL is dropped.
  assert.deepEqual(await ingestAutomatedRun(db, { ...REPORT, source: 'prod' }, NOW), { error: 'invalid_request' })
  assert.deepEqual(await ingestAutomatedRun(db, { ...REPORT, provider: 'live' }, NOW), { error: 'invalid_request' })
  const forged = await ingestAutomatedRun(db, { ...REPORT, artifactsUrl: 'https://evil.example/x' }, NOW)
  assert.equal((await runDetail(db, forged.id)).run.artifactsUrl, null)
  // Related incidents: an open incident on a feature the failed journey uses (booking → calendar.google); not others.
  assert.deepEqual(d.related, [])
  for (const [id, feature] of [['inc_a', 'calendar.google'], ['inc_b', 'ads.google']]) {
    db.sql.prepare("INSERT INTO ops_incidents (id, fingerprint, customer, feature, journey, step, kind, code, severity, cause, status, evidence, first_seen, last_seen, detected_at) VALUES (?, ?, 'x', ?, 'booking', 'availability', 'failure', 'c', 'high', 'unknown', 'open', '{}', 1, 1, 1)").run(id, id, feature)
  }
  assert.deepEqual((await runDetail(db, r.id)).related.map((i) => i.id), ['inc_a'])
})

test('failed journeys and retest history follow the latest automated result per test', async () => {
  await ingestAutomatedRun(db, REPORT, NOW)
  let o = await qaOverview(db, NOW)
  assert.deepEqual(o.failedJourneys, ['booking'])
  const fixed = { ...REPORT, results: REPORT.results.map((x) => ({ ...x, status: 'passed', error: null })) }
  const r2 = await ingestAutomatedRun(db, { ...fixed, revision: 'bbbbbbb1234' }, NOW + MIN)
  o = await qaOverview(db, NOW + MIN)
  assert.deepEqual(o.failedJourneys, [])
  assert.equal(o.automated[0].id, r2.id)
  const t = (await runDetail(db, r2.id)).results.find((x) => x.test_id.startsWith('booking:booking:the-same-slot')).test_id
  const h = await testHistory(db, t)
  assert.deepEqual(h.map((x) => x.status), ['pass', 'fail'])
  assert.deepEqual(h.map((x) => x.revision), ['bbbbbbb1234', 'abcdef1234567'])
})

test('guided human QA: same journey ids, server-side step times for timed journeys, defects vs improvements, finish summary; activation measured only when finished', async () => {
  assert.equal((await qaOverview(db, NOW)).activation.measured, false)
  assert.deepEqual(await startHumanRun(db, { journey: 'nope', testerEmail: 'founder@getshowups.example' }, NOW), { error: 'invalid_journey' })
  const { id } = await startHumanRun(db, { journey: 'activation', customer: 'e2e-cc', testerEmail: 'founder@getshowups.example' }, NOW)
  assert.equal(db.sql.prepare('SELECT tester FROM qa_runs WHERE id = ?').get(id).tester.startsWith('ref:'), true)
  assert.deepEqual(await recordStep(db, { run: id, step: 'nope', status: 'pass' }, NOW), { error: 'invalid_step' })
  assert.deepEqual(await recordStep(db, { run: id, step: 'offer', status: 'great' }, NOW), { error: 'invalid_status' })
  assert.deepEqual(await recordStep(db, { run: id, step: 'offer', status: 'pass', observed: 'Read it, clear. Call me at 843-555-0101', answers: { 0: 'yes', 1: 'no hesitation', x: 'dropped' } }, NOW + 2 * MIN), { ok: true, ms: 2 * MIN })
  assert.deepEqual(await recordStep(db, { run: id, step: 'start', status: 'pass' }, NOW + 5 * MIN), { ok: true, ms: 3 * MIN })
  assert.deepEqual(await recordStep(db, { run: id, step: 'calendar', status: 'fail', observed: 'Unverified-app screen stopped them' }, NOW + 12 * MIN), { ok: true, ms: 7 * MIN })
  assert.ok((await addFinding(db, { run: id, step: 'calendar', type: 'defect', severity: 'high', text: 'Google warning scared the tester (mail tester@example.org)' }, NOW + 12 * MIN)).id)
  assert.ok((await addFinding(db, { run: id, step: 'offer', type: 'improvement', text: 'Show the price earlier' }, NOW + 12 * MIN)).id)
  assert.deepEqual(await addFinding(db, { run: id, type: 'bug', text: 'x' }, NOW), { error: 'invalid_type' })
  assert.deepEqual(await addFinding(db, { run: id, type: 'defect', text: '   ' }, NOW), { error: 'text_required' })
  const fin = await finishHumanRun(db, { run: id }, NOW + 25 * MIN)
  assert.equal(fin.status, 'failed')
  assert.equal(fin.summary.totalMs, 25 * MIN)
  assert.equal(fin.summary.targetMinutes, 20)
  assert.deepEqual(fin.summary.splits, { offer: 2 * MIN, start: 3 * MIN, calendar: 7 * MIN })
  assert.equal(fin.summary.not_tested, 6)
  assert.deepEqual(await recordStep(db, { run: id, step: 'hours', status: 'pass' }, NOW + 26 * MIN), { error: 'run_finished' })
  const d = await runDetail(db, id)
  assert.equal(d.results.find((x) => x.step === 'offer').observed, 'Read it, clear. Call me at [phone]')
  assert.deepEqual(d.results.find((x) => x.step === 'offer').answers, { 0: 'yes', 1: 'no hesitation' })
  assert.deepEqual(d.findings.map((f) => [f.type, f.severity]), [['defect', 'high'], ['improvement', null]])
  assert.match(d.findings[0].text, /\[email\]/)
  const o = await qaOverview(db, NOW + 26 * MIN)
  assert.deepEqual(o.activation, { measured: true, runs: 1, latest: { id, status: 'failed', totalMinutes: 25, targetMinutes: 20, provider: 'mocked', finishedAt: NOW + 25 * MIN } })
})

test('ingest validation + replay protection: same run key or same body stored once; stale and malformed reports refused; size checked on received bytes', async () => {
  const a = await ingestAutomatedRun(db, { ...REPORT, runKey: 'gh:42:1' }, NOW)
  const again = await ingestAutomatedRun(db, { ...REPORT, runKey: 'gh:42:1', results: [] }, NOW + MIN)
  assert.deepEqual([again.duplicate, again.id], [true, a.id])
  const retry = await ingestAutomatedRun(db, { ...REPORT, runKey: 'gh:42:2' }, NOW)
  assert.notEqual(retry.id, a.id) // a re-run attempt is a new run
  const h1 = await ingestAutomatedRun(db, REPORT, NOW, { bodyHash: 'f'.repeat(64) })
  const h2 = await ingestAutomatedRun(db, REPORT, NOW, { bodyHash: 'f'.repeat(64) })
  assert.deepEqual([h2.duplicate, h2.id], [true, h1.id])
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM qa_runs WHERE kind = 'automated'").get().n, 3)
  assert.deepEqual(await ingestAutomatedRun(db, { ...REPORT, startedAt: NOW - 8 * DAY }, NOW), { error: 'stale_report' })
  assert.deepEqual(await ingestAutomatedRun(db, { ...REPORT, runKey: 'bad key!' }, NOW), { error: 'invalid_request' })
  assert.deepEqual(await ingestAutomatedRun(db, { ...REPORT, results: [{ file: 1, title: 'x' }] }, NOW), { error: 'invalid_request' })
  assert.deepEqual(await ingestAutomatedRun(db, { ...REPORT, results: [{ file: 'a', title: 'x'.repeat(501) }] }, NOW), { error: 'invalid_request' })
  // Route: replay → 200 duplicate; invalid JSON → 400; a large body without Content-Length → 413.
  const send = async (raw, headers = {}) => {
    const res = await ingestRoute.onRequestPost({ request: new Request(`${ORIGIN}/api/qa/runs`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, ...headers }, body: raw }), env })
    return { status: res.status, json: await res.json() }
  }
  const raw = JSON.stringify(REPORT)
  assert.equal((await send(raw)).status, 201)
  const dup = await send(raw)
  assert.deepEqual([dup.status, dup.json.duplicate], [200, true])
  assert.equal((await send('{not json')).status, 400)
  const big = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"x":"${'a'.repeat(2_100_000)}"}`)); c.close() } })
  const res = await ingestRoute.onRequestPost({ request: new Request(`${ORIGIN}/api/qa/runs`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: big, duplex: 'half' }), env })
  assert.equal(res.status, 413)
})

test('no CI data and no activation run yet: overview and QA views answer with honest empty states', async () => {
  const admin = await cookie('founder@getshowups.example')
  const ov = await controlRoute.onRequestGet({ request: req('/api/platform/control', { c: admin }), env })
  assert.equal(ov.status, 200)
  const o = await ov.json()
  assert.deepEqual(o.qa, { automated: [], human: [], failedJourneys: [] })
  assert.deepEqual(o.activation, { measured: false, runs: 0 })
  assert.equal(o.incidents.open, 0)
  const q = await (await qaRoute.onRequestGet({ request: req('/api/platform/qa', { c: admin }), env })).json()
  assert.deepEqual([q.available, q.automated, q.human, q.activation.measured], [true, [], [], false])
  // An unfinished activation run is not a measurement.
  await startHumanRun(db, { journey: 'activation', testerEmail: 'founder@getshowups.example' }, NOW)
  assert.equal((await qaOverview(db, NOW + MIN)).activation.measured, false)
})

test('redact: emails, phones, long tokens, ANSI and control characters; length cap', () => {
  assert.equal(redact('a\u0007b \u001b[1mX\u001b[0m x@y.co +1 (843) 555-0101 Bearer abcdefghijklmnopqrstuvwxyz0123456789'), 'ab X [email] [phone] [token]')
  assert.equal(redact('word '.repeat(200)).length, 500)
})

test('retention: automated runs after 90 days, human runs after 365 days (results + findings with them)', async () => {
  const a = await ingestAutomatedRun(db, REPORT, NOW - 91 * DAY)
  const { id: h } = await startHumanRun(db, { journey: 'booking', testerEmail: 'founder@getshowups.example' }, NOW - 100 * DAY)
  await addFinding(db, { run: h, type: 'improvement', text: 'x' }, NOW - 100 * DAY)
  db.sql.prepare('UPDATE qa_runs SET started_at = ? WHERE id = ?').run(NOW - 91 * DAY, a.id)
  assert.deepEqual(await purgeQa(db, NOW), { ready: true, purged: 1 })
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM qa_results WHERE run_id = ?').get(a.id).n, 0)
  assert.ok(await runDetail(db, h))
  db.sql.exec('DROP TABLE qa_results; DROP TABLE qa_findings; DROP TABLE qa_runs')
  assert.deepEqual(await purgeQa(db, NOW), { ready: false })
  assert.equal(await qaOverview(db, NOW), null)
})

async function cookie(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
const req = (path, { method = 'GET', c, body, origin = ORIGIN, auth } = {}) =>
  new Request(ORIGIN + path, { method, headers: { ...(c ? { Cookie: c } : {}), ...(auth ? { Authorization: auth } : {}), ...(body ? { 'Content-Type': 'application/json', Origin: origin } : {}) }, body: body ? JSON.stringify(body) : undefined })

test('routes: ingest needs the bearer token (off when unset); QA API is admin-only, same-origin for writes, audited', async () => {
  const post = async (opts) => {
    const res = await ingestRoute.onRequestPost({ request: req('/api/qa/runs', { method: 'POST', body: REPORT, ...opts }), env })
    return { status: res.status, json: await res.json() }
  }
  assert.equal((await post({ auth: 'Bearer wrong-token-wrong-token-wrong-token-00' })).status, 401)
  assert.equal((await post({})).status, 401)
  const ok = await post({ auth: `Bearer ${TOKEN}` })
  assert.equal(ok.status, 201)
  assert.equal(ok.json.status, 'failed')
  const off = { ...env, QA_INGEST_TOKEN: undefined }
  assert.equal((await ingestRoute.onRequestPost({ request: req('/api/qa/runs', { method: 'POST', body: REPORT, auth: `Bearer ${TOKEN}` }), env: off })).status, 503)

  const admin = await cookie('founder@getshowups.example')
  const owner = await cookie('owner@alpha.example')
  const get = async (path, c) => {
    const res = await qaRoute.onRequestGet({ request: req(path, { c }), env })
    return { status: res.status, json: await res.json() }
  }
  const write = async (body, c, origin) => {
    const res = await qaRoute.onRequestPost({ request: req('/api/platform/qa', { method: 'POST', c, body, origin }), env })
    return { status: res.status, json: await res.json() }
  }
  assert.equal((await get('/api/platform/qa')).status, 401)
  assert.equal((await get('/api/platform/qa', owner)).status, 403)
  const o = await get('/api/platform/qa', admin)
  assert.equal(o.status, 200)
  assert.equal(o.json.available, true)
  assert.equal(o.json.journeys.find((j) => j.id === 'activation').timed, true)
  assert.equal((await write({ action: 'start', journey: 'booking' }, owner)).status, 403)
  assert.equal((await write({ action: 'start', journey: 'booking' }, admin, 'https://evil.example')).status, 403)
  assert.equal((await write({ action: 'start', journey: 'booking', customer: '../x' }, admin)).status, 400)
  assert.equal((await write({ action: 'explode' }, admin)).status, 400)
  const s = await write({ action: 'start', journey: 'booking', customer: 'e2e-cc' }, admin)
  assert.equal(s.status, 200)
  assert.equal((await write({ action: 'step', run: s.json.id, step: 'page', status: 'pass' }, admin)).status, 200)
  assert.equal((await write({ action: 'step', run: 'qh_missing', step: 'page', status: 'pass' }, admin)).status, 404)
  assert.equal((await write({ action: 'finish', run: s.json.id }, admin)).status, 200)
  assert.equal((await write({ action: 'finish', run: s.json.id }, admin)).status, 409)
  assert.deepEqual(db.sql.prepare("SELECT action FROM admin_audit WHERE action LIKE 'qa.%' ORDER BY id").all().map((r) => r.action), ['qa.human_run_started', 'qa.human_run_finished'])
  // Before migration 0032: reads say not available, writes 503.
  db.sql.exec('DROP TABLE qa_results; DROP TABLE qa_findings; DROP TABLE qa_runs')
  assert.deepEqual((await get('/api/platform/qa', admin)).json, { available: false })
  assert.equal((await write({ action: 'start', journey: 'booking' }, admin)).status, 503)
  assert.equal((await post({ auth: `Bearer ${TOKEN}` })).status, 503)
})
