// QA Command Center (migration 0051, server/ops/qa-*.js, /api/platform/qa/*): permissions, append-only history,
// executions (plan → run → dispatch / production cron / manual), dedupe, bounded retries + recovery, the QA budget
// (refused at $0, atomic reservations, settled to reported costs), freshness rules, defect verification only from a
// later passing result, backlog never auto-advanced, redacted evidence with retention, read-only production checks.
// Real handlers + every migration on node:sqlite; GitHub is a stubbed fetch (no network).
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { allTests } from '../server/ops/qa-tests.js'
import { statusOf, resetHashCache, freshness } from '../server/ops/qa-freshness.js'
import { qaCron, START_TIMEOUT_MS, RUN_TIMEOUT_MS } from '../server/ops/qa-executions.js'
import { ingestReport } from '../server/ops/qa-ingest.js'
import { purgeEvidence, redactEvidence } from '../server/ops/qa-evidence.js'
import { resetSettingsCache } from '../server/ai-budget.js'
import * as overviewRoute from '../functions/api/platform/qa/overview.js'
import * as inventoryRoute from '../functions/api/platform/qa/inventory.js'
import * as testRoute from '../functions/api/platform/qa/tests/[id].js'
import * as planRoute from '../functions/api/platform/qa/plan.js'
import * as runRoute from '../functions/api/platform/qa/run.js'
import * as cancelRoute from '../functions/api/platform/qa/cancel.js'
import * as executionsRoute from '../functions/api/platform/qa/executions.js'
import * as executionRoute from '../functions/api/platform/qa/executions/[id].js'
import * as resultRoute from '../functions/api/platform/qa/result.js'
import * as itemsRoute from '../functions/api/platform/qa/items.js'
import * as itemRoute from '../functions/api/platform/qa/items/[id].js'
import * as promptRoute from '../functions/api/platform/qa/items/[id]/prompt.js'
import * as settingsRoute from '../functions/api/platform/qa/settings.js'
import * as evidenceRoute from '../functions/api/platform/qa/evidence.js'
import * as evidenceGetRoute from '../functions/api/platform/qa/evidence/[id].js'
import * as importRoute from '../functions/api/platform/qa/import.js'
import * as ingestRoute from '../functions/api/qa/runs.js'
import * as legacyQaRoute from '../functions/api/platform/qa.js'

const ORIGIN = 'https://getshowups.com'
const DAY = 86_400_000
const ADMIN = 'founder@getshowups.example'
const INGEST = 'qa-ingest-token-not-a-secret-0123456789abcdef'
const DISPATCH = 'github_pat_FAKE_not_a_real_token_0000'
const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url)).sort()

function d1(files = MIGRATIONS) {
  const sql = new DatabaseSync(':memory:')
  for (const f of files) sql.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const stmt = (q, args = []) => ({
    q, args,
    bind: (...a) => stmt(q, a),
    first: async () => sql.prepare(q).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(q).all(...args) }),
    run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }),
  })
  return { sql, prepare: (q) => stmt(q), batch: async (list) => { sql.exec('BEGIN'); try { const r = list.map((s) => ({ meta: { changes: Number(sql.prepare(s.q).run(...s.args).changes) } })); sql.exec('COMMIT'); return r } catch (e) { sql.exec('ROLLBACK'); throw e } } }
}
const build = { commit: COMMIT, builtAt: '2026-11-27T10:00:00.000Z', migrations: MIGRATIONS.map((file) => ({ file, tables: [...readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]) })) }
let hashes
const assets = () => ({ fetch: async (r) => { const p = new URL(r.url).pathname; return p === '/build.json' ? Response.json(build) : p === '/qa-hashes.json' ? (hashes ? Response.json(hashes) : new Response('<html>', { status: 200 })) : new Response('<html>', { status: 200 }) } })

let env, db, origError, origFetch, fetches
beforeEach(() => {
  db = d1()
  hashes = { commit: COMMIT, hashes: {} }
  resetHashCache()
  resetSettingsCache()
  origError = console.error
  console.error = () => {}
  origFetch = globalThis.fetch
  fetches = []
  globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), init })
    if (String(url).endsWith('/dispatches')) return new Response(null, { status: 204 })
    if (String(url).endsWith('/cancel')) return new Response('{}', { status: 202 })
    throw new Error('unexpected network call')
  }
  env = { ONBOARDING_DB: db, ASSETS: assets(), GOOGLE_TOKENS: { get: async () => null }, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_API_TOKEN: 'a'.repeat(40), PLATFORM_ADMIN_EMAILS: ADMIN }
})
afterEach(() => {
  console.error = origError
  globalThis.fetch = origFetch
})

async function cookie(email) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR IGNORE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now(), Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function call(mod, method, path, { body, c, origin = ORIGIN, auth, params } = {}) {
  const request = new Request(ORIGIN + path, { method, headers: { ...(c ? { Cookie: c } : {}), ...(auth ? { Authorization: auth } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: origin } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
  const res = await mod[method === 'GET' ? 'onRequestGet' : 'onRequestPost']({ request, env, params: params || {}, waitUntil: () => {} })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text, res }
}
const admin = () => cookie(ADMIN)
const T = (pred) => allTests().list.find(pred)
const unitTests = (file) => allTests().list.filter((t) => t.kind === 'unit' && t.file === file)
const count = (table) => db.sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n
const tablesSnapshot = () => Object.fromEntries(db.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'qa\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => [name, JSON.stringify(db.sql.prepare(`SELECT * FROM "${name}"`).all())]))

// ---------- permissions ----------
test('admin only: signed out 401, a customer 403, cross-site POST 403; before 0051 the routes say not available', async () => {
  assert.equal((await call(overviewRoute, 'GET', '/api/platform/qa/overview')).status, 401)
  assert.equal((await call(overviewRoute, 'GET', '/api/platform/qa/overview', { c: await cookie('owner@business.example') })).status, 403)
  const c = await admin()
  assert.equal((await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, origin: 'https://evil.example', body: { action: 'create', kind: 'feature', title: 'x' } })).status, 403)
  assert.equal((await call(runRoute, 'POST', '/api/platform/qa/run', { c, origin: 'https://evil.example', body: { preset: 'production_verify', confirm: true } })).status, 403)
  for (const [mod, path] of [[planRoute, '/api/platform/qa/plan'], [resultRoute, '/api/platform/qa/result'], [settingsRoute, '/api/platform/qa/settings'], [evidenceRoute, '/api/platform/qa/evidence'], [importRoute, '/api/platform/qa/import'], [cancelRoute, '/api/platform/qa/cancel']]) {
    assert.equal((await call(mod, 'POST', path, { body: {} })).status, 401, path)
  }
  db = d1(MIGRATIONS.filter((f) => f < '0051'))
  env.ONBOARDING_DB = db
  const c2 = await admin()
  const r = await call(overviewRoute, 'GET', '/api/platform/qa/overview', { c: c2 })
  assert.equal(r.status, 503)
  assert.equal(r.json.available, false)
  // The Testing tab and the CI ingest keep working exactly as before 0051.
  assert.equal((await call(legacyQaRoute, 'GET', '/api/platform/qa', { c: c2 })).json.available, true)
  env.QA_INGEST_TOKEN = INGEST
  const ing = await call(ingestRoute, 'POST', '/api/qa/runs', { auth: `Bearer ${INGEST}`, body: { revision: 'abcdef1', source: 'ci', provider: 'mocked', results: [{ file: 'test/e2e/booking.spec.js', title: 'the same slot cannot be booked twice', status: 'failed', error: 'x' }] } })
  assert.equal(ing.status, 201)
  assert.equal(ing.json.qa, undefined)
})

test('history is append-only: results, execution events and item events refuse UPDATE and DELETE', async () => {
  const c = await admin()
  const t = T((x) => x.kind === 'human')
  await call(resultRoute, 'POST', '/api/platform/qa/result', { c, body: { testId: t.id, status: 'fail', actual: 'broken', confirm: true } })
  await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'create', kind: 'bug', title: 'Broken' } })
  await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { preset: 'production_verify', confirm: true } })
  for (const table of ['qa_test_results', 'qa_execution_events', 'qa_item_events']) {
    assert.ok(count(table) > 0, table)
    assert.throws(() => db.sql.exec(`UPDATE ${table} SET at = 0`), /append-only/, table)
    assert.throws(() => db.sql.exec(`DELETE FROM ${table}`), /append-only/, table)
  }
})

// ---------- production verification ----------
// The production origin stand-in (loopback, like the other *_MOCK_ORIGIN): answers what the real edge answers.
const EDGE = 'http://127.0.0.1:9932'
function edgeStub(over = {}) {
  globalThis.fetch = async (url, init = {}) => {
    fetches.push({ url: String(url), init })
    const u = new URL(String(url))
    if (u.origin !== EDGE) throw new Error('unexpected network call')
    const route = { '/build.json': () => Response.json(build), '/dashboard': () => new Response('<html>', { headers: { 'X-Frame-Options': 'DENY' } }), '/': () => new Response('<html>'), '/api/dashboard/me': () => Response.json({ error: 'unauthenticated' }, { status: 401 }), '/api/platform/me': () => Response.json({}, { status: 401 }), '/api/platform/qa/overview': () => Response.json({}, { status: 401 }), '/api/admin/google-health': () => Response.json({}, { status: 401 }), '/p/qa-test-pools': () => new Response('<html>'), '/book/qa-test-pools': () => new Response('<html>'), ...over }[u.pathname]
    return route ? route() : new Response('not found', { status: 404 })
  }
}
const markTestBusiness = () => {
  db.sql.prepare("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('qa-test-pools', 'QA Test Pools', 'UTC', 1, 1)").run()
  db.sql.prepare("INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('qa-test-pools', 1, 'ref:x', 1)").run()
  db.sql.prepare("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES ('poolthru-llc', 'PoolThru', 'UTC', 1, 1)").run()
}

test('production verification: queued by a click, run by the cron in bounded batches through the edge, read-only outside QA tables', async () => {
  const c = await admin()
  env.QA_PRODUCTION_ORIGIN = EDGE
  edgeStub()
  markTestBusiness()
  const plan = await call(planRoute, 'POST', '/api/platform/qa/plan', { c, body: { preset: 'production_verify' } })
  assert.equal(plan.status, 200)
  assert.equal(plan.json.environment, 'production')
  assert.equal(plan.json.runnable, true)
  assert.equal(plan.json.estimate.usdMicros, 0)
  assert.equal(plan.json._tests, undefined, 'internal scope never leaves the server')
  const total = plan.json.scope.tests
  assert.ok(total > 50)
  assert.equal(count('qa_executions'), 0, 'planning has no side effects')
  const run = await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { preset: 'production_verify', confirm: true, planId: plan.json.planId } })
  assert.equal(run.status, 201)
  assert.equal(run.json.execution.status, 'queued')
  // The same scope can't run twice at once.
  assert.equal((await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { preset: 'production_verify', confirm: true } })).json.error, 'already_running')
  const before = tablesSnapshot()
  let rounds = 0
  while (rounds++ < 10) {
    const r = await qaCron(env)
    if (!r.production) break
    assert.ok(r.production <= 25, 'bounded per cron run')
  }
  delete before.admin_audit
  delete before.audit_log
  const after = tablesSnapshot()
  delete after.admin_audit
  delete after.audit_log
  assert.deepEqual(after, before, 'nothing outside QA tables changed')
  assert.ok(fetches.length > 0 && fetches.every((f) => f.url.startsWith(EDGE) && (f.init.method || 'GET') === 'GET' && f.init.headers['User-Agent'] === 'GetShowUps-QA'), 'GET only, to the production origin, labelled')
  assert.ok(!fetches.some((f) => /poolthru|getshowups\/|\/api\/book\//.test(f.url)), 'never a real customer, never a times lookup')
  const d = await call(executionRoute, 'GET', `/api/platform/qa/executions/${run.json.execution.id}`, { c, params: { id: run.json.execution.id } })
  assert.equal(d.json.execution.progress.done, total)
  assert.ok(['passed', 'partial', 'failed'].includes(d.json.execution.status))
  const byId = Object.fromEntries(d.json.results.map((r) => [r.testId, r]))
  for (const id of ['prod:build-commit', 'prod:edge-headers', 'prod:homepage', 'prod:migrations', 'prod:qa-hashes', 'prod:dashboard-signed-out', 'prod:platform-signed-out', 'prod:qa-signed-out', 'prod:admin-api-unauthorized', 'prod:test-site', 'prod:test-booking-page']) assert.equal(byId[id]?.status, 'pass', `${id}: ${byId[id]?.actual}`)
  assert.match(byId['prod:test-site'].actual, /qa-test-pools/)
  // POST refusals are never sent to the edge: in process, labelled, never "verified".
  for (const id of ['prod:write-signed-out', 'prod:chat-cross-site']) {
    assert.equal(byId[id].status, 'unverified')
    assert.match(byId[id].actual, /^in-process, not through the edge: HTTP 40[13] as expected/)
  }
  assert.equal(d.json.execution.progress.mode, 'edge')
  assert.equal(d.json.execution.progress.rateLimitRows, 1, 'the site view is the one rate-limited request')
  assert.equal(byId['prod:cron-heartbeat'].status, 'blocked', 'no cron run recorded yet: blocked, never a fake pass')
  assert.ok(d.json.results.every((r) => r.environment === 'production' && r.revision === COMMIT))
  // A switched-off capability is skipped with its reason, never failed.
  assert.equal(byId['prod:cap:billing.stripe'].status, 'skipped')
  // Freshness: production checks are verified on this deployment.
  const ov = await call(overviewRoute, 'GET', '/api/platform/qa/overview', { c })
  assert.equal(ov.json.production.commit, COMMIT)
  assert.ok(ov.json.counts.verified >= 11)
  assert.equal(ov.json.counts.total, allTests().list.length)
  assert.ok(!JSON.stringify(ov.json).match(/percent|"rate"/i), 'no percentages')
  // The edge serving another build than this deployment's is a failure, said plainly.
  // A new deployment makes them stale; the cron queues verification for it by itself.
  build.commit = 'fedcba0987654321fedcba0987654321fedcba09'
  resetHashCache()
  const q = await qaCron(env)
  assert.match(String(q.queued), /^qx_/)
  const prodStatus = (await freshness(env)).statuses.get('prod:build-commit').status
  assert.equal(prodStatus, 'stale')
  build.commit = COMMIT
})

// ---------- CI executor ----------
test('CI: refused with the missing step when not configured; with tokens it dispatches, tracks start + report, dedupes', async () => {
  const c = await admin()
  const tests = unitTests('test/url.test.js').map((t) => t.id)
  let plan = await call(planRoute, 'POST', '/api/platform/qa/plan', { c, body: { tests } })
  assert.equal(plan.json.runnable, false)
  assert.equal(plan.json.refusal.code, 'ci_not_configured')
  assert.equal((await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests, confirm: true } })).json.reason, 'ci_not_configured')
  assert.equal(count('qa_executions'), 0, 'never queued forever')
  assert.equal(fetches.length, 0)
  env.QA_GITHUB_DISPATCH_TOKEN = DISPATCH
  env.QA_INGEST_TOKEN = INGEST
  assert.equal((await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests } })).json.error, 'confirmation_required')
  const run = await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests, confirm: true } })
  assert.equal(run.status, 201)
  assert.equal(run.json.execution.status, 'dispatched')
  assert.equal(fetches.length, 1)
  assert.equal(fetches[0].url, 'https://api.github.com/repos/florasummit/getshowups/actions/workflows/qa.yml/dispatches')
  const sent = JSON.parse(fetches[0].init.body)
  assert.equal(sent.ref, 'main')
  assert.equal(sent.inputs.execution_id, run.json.execution.id)
  assert.equal(sent.inputs.unit_files, 'test/url.test.js')
  assert.equal(sent.inputs.e2e_files, '')
  assert.equal(fetches[0].init.headers.Authorization, `Bearer ${DISPATCH}`)
  assert.ok(!JSON.stringify(run.json).includes(DISPATCH), 'the token never reaches the browser')
  const id = run.json.execution.id
  // Started (from the workflow), then the report.
  const st = await call(ingestRoute, 'POST', '/api/qa/runs', { auth: `Bearer ${INGEST}`, body: { executionId: id, event: 'started', ghRunId: '987654321', revision: COMMIT } })
  assert.equal(st.status, 200)
  let d = (await call(executionRoute, 'GET', `/api/platform/qa/executions/${id}`, { c, params: { id } })).json
  assert.equal(d.execution.status, 'running')
  assert.equal(d.execution.runUrl, 'https://github.com/florasummit/getshowups/actions/runs/987654321')
  hashes.hashes['test/url.test.js'] = { def: 'aaaaaaaaaaaa', deps: 'bbbbbbbbbbbb' }
  const results = unitTests('test/url.test.js').map((t) => ({ kind: 'unit', file: t.file, title: t.title, status: 'passed', durationMs: 3 }))
  const rep = await call(ingestRoute, 'POST', '/api/qa/runs', { auth: `Bearer ${INGEST}`, body: { executionId: id, runKey: 'gh:987654321:1', revision: COMMIT, source: 'ci', provider: 'mocked', results, hashes: { 'test/url.test.js': { def: 'aaaaaaaaaaaa', deps: 'bbbbbbbbbbbb' } } } })
  assert.equal(rep.status, 201)
  assert.equal(rep.json.qa.stored, tests.length)
  d = (await call(executionRoute, 'GET', `/api/platform/qa/executions/${id}`, { c, params: { id } })).json
  assert.equal(d.execution.status, 'passed')
  assert.deepEqual([d.execution.progress.done, d.execution.progress.total, d.execution.progress.pass], [tests.length, tests.length, tests.length])
  assert.deepEqual(d.events.map((e) => e.to), ['queued', 'dispatched', 'running', 'passed'])
  // Replay of the same CI report: stored once.
  assert.equal((await call(ingestRoute, 'POST', '/api/qa/runs', { auth: `Bearer ${INGEST}`, body: { executionId: id, runKey: 'gh:987654321:1', revision: COMMIT, source: 'ci', provider: 'mocked', results } })).json.duplicate, true)
  // Fresh: same hashes as the deployment → verified (CI only where the feature has a production check not yet passed).
  resetHashCache()
  const st2 = (await freshness(env)).statuses.get(tests[0]).status
  assert.ok(['verified', 'verified_ci_only'].includes(st2), st2)
  // Already passed on this commit: a re-run needs rerun: true.
  plan = await call(planRoute, 'POST', '/api/platform/qa/plan', { c, body: { tests } })
  assert.equal(plan.json.duplicate.count, tests.length)
  assert.equal((await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests, confirm: true } })).json.error, 'duplicate_results')
  assert.equal((await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests, confirm: true, rerun: true } })).status, 201)
  // History list and filters.
  const list = await call(executionsRoute, 'GET', '/api/platform/qa/executions?environment=ci', { c })
  assert.equal(list.json.executions.length, 2)
  assert.equal((await call(executionsRoute, 'GET', '/api/platform/qa/executions?status=bogus', { c })).status, 400)
})

test('CI recovery: never-started free runs are re-dispatched (≤ 3 attempts), then expired; silent runs expire; cancel', async () => {
  const c = await admin()
  env.QA_GITHUB_DISPATCH_TOKEN = DISPATCH
  env.QA_INGEST_TOKEN = INGEST
  const tests = unitTests('test/format.test.js').map((t) => t.id)
  const id = (await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests, confirm: true } })).json.execution.id
  let now = Date.now()
  for (let i = 0; i < 3; i++) {
    now += START_TIMEOUT_MS + 1000
    await qaCron(env, now)
  }
  const row = db.sql.prepare('SELECT status, attempts, reason FROM qa_executions WHERE id = ?').get(id)
  assert.equal(row.attempts, 3)
  assert.equal(row.status, 'expired')
  assert.equal(row.reason, 'never_started')
  assert.equal(fetches.filter((f) => f.url.endsWith('/dispatches')).length, 3)
  // A started run that never reports expires; cancel of a running one cancels it on GitHub too.
  const t2 = unitTests('test/brand.test.js').map((t) => t.id)
  const id2 = (await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests: t2, confirm: true } })).json.execution.id
  await call(ingestRoute, 'POST', '/api/qa/runs', { auth: `Bearer ${INGEST}`, body: { executionId: id2, event: 'started', ghRunId: '42' } })
  const cancel = await call(cancelRoute, 'POST', '/api/platform/qa/cancel', { c, body: { id: id2, confirm: true } })
  assert.equal(cancel.json.execution.status, 'cancelled')
  assert.equal(cancel.json.githubCancelled, true)
  assert.ok(fetches.at(-1).url.endsWith('/actions/runs/42/cancel'))
  assert.equal((await call(cancelRoute, 'POST', '/api/platform/qa/cancel', { c, body: { id: id2, confirm: true } })).json.error, 'not_active')
  const t3 = unitTests('test/help.test.js').map((t) => t.id)
  const id3 = (await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests: t3, confirm: true } })).json.execution.id
  await call(ingestRoute, 'POST', '/api/qa/runs', { auth: `Bearer ${INGEST}`, body: { executionId: id3, event: 'started', ghRunId: '43' } })
  await qaCron(env, Date.now() + RUN_TIMEOUT_MS + 60_000)
  assert.equal(db.sql.prepare('SELECT status, reason FROM qa_executions WHERE id = ?').get(id3).reason, 'no_report')
})

// ---------- QA budget ----------
test('paid evaluations: refused while the QA budget is $0 or paid evals are off; reserved atomically; settled to reported cost', async () => {
  const c = await admin()
  env.QA_GITHUB_DISPATCH_TOKEN = DISPATCH
  env.QA_INGEST_TOKEN = INGEST
  const evals = ['eval:admin:week', 'eval:admin:broken']
  let plan = await call(planRoute, 'POST', '/api/platform/qa/plan', { c, body: { tests: evals } })
  assert.equal(plan.json.scope.tests, 0, 'paid tests are excluded unless asked for')
  assert.ok(plan.json.scope.excluded.every((x) => x.why === 'authorization_required'))
  plan = await call(planRoute, 'POST', '/api/platform/qa/plan', { c, body: { tests: evals, includePaid: true } })
  assert.equal(plan.json.refusal.code, 'paid_off')
  assert.equal(plan.json.approvals[0].granted, false)
  assert.equal((await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests: evals, includePaid: true, confirm: true } })).status, 403)
  // The switch alone is not enough: the budget defaults to $0.
  env.QA_PAID_EVALS = 'true'
  const set = (key, value) => call(settingsRoute, 'POST', '/api/platform/qa/settings', { c, body: { key, value, reason: 'founder approved', confirm: true } })
  assert.equal((await set('paid_evals', 1)).status, 200)
  assert.equal((await call(planRoute, 'POST', '/api/platform/qa/plan', { c, body: { tests: evals, includePaid: true } })).json.runnable, false)
  assert.equal((await set('eval_daily_micros', 9_000_000)).json.error, 'invalid_value', 'capped at $5/day')
  assert.equal((await call(settingsRoute, 'POST', '/api/platform/qa/settings', { c, body: { key: 'eval_daily_micros', value: 1000 } })).json.error, 'confirmation_required')
  await set('eval_daily_micros', 100_000)
  await set('eval_monthly_micros', 100_000)
  const run = await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests: evals, includePaid: true, confirm: true } })
  assert.equal(run.status, 201, JSON.stringify(run.json))
  assert.equal(run.json.execution.reservedMicros, 100_000)
  const sent = JSON.parse(fetches.at(-1).init.body).inputs
  assert.equal(sent.evals, 'admin_eval:broken,week')
  assert.equal(sent.cap_usd, '0.1')
  const counter = () => db.sql.prepare("SELECT count FROM rate_limits WHERE key LIKE 'aib:entry:qa_eval:getshowups:%'").get()?.count
  assert.equal(counter(), 100_000)
  // A second paid run would pass the monthly ceiling: refused, nothing reserved.
  const again = await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests: ['eval:admin:mrr', 'eval:admin:stuck'], includePaid: true, confirm: true } })
  assert.equal(again.status, 403)
  assert.equal(counter(), 100_000)
  // The report's costs replace the reservation.
  const id = run.json.execution.id
  const rep = await call(ingestRoute, 'POST', '/api/qa/runs', { auth: `Bearer ${INGEST}`, body: { executionId: id, revision: COMMIT, source: 'ci', provider: 'real', results: evals.map((t) => ({ kind: 'eval', testId: t, file: 'scripts/admin-assistant-eval.mjs', title: t, status: 'passed', costMicros: 4_000, model: 'claude-haiku-5-5', durationMs: 900 })) } })
  assert.equal(rep.json.qa.costMicros, 8_000)
  assert.equal(counter(), 8_000)
  const ov = (await call(overviewRoute, 'GET', '/api/platform/qa/overview', { c })).json
  assert.equal(ov.spend.spentMicros, 8_000)
  assert.equal(ov.spend.reservedMicros, 0)
  assert.equal(ov.spend.budgetMicros, 100_000)
  assert.equal(ov.spend.paidEnabled, true)
  const r = db.sql.prepare("SELECT model, cost_micros, provider FROM qa_test_results WHERE test_id = 'eval:admin:week'").get()
  assert.deepEqual({ ...r }, { model: 'claude-haiku-5-5', cost_micros: 4000, provider: 'real' })
})

// ---------- freshness ----------
test('freshness rules: hashes decide verified vs stale; unknown impact is uncertain; production checks follow the deployment', () => {
  const unit = { id: 'u', kind: 'unit', h: 'test/a.test.js', feature: null }
  const ctx = (extra = {}) => ({ commit: COMMIT, releaseAt: 1000, hashes: { 'test/a.test.js': { def: 'd1', deps: 'x1' }, 'test/e2e/b.spec.js': { def: 'd2', deps: null } }, prodPassed: new Set(), prodChecked: new Set(), ...extra })
  const pass = (o = {}) => ({ id: 'r', status: 'pass', environment: 'ci', revision: 'old0000', defHash: 'd1', depsHash: 'x1', at: 2000, ...o })
  assert.equal(statusOf(unit, null, null, ctx()), 'untested')
  assert.equal(statusOf(unit, pass(), pass(), ctx()), 'verified', 'same hashes on another commit: verified')
  assert.equal(statusOf(unit, pass({ depsHash: 'x0' }), pass({ depsHash: 'x0' }), ctx()), 'stale', 'a dependency changed')
  assert.equal(statusOf(unit, pass({ defHash: 'd0' }), pass({ defHash: 'd0' }), ctx()), 'stale', 'the test changed')
  assert.equal(statusOf(unit, { status: 'fail' }, pass(), ctx()), 'failed')
  assert.equal(statusOf(unit, { status: 'retest_required' }, pass(), ctx()), 'stale')
  assert.equal(statusOf(unit, pass({ defHash: null, depsHash: null }), pass({ defHash: null, depsHash: null }), ctx()), 'uncertain', 'no hashes, other commit')
  assert.equal(statusOf(unit, pass({ defHash: null, revision: COMMIT }), pass({ defHash: null, revision: COMMIT }), ctx()), 'verified', 'no hashes but this very commit')
  assert.equal(statusOf(unit, pass(), pass(), ctx({ hashes: null })), 'uncertain', 'deployment without hashes')
  const e2e = { id: 'e', kind: 'e2e', h: 'test/e2e/b.spec.js', feature: null }
  assert.equal(statusOf(e2e, pass({ defHash: 'd2' }), pass({ defHash: 'd2' }), ctx()), 'uncertain', 'browser test with no declared sources')
  const prod = { id: 'p', kind: 'production', h: null }
  assert.equal(statusOf(prod, pass({ revision: COMMIT }), pass({ revision: COMMIT }), ctx()), 'verified')
  assert.equal(statusOf(prod, pass(), pass(), ctx()), 'stale', 'passed on an earlier deployment')
  const withFeature = { ...unit, feature: 'calendar.google' }
  assert.equal(statusOf(withFeature, pass(), pass(), ctx({ prodChecked: new Set(['calendar.google']) })), 'verified_ci_only', 'CI ≠ production')
  assert.equal(statusOf(withFeature, pass(), pass(), ctx({ prodChecked: new Set(['calendar.google']), prodPassed: new Set(['calendar.google']) })), 'verified')
  const human = { id: 'h', kind: 'human', h: 'journey:x' }
  assert.equal(statusOf(human, pass({ environment: 'manual', defHash: null, depsHash: null, at: 5000 }), pass({ environment: 'manual', defHash: null, depsHash: null, at: 5000 }), ctx({ hashes: null })), 'verified', 'recorded after this release')
})

// ---------- defects ----------
test('defects: created from a failed result; fixed needs a fix ref; verified ONLY by a later passing result; a later failure reopens', async () => {
  const c = await admin()
  env.QA_INGEST_TOKEN = INGEST
  const t = unitTests('test/url.test.js')[0]
  await call(ingestRoute, 'POST', '/api/qa/runs', { auth: `Bearer ${INGEST}`, body: { revision: COMMIT, source: 'ci', provider: 'mocked', results: [{ kind: 'unit', file: t.file, title: t.title, status: 'failed', error: 'expected https://example.com for owner@shop.example' }] } })
  const failed = db.sql.prepare('SELECT id, actual FROM qa_test_results WHERE test_id = ?').get(t.id)
  assert.ok(!failed.actual.includes('owner@shop.example'), 'emails redacted in stored output')
  const created = await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'create', kind: 'bug', title: 'URL normalization broken', severity: 'high', fromResult: failed.id, steps: '1. type example.com' } })
  assert.equal(created.status, 201)
  const item = created.json.item
  assert.deepEqual(item.testIds, [t.id])
  assert.equal(item.status, 'open')
  assert.equal(item.area, 'website')
  const st = (status, extra = {}) => call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'status', id: item.id, status, ...extra } })
  assert.equal((await st('verified')).json.error, 'verified_by_results_only')
  assert.equal((await st('fixed_pending_qa')).json.error, 'fix_ref_required', 'a merge is not a verification; a fix needs its reference')
  assert.equal((await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'link', id: item.id, pr: '#204', commit: 'abc1234' } })).status, 200)
  assert.equal((await st('fixed_pending_qa')).json.item.status, 'fixed_pending_qa')
  // Overview: a high-severity open defect is a blocker.
  assert.equal((await call(overviewRoute, 'GET', '/api/platform/qa/overview', { c })).json.blockers[0].id, item.id)
  // A later failure reopens it (history kept).
  await new Promise((r) => setTimeout(r, 3))
  await call(ingestRoute, 'POST', '/api/qa/runs', { auth: `Bearer ${INGEST}`, body: { runKey: 'gh:2:1', revision: COMMIT, source: 'ci', provider: 'mocked', results: [{ kind: 'unit', file: t.file, title: t.title, status: 'failed', error: 'still broken' }] } })
  let d = (await call(itemRoute, 'GET', `/api/platform/qa/items/${item.id}`, { c, params: { id: item.id } })).json
  assert.equal(d.item.status, 'open')
  await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'link', id: item.id, pr: 205 } })
  await st('fixed_pending_qa')
  await new Promise((r) => setTimeout(r, 3))
  const ok = await call(ingestRoute, 'POST', '/api/qa/runs', { auth: `Bearer ${INGEST}`, body: { runKey: 'gh:3:1', revision: COMMIT, source: 'ci', provider: 'mocked', results: [{ kind: 'unit', file: t.file, title: t.title, status: 'passed' }] } })
  assert.equal(ok.json.qa.items[0].status, 'verified')
  d = (await call(itemRoute, 'GET', `/api/platform/qa/items/${item.id}`, { c, params: { id: item.id } })).json
  assert.equal(d.item.status, 'verified')
  assert.match(d.item.verifiedBy, /^qr_/)
  assert.deepEqual(d.events.map((e) => e.type), ['created', 'link', 'status', 'reopened', 'link', 'status', 'verified'])
  // Every result stays: two failures and the pass (retest_of links them).
  const hist = (await call(testRoute, 'GET', `/api/platform/qa/tests/${t.id}`, { c, params: { id: t.id } })).json.history
  assert.deepEqual(hist.map((h) => h.status), ['pass', 'fail', 'fail'])
  assert.equal(hist[0].retestOf, hist[1].id)
  // The prompt: deterministic, from the records, with the command; no emails.
  const p = (await call(promptRoute, 'GET', `/api/platform/qa/items/${item.id}/prompt`, { c, params: { id: item.id } })).json
  assert.match(p.prompt, /URL normalization broken/)
  assert.match(p.prompt, /node --test --test-name-pattern=/)
  assert.ok(!p.prompt.includes('@shop.example'))
  assert.equal(p.prompt, (await call(promptRoute, 'GET', `/api/platform/qa/items/${item.id}/prompt`, { c, params: { id: item.id } })).json.prompt)
})

test('backlog: kinds and statuses; nothing advances it automatically; filters and counts', async () => {
  const c = await admin()
  const t = T((x) => x.kind === 'human' && x.journey === 'booking')
  const r = await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'create', kind: 'ux', title: 'Booking times could show the day name', area: 'booking', priority: 'p3', testIds: [t.id], customerImpact: 'Fewer wrong-day bookings' } })
  assert.equal(r.json.item.status, 'inbox')
  assert.equal(r.json.item.group, 'backlog')
  assert.equal(r.json.item.severity, null)
  // A passing result for its test changes nothing.
  await call(resultRoute, 'POST', '/api/platform/qa/result', { c, body: { testId: t.id, status: 'pass', confirm: true } })
  assert.equal((await call(itemRoute, 'GET', `/api/platform/qa/items/${r.json.item.id}`, { c, params: { id: r.json.item.id } })).json.item.status, 'inbox')
  assert.equal((await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'status', id: r.json.item.id, status: 'fixed_pending_qa' } })).json.error, 'invalid_status', 'backlog statuses only')
  assert.equal((await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'status', id: r.json.item.id, status: 'planned' } })).json.item.status, 'planned')
  assert.equal((await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'create', kind: 'nonsense', title: 'x' } })).json.error, 'invalid_kind')
  assert.equal((await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'create', kind: 'feature', title: 'x', testIds: ['unit:nope:0'] } })).json.error, 'unknown_test')
  const list = (await call(itemsRoute, 'GET', '/api/platform/qa/items?group=backlog&status=planned', { c })).json
  assert.equal(list.items.length, 1)
  assert.equal(list.counts.backlog.planned, 1)
  assert.equal(list.counts.backlog.total, 1)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM admin_audit WHERE action LIKE 'qa.item_%'").get().n, 2)
})

// ---------- manual results, evidence ----------
test('manual results: a person records the status; an AI assessment is labelled evidence only; evidence redacted; screenshots sniffed + retained', async () => {
  const c = await admin()
  const t = T((x) => x.id === 'human:receptionist.transcript')
  const plan = await call(planRoute, 'POST', '/api/platform/qa/plan', { c, body: { journeys: ['receptionist'], environment: 'manual' } })
  assert.equal(plan.json.scope.tests, 6)
  const ex = (await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { journeys: ['receptionist'], environment: 'manual', confirm: true } })).json.execution
  assert.equal(ex.status, 'running')
  assert.equal((await call(resultRoute, 'POST', '/api/platform/qa/result', { c, body: { testId: t.id, aiAssessment: { text: 'All facts match' }, confirm: true } })).json.error, 'invalid_status', 'an AI opinion is never a result')
  const secretish = 'Customer jane.doe@example.net called 843-555-0101; Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD; key sk_live_abcdefghijk and https://x.example/cb?token=supersecret'
  const r = await call(resultRoute, 'POST', '/api/platform/qa/result', { c, body: { testId: t.id, status: 'pass', executionId: ex.id, actual: secretish, evidence: [{ kind: 'transcript', text: secretish }, { kind: 'link', url: 'https://github.com/florasummit/getshowups/actions/runs/1' }], aiAssessment: { text: `Facts match. ${secretish}`, model: 'claude-haiku-5-5' }, confirm: true } })
  assert.equal(r.status, 201)
  assert.equal(r.json.result.status, 'pass')
  assert.match(r.json.result.reviewer, /^ref:/)
  const stored = JSON.stringify(db.sql.prepare('SELECT * FROM qa_evidence').all()) + JSON.stringify(db.sql.prepare('SELECT * FROM qa_test_results').all())
  for (const bad of ['jane.doe@example.net', '843-555-0101', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD', 'sk_live_abcdefghijk', 'supersecret', ADMIN]) assert.ok(!stored.includes(bad), `stored evidence leaks ${bad}`)
  const ai = r.json.result.evidence.find((e) => e.kind === 'ai_assessment')
  assert.match(ai.text, /^AI assessment \(claude-haiku-5-5\), not a verified result/)
  assert.equal(ai.label, 'AI assessment (not a verified result)')
  assert.equal(db.sql.prepare('SELECT progress FROM qa_executions WHERE id = ?').get(ex.id).progress.includes('"done":1'), true)
  // Screenshots: PNG accepted (sniffed), other bytes refused, size capped; retention clears the bytes, keeps the row.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64')
  const shot = await call(evidenceRoute, 'POST', '/api/platform/qa/evidence', { c, body: { ownerKind: 'result', ownerId: r.json.result.id, kind: 'screenshot', dataBase64: png } })
  assert.equal(shot.status, 201)
  assert.equal(shot.json.evidence.mime, 'image/png')
  assert.equal((await call(evidenceRoute, 'POST', '/api/platform/qa/evidence', { c, body: { ownerKind: 'result', ownerId: r.json.result.id, kind: 'screenshot', dataBase64: Buffer.from('<svg onload=alert(1)>').toString('base64') } })).json.error, 'invalid_image')
  assert.equal((await call(evidenceRoute, 'POST', '/api/platform/qa/evidence', { c, body: { ownerKind: 'result', ownerId: 'qr_doesnotexist', kind: 'log', text: 'x' } })).status, 404)
  const img = await call(evidenceGetRoute, 'GET', `/api/platform/qa/evidence/${shot.json.evidence.id}`, { c, params: { id: shot.json.evidence.id } })
  assert.equal(img.res.headers.get('Content-Type'), 'image/png')
  assert.equal(img.res.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal((await purgeEvidence(db, Date.now() + 91 * DAY)).purged, 1)
  assert.equal((await call(evidenceGetRoute, 'GET', `/api/platform/qa/evidence/${shot.json.evidence.id}`, { c, params: { id: shot.json.evidence.id } })).status, 410)
  assert.equal(count('qa_evidence'), 4, 'records kept')
})

test('redaction covers tokens, keys, cookies, signed links, emails and phone numbers', () => {
  const out = redactEvidence('Cookie: __Host-gsu_session=abc\nsaw __Host-gsu_staff=def; ghp_abcdefghijklmnop; whsec_123456789; password=hunter22 https://a.example/x?sig=zzz&ok=1 a@b.co +1 (843) 555-0101')
  for (const bad of ['__Host-gsu_session=abc', '__Host-gsu_staff=def', 'ghp_abcdefghijklmnop', 'whsec_123456789', 'hunter22', 'sig=zzz', 'a@b.co', '555-0101']) assert.ok(!out.includes(bad), bad)
  assert.ok(out.includes('ok=1'))
})

// ---------- inventory + test routes, import ----------
test('inventory and test routes: tree with counts, filters validated, gaps listed; import records eval costs as local', async () => {
  const c = await admin()
  const top = (await call(inventoryRoute, 'GET', '/api/platform/qa/inventory', { c })).json
  assert.equal(top.platform.counts.total, allTests().list.length)
  assert.ok(top.areas.length >= 15)
  assert.equal(top.areas[0].journeys[0].features[0].tests, undefined, 'no leaves without a filter')
  const booking = (await call(inventoryRoute, 'GET', '/api/platform/qa/inventory?area=booking', { c })).json
  assert.ok(booking.areas.length === 1 && booking.areas[0].journeys.some((j) => j.id === 'booking'))
  assert.ok(booking.areas[0].journeys[0].features[0].tests.length > 0)
  assert.equal((await call(inventoryRoute, 'GET', '/api/platform/qa/inventory?status=bogus', { c })).status, 400)
  assert.ok(top.gaps.length > 0 && top.gaps.every((g) => g.why))
  assert.equal((await call(testRoute, 'GET', '/api/platform/qa/tests/unit:none:x', { c, params: { id: 'unit:none:x' } })).status, 404)
  // Import of an evaluation report (as the eval script writes it) — no ingest token needed, admin session instead.
  const { qaReport } = await import('../scripts/admin-assistant-eval.mjs')
  const report = qaReport([{ id: 'week', q: 'What needs me this week?', pass: true, ms: 1200, costMicros: 3100, fail: [] }, { id: 'mrr', q: 'What’s our MRR?', pass: false, ms: 900, costMicros: 2900, fail: ['missing /test/i'] }], 'claude', Date.now())
  const imp = await call(importRoute, 'POST', '/api/platform/qa/import', { c, body: { report, confirm: true } })
  assert.equal(imp.status, 201, JSON.stringify(imp.json))
  assert.equal(imp.json.run.stored, 2)
  assert.equal(imp.json.run.costMicros, 6000)
  // The import is an execution of its own (environment local, the importing admin, the cost), linked to its results.
  const ex = db.sql.prepare('SELECT environment, status, requested_by, cost_micros FROM qa_executions WHERE id = ?').get(imp.json.executionId)
  assert.deepEqual({ ...ex, requested_by: ex.requested_by.slice(0, 4) }, { environment: 'local', status: 'failed', requested_by: 'ref:', cost_micros: 6000 })
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM qa_test_results WHERE execution_id = ?').get(imp.json.executionId).n, 2)
  const rows = db.sql.prepare("SELECT test_id, status, environment, cost_micros, model FROM qa_test_results WHERE test_id LIKE 'eval:%' ORDER BY test_id").all().map((x) => ({ ...x }))
  assert.deepEqual(rows, [{ test_id: 'eval:admin:mrr', status: 'fail', environment: 'local', cost_micros: 2900, model: 'claude-haiku-5-5' }, { test_id: 'eval:admin:week', status: 'pass', environment: 'local', cost_micros: 3100, model: 'claude-haiku-5-5' }])
  assert.equal((await call(importRoute, 'POST', '/api/platform/qa/import', { c, body: { report, confirm: true } })).json.run.duplicate, true, 'the same report twice is stored once')
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM admin_audit WHERE action = 'qa.report_imported'").get().n, 2)
})

test('large CI reports without an execution store failures and changed passes only (bounded writes)', async () => {
  const tests = unitTests('test/dashboard.test.js')
  const body = (status) => ({ revision: COMMIT, source: 'ci', provider: 'mocked', results: tests.map((t) => ({ kind: 'unit', file: t.file, title: t.title, status })), hashes: { 'test/dashboard.test.js': { def: 'aaaaaaaaaaaa', deps: 'bbbbbbbbbbbb' } } })
  const a = await ingestReport(env, { ...body('passed'), runKey: 'k-0001' })
  assert.equal(a.qa.stored, tests.length)
  const b = await ingestReport(env, { ...body('passed'), runKey: 'k-0002' })
  assert.equal(b.qa.stored, 0, 'the same pass on the same code is not stored again')
  const changed = { ...body('passed'), runKey: 'k-0003', hashes: { 'test/dashboard.test.js': { def: 'aaaaaaaaaaaa', deps: 'cccccccccccc' } } }
  assert.equal((await ingestReport(env, changed)).qa.stored, tests.length, 'new dependency hash → stored')
})

test('dispatch: a missing workflow is refused visibly (reservation released); the GitHub mock origin is loopback-only', async () => {
  const c = await admin()
  env.QA_GITHUB_DISPATCH_TOKEN = DISPATCH
  env.QA_INGEST_TOKEN = INGEST
  globalThis.fetch = async (url) => {
    fetches.push({ url: String(url) })
    return new Response('{"message":"Not Found"}', { status: 404 })
  }
  const r = await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests: unitTests('test/url.test.js').map((t) => t.id), confirm: true } })
  assert.equal(r.status, 201)
  assert.equal(r.json.execution.status, 'refused')
  assert.equal(r.json.execution.reason, 'dispatch_not_found')
  assert.equal(r.json.dispatch.code, 'not_found')
  env.GITHUB_API_MOCK_ORIGIN = 'https://evil.example'
  await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests: unitTests('test/brand.test.js').map((t) => t.id), confirm: true } })
  assert.ok(fetches.at(-1).url.startsWith('https://api.github.com/'), 'a non-loopback mock origin is ignored')
  env.GITHUB_API_MOCK_ORIGIN = 'http://127.0.0.1:9911'
  await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests: unitTests('test/help.test.js').map((t) => t.id), confirm: true } })
  assert.ok(fetches.at(-1).url.startsWith('http://127.0.0.1:9911/repos/'))
  // Audited, with counts and codes only.
  const audits = db.sql.prepare("SELECT details FROM admin_audit WHERE action = 'qa.execution_requested'").all()
  assert.equal(audits.length, 3)
  assert.ok(audits.every((a) => !a.details.includes(DISPATCH)))
})

test('production verification falls back to in-process checks when the edge is unreachable: labelled, never verified', async () => {
  const c = await admin()
  // Default origin (https://getshowups.com) and every fetch refused, as a blocked same-zone fetch would be.
  const run = await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { preset: 'production_verify', confirm: true } })
  for (let i = 0; i < 10 && (await qaCron(env)).production; i++);
  const d = (await call(executionRoute, 'GET', `/api/platform/qa/executions/${run.json.execution.id}`, { c, params: { id: run.json.execution.id } })).json
  assert.equal(d.execution.progress.mode, 'in_process')
  const byId = Object.fromEntries(d.results.map((r) => [r.testId, r]))
  for (const id of ['prod:build-commit', 'prod:dashboard-signed-out', 'prod:platform-signed-out', 'prod:qa-signed-out', 'prod:admin-api-unauthorized']) {
    assert.equal(byId[id].status, 'unverified', id)
    assert.match(byId[id].actual, /^in-process, not through the edge/, id)
  }
  assert.equal(byId['prod:edge-headers'].status, 'blocked')
  assert.equal(byId['prod:test-site'].status, 'blocked')
  const st = (await freshness(env)).statuses
  for (const id of ['prod:build-commit', 'prod:dashboard-signed-out']) assert.notEqual(st.get(id).status, 'verified', 'in-process results never count as production verified')
  assert.ok(fetches.every((f) => f.url.startsWith('https://getshowups.com/')))
})

test('edge mode: the edge serving another build than this deployment fails plainly', async () => {
  const c = await admin()
  env.QA_PRODUCTION_ORIGIN = EDGE
  edgeStub({ '/build.json': () => Response.json({ ...build, commit: '1111111222222233333334444444555555566666' }) })
  const run = await call(runRoute, 'POST', '/api/platform/qa/run', { c, body: { tests: ['prod:build-commit', 'prod:test-site'], confirm: true } })
  await qaCron(env)
  const d = (await call(executionRoute, 'GET', `/api/platform/qa/executions/${run.json.execution.id}`, { c, params: { id: run.json.execution.id } })).json
  const byId = Object.fromEntries(d.results.map((r) => [r.testId, r]))
  assert.equal(byId['prod:build-commit'].status, 'fail')
  assert.match(byId['prod:build-commit'].actual, /edge serves 1111111, this deployment built abcdef1/)
  assert.equal(byId['prod:test-site'].status, 'skipped', 'no admin-marked test business: skipped, PoolThru never used')
  // A non-loopback http origin is never used.
  env.QA_PRODUCTION_ORIGIN = 'http://evil.example'
  const { productionOrigin } = await import('../server/ops/qa-production-checks.js')
  assert.equal(productionOrigin(env), 'https://getshowups.com')
})

test('spend guard: with no QA configuration, reserveAi refuses every qa_eval call (ceiling 0, not the default)', async () => {
  const { reserveAi } = await import('../server/ai-budget.js')
  const r = await reserveAi(env, { entry: 'qa_eval', customerId: 'getshowups', micros: 1 })
  assert.deepEqual(r, { ok: false, reason: 'entry' })
  assert.equal(db.sql.prepare("SELECT coalesce(sum(count), 0) AS n FROM rate_limits WHERE key LIKE 'aib:%'").get().n, 0, 'nothing charged')
})

test('every report becomes a finished execution; unchanged passes are listed on it, so "last verified" moves to the newer commit', async () => {
  const c = await admin()
  const tests = unitTests('test/dashboard.test.js')
  const body = (rev, key) => ({ runKey: key, revision: rev, source: 'ci', provider: 'mocked', results: tests.map((t) => ({ kind: 'unit', file: t.file, title: t.title, status: 'passed' })), hashes: { 'test/dashboard.test.js': { def: 'aaaaaaaaaaaa', deps: 'bbbbbbbbbbbb' } } })
  const a = await ingestReport(env, body('1111111aaaa', 'k-a1'))
  const b = await ingestReport(env, body(COMMIT, 'k-b1'), Date.now() + 1000)
  assert.match(a.executionId, /^qx_/)
  assert.equal(b.qa.stored, 0)
  assert.equal(b.qa.unchanged, tests.length)
  const ex = db.sql.prepare('SELECT status, preset, requested_by, unchanged, progress FROM qa_executions WHERE id = ?').get(b.executionId)
  assert.equal(ex.status, 'passed')
  assert.equal(ex.preset, 'report')
  assert.equal(ex.requested_by, 'system:ci')
  assert.deepEqual(JSON.parse(ex.unchanged), { files: ['test/dashboard.test.js'], tests: [] }, 'compact: a whole file is one entry')
  assert.equal(JSON.parse(ex.progress).pass, tests.length)
  const s = (await freshness(env)).statuses.get(tests[0].id)
  assert.equal(s.lastPass.revision, COMMIT, 'last verified on the newer commit')
  const hist = (await call(testRoute, 'GET', `/api/platform/qa/tests/${tests[0].id}`, { c, params: { id: tests[0].id } })).json.history
  assert.deepEqual(hist.map((h) => [h.source, h.revision]), [['unchanged', COMMIT], ['qa', '1111111aaaa']])
  // Filters: result / test / area / release.
  const q = async (qs) => (await call(executionsRoute, 'GET', `/api/platform/qa/executions?${qs}`, { c })).json.executions.map((e) => e.id)
  assert.deepEqual(await q('result=pass'), [a.executionId])
  assert.deepEqual(await q(`test=${tests[0].id}`), [a.executionId])
  assert.deepEqual(await q('area=security'), [a.executionId])
  assert.deepEqual(await q('area=ads'), [])
  assert.deepEqual(await q(`commit=${COMMIT.slice(0, 7)}`), [b.executionId])
  assert.deepEqual(await q('result=fail'), [])
  assert.equal((await call(executionsRoute, 'GET', '/api/platform/qa/executions?severity=bogus', { c })).status, 400)
  // Severity: runs that include a test linked to a high defect.
  await call(itemsRoute, 'POST', '/api/platform/qa/items', { c, body: { action: 'create', kind: 'bug', title: 'x', severity: 'high', testIds: [tests[0].id] } })
  assert.deepEqual(await q('severity=high'), [a.executionId])
  assert.deepEqual(await q('severity=low'), [])
})
