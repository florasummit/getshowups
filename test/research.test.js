// Research Vault (server/research/, migration 0052): access (founder only, generic 404, recent sign-in for writes,
// roles), versioned append-only records and links, traceability, the built-in models' derivations and numeric checks,
// experiment statistics (no early verdicts), belief updating, KPI reuse with honest data kinds, the dormant evidence scan,
// the decision queue, and isolation from customer-facing code. No network, no model calls.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { sha256Hex } from '../server/google-oauth.js'
import { MODELS, cleanParams, describe, phi, invPhi, sampleSize, analyzeExperiment, updateBelief, wilson } from '../server/research/math.js'
import { rankDecisions, accountability, businessFunnel, observatory, CROSS_ACCOUNT } from '../server/research/intelligence.js'
import { trace } from '../server/research/store.js'
import * as vault from '../functions/api/research/vault.js'

const ORIGIN = 'https://getshowups.com'
const FOUNDER = 'founder@getshowups.com'
const ADMIN = 'staff@getshowups.com'
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
let env, db
beforeEach(() => {
  db = d1()
  env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: `${ORIGIN}/api/google/oauth/callback`, ADMIN_API_TOKEN: 'a'.repeat(40), TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)), ONBOARDING_DB: db, GOOGLE_TOKENS: { get: async () => null, list: async () => ({ keys: [], list_complete: true }) }, PLATFORM_ADMIN_EMAILS: `${FOUNDER},${ADMIN}`, RESEARCH_FOUNDER_EMAIL: FOUNDER }
})
async function session(email, { age = 0 } = {}) {
  const token = email.replace(/[^A-Za-z0-9]/g, 'x').padEnd(43, 'Q').slice(0, 43)
  db.sql.prepare('INSERT OR REPLACE INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), email, Date.now() - age, Date.now() + DAY)
  return `__Host-gsu_session=${token}`
}
async function get(cookie, query = 'view=overview') {
  const res = await vault.onRequestGet({ request: new Request(`${ORIGIN}/api/research/vault?${query}`, { headers: cookie ? { Cookie: cookie } : {} }), env })
  return { status: res.status, data: await res.json() }
}
async function post(cookie, body, origin = ORIGIN) {
  const res = await vault.onRequestPost({ request: new Request(`${ORIGIN}/api/research/vault`, { method: 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env })
  return { status: res.status, data: await res.json() }
}
const hypothesis = (extra = {}) => ({ action: 'create', kind: 'hypothesis', record: { title: 'Two offered times raise bookings', program: 'GS-ECO-002', body: { statement: 'Offering two concrete times raises the booking rate', falsifiedBy: 'No rise in booked/qualified after 40 qualified leads', assumptions: ['Lead quality unchanged'] }, ...extra } })

// ---------- access ----------
test('access: only the founder (an admin named in RESEARCH_FOUNDER_EMAIL); every refusal is the same generic 404', async () => {
  const same = (r) => assert.deepEqual([r.status, r.data], [404, { error: 'not_found' }])
  same(await get(null))
  same(await get(await session('owner@pool.example')))
  same(await get(await session(ADMIN))) // a platform admin is not enough
  const founder = await session(FOUNDER)
  assert.equal((await get(founder)).status, 200)
  same(await post(founder, hypothesis(), 'https://evil.example'))
  delete env.RESEARCH_FOUNDER_EMAIL
  same(await get(founder)) // vault off without the founder setting
  env.RESEARCH_FOUNDER_EMAIL = FOUNDER
  env.PLATFORM_ADMIN_EMAILS = ADMIN
  same(await get(founder)) // the founder must also be a platform admin
  assert.ok(db.sql.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'research.access_refused'").get().n >= 1)
})

test('access: writes need a sign-in from the last 12 hours; members get roles; researchers cannot manage; revoked = 404', async () => {
  const stale = await session(FOUNDER, { age: 13 * 3_600_000 })
  assert.equal((await get(stale)).status, 200)
  assert.deepEqual((await post(stale, hypothesis())).data, { error: 'recent_sign_in_required' })
  const founder = await session(FOUNDER)
  assert.equal((await post(founder, { action: 'member', email: ADMIN, role: 'researcher' })).status, 200)
  const r = await session(ADMIN)
  assert.equal((await get(r)).data.you.role, 'researcher')
  assert.equal((await post(r, hypothesis())).status, 200)
  assert.equal((await post(r, { action: 'member', email: 'x@getshowups.com', role: 'researcher' })).status, 404)
  await post(founder, { action: 'member', email: ADMIN, revoke: true })
  assert.equal((await get(r)).status, 404)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM audit_log WHERE action IN ('research.member_granted', 'research.member_revoked')").get().n, 2)
})

// ---------- records ----------
test('records: required fields per kind, never defaulted; versions with reasons; stale edits refused; history immutable', async () => {
  const f = await session(FOUNDER)
  const bad = await post(f, { action: 'create', kind: 'hypothesis', record: { title: 'No falsifier', body: { statement: 'x' } } })
  assert.deepEqual([bad.status, bad.data.fields.sort()], [400, ['assumptions', 'falsifiedBy']])
  const exp = await post(f, { action: 'create', kind: 'experiment', record: { title: 'Two times test', body: { primaryOutcome: 'booked/qualified' } } })
  assert.ok(['design', 'successCriteria', 'stoppingRule', 'assignment', 'budgetLimit'].every((k) => exp.data.fields.includes(k)), 'criteria fixed before the start')
  const { id } = (await post(f, hypothesis())).data
  assert.equal((await post(f, { action: 'update', id, version: 1, record: { confidence: 0.6 } })).data.fields[0], 'reason')
  assert.equal((await post(f, { action: 'update', id, version: 1, reason: 'first evidence', record: { confidence: 0.6, status: 'supported' } })).data.version, 2)
  assert.equal((await post(f, { action: 'update', id, version: 1, reason: 'late', record: { confidence: 0.1 } })).status, 409)
  const rec = (await get(f, `view=record&id=${id}`)).data.record
  assert.deepEqual(rec.versions.map((v) => [v.version, v.confidence, v.reason]), [[2, 0.6, 'first evidence'], [1, null, 'created']])
  assert.throws(() => db.sql.prepare('UPDATE research_versions SET reason = ?').run('rewritten'), /append-only/)
  assert.throws(() => db.sql.prepare('DELETE FROM research_versions').run(), /append-only/)
})

test('links and traceability: a recommendation traces back to its evidence, assumptions and model; contradictions are kept and counted', async () => {
  const f = await session(FOUNDER)
  const mk = async (kind, record) => (await post(f, { action: 'create', kind, record })).data.id
  const assumption = await mk('assumption', { title: 'Lead quality stable', body: { statement: 'Lead quality does not change during the test' } })
  const model = await mk('model', { title: 'Funnel model', program: 'GS-ECO-002', status: 'illustrative', body: { expression: 'C = S(qkpsv/c − 1)', assumptions: ['independent stages'] } })
  const hyp = (await post(f, hypothesis())).data.id
  const ev = await mk('evidence', { title: 'Pilot week', body: { what: '9/20 booked vs 5/20 before', source: 'PoolThru records', quality: 'small sample', dataKind: 'measured' } })
  const against = await mk('evidence', { title: 'Second week', body: { what: '4/20 booked', source: 'PoolThru records', quality: 'small sample', dataKind: 'measured' } })
  const rec = await mk('recommendation', { title: 'Offer two times by default', body: { improve: 'booking rate', whyItMatters: 'lowest-rate stage', kpi: 'booked/qualified', action: 'two times', risks: 'none known', evidence: 'pilot', uncertainty: 'small n', validationStatus: 'illustrative model', invalidatedBy: 'no rise after 40 leads', approval: 'founder', successCriteria: '+10 points', followUp: 'day 30' } })
  for (const [from, to, relation] of [[assumption, hyp, 'assumes'], [model, hyp, 'derives'], [ev, hyp, 'supports'], [against, hyp, 'contradicts'], [hyp, rec, 'supports']]) assert.equal((await post(f, { action: 'link', from, to, relation })).status, 200)
  assert.equal((await post(f, { action: 'link', from: ev, to: hyp, relation: 'supports' })).data.already, true)
  assert.equal((await post(f, { action: 'link', from: ev, to: hyp, relation: 'causes' })).status, 400)
  const t = await trace(db, rec)
  for (const id of [hyp, assumption, model, ev, against]) assert.ok(t.nodes.some((n) => n.id === id), id)
  assert.equal(t.contradictions, 1)
  assert.throws(() => db.sql.prepare('DELETE FROM research_edges').run(), /append-only/)
  const g = (await get(f, 'view=gaps')).data.gaps
  assert.ok(g.find((x) => x.gap.startsWith('Records contradicted')).items.some((i) => i.id === hyp))
})

test('programs are records, not code: imported (re-import skips), validated, and dormant until their data exists', async () => {
  const f = await session(FOUNDER)
  assert.deepEqual((await get(f)).data.programs, [], 'no program list ships in the code')
  const list = [
    { kind: 'program', record: { program: 'GS-ECO-002', title: 'Funnel economics', body: { question: 'Which stage loses most?', needs: ['leads', 'outcomes'] } } },
    { kind: 'program', record: { title: 'No id', body: { question: 'x' } } },
    { kind: 'program', record: { program: 'GS-ECO-009', title: 'Bad need', body: { question: 'x', needs: ['scraping'] } } },
  ]
  const r = (await post(f, { action: 'import', records: list })).data
  assert.deepEqual([r.created.length, r.refused.map((x) => x.fields[0])], [1, ['program', 'needs']])
  assert.equal((await post(f, { action: 'import', records: list.slice(0, 1) })).data.skipped.length, 1)
  const p = (await get(f)).data.programs[0]
  assert.deepEqual([p.id, p.ready, p.missing.length], ['GS-ECO-002', false, 2])
  assert.equal((await post(f, { action: 'import', records: Array.from({ length: 51 }, () => list[0]) })).status, 400)
})

// ---------- mathematics ----------
test('GS-ECO-001: x* = (va/2)², Π(x*) = (va)²/4, break-even 4x*; every numeric check passes across parameters; budget caps the spend', () => {
  const m = MODELS['GS-ECO-001@1']
  for (const p of [{ a: 1.2, v: 120, B: 3000 }, { a: 0.3, v: 900, B: 100 }, { a: 4.5, v: 15, B: 20000 }]) {
    const r = m.evaluate(p).results
    const xs = ((p.v * p.a) / 2) ** 2
    assert.ok(Math.abs(r.xStar - xs) < 0.01)
    assert.ok(Math.abs(r.profitAtOptimum - (p.v * p.a) ** 2 / 4) < 0.01)
    assert.equal(r.bestWithinBudget, Math.round(Math.min(p.B, xs) * 100) / 100)
    for (const c of m.verify(p)) assert.equal(c.pass, true, `${c.check} ${JSON.stringify(p)}`)
  }
  assert.ok(m.counterexamples().some((c) => /b ≥ 1/.test(c.case)), 'challenge mode names where the result fails')
  assert.equal(describe('GS-ECO-001@1').proof.formal, 'not verified (no proof assistant integrated)')
})

test('GS-ECO-002/003/007/012: funnel per-point value is largest at the lowest rate; allocation uses the budget and equalizes marginal returns; fatigue and product-value checks pass', () => {
  const f = MODELS['GS-ECO-002@1'].evaluate({ S: 2000, c: 40, q: 0.6, k: 0.3, p: 0.9, s: 0.7, v: 300 }).results
  assert.equal(f.largestGainPerPoint, 'k')
  assert.ok(MODELS['GS-ECO-002@1'].verify({ S: 2000, c: 40, q: 0.6, k: 0.3, p: 0.9, s: 0.7, v: 300 }).every((c) => c.pass))
  const a = MODELS['GS-ECO-003@1']
  const r = a.evaluate({ B: 1000, a1: 1.2, v1: 120, a2: 0.8, v2: 200, a3: 1.5, v3: 60 }).results
  assert.equal(r.budgetBinding, true)
  assert.ok(Math.abs(r.allocation.reduce((s, x) => s + x, 0) - 1000) < 0.05)
  assert.ok(r.totalContribution >= r.evenSplitContribution)
  assert.ok(a.verify({ B: 1000 }).every((c) => c.pass))
  assert.ok(a.verify({ B: 100000 }).every((c) => c.pass), 'non-binding budget')
  assert.ok(MODELS['GS-ECO-007@1'].verify({ r0: 5, lambda: 0.05, v: 80, K: 400 }).every((c) => c.pass))
  const v = MODELS['GS-ECO-012@1'].evaluate({ j: 3, m: 150, h: 6, w: 40, P: 499, I: 300, M: 12 }).results
  assert.ok(Math.abs(v.breakEvenJobs - (499 + 25 - 240) / 150) < 0.01)
  assert.ok(MODELS['GS-ECO-012@1'].verify({}).every((c) => c.pass))
})

test('parameters are clamped numbers only: nothing a request sends is evaluated as code', async () => {
  assert.deepEqual(cleanParams('GS-ECO-001@1', { a: 'process.exit()', v: 1e9, B: -5 }), { a: 1.2, v: 1000, B: 0 })
  const f = await session(FOUNDER)
  const r = await post(f, { action: 'evaluate', model: 'GS-ECO-001@1', params: { a: '2', v: '100', B: '50' } })
  assert.equal(r.data.results.bestWithinBudget, 50)
  assert.ok(r.data.series[0].points.length > 10)
  assert.equal((await post(f, { action: 'evaluate', model: '../../etc', params: {} })).status, 404)
})

test('statistics: normal CDF/inverse accurate; sample size matches the textbook value; no verdict before the planned sample; Bayesian update', () => {
  assert.ok(Math.abs(phi(1.959964) - 0.975) < 1e-6 && Math.abs(invPhi(0.975) - 1.959964) < 1e-5)
  const n = sampleSize({ baseline: 0.1, effect: 0.05 })
  assert.ok(n.perArm >= 680 && n.perArm <= 690, `${n.perArm}`)
  const early = analyzeExperiment({ controlN: 30, controlSuccesses: 5, treatmentN: 30, treatmentSuccesses: 20, plannedSample: 100 })
  assert.equal(early.verdict, 'running', 'a big early difference is not a result')
  const done = analyzeExperiment({ controlN: 100, controlSuccesses: 20, treatmentN: 100, treatmentSuccesses: 40, plannedSample: 100 })
  assert.equal(done.verdict, 'treatment_better')
  assert.ok(done.probTreatmentBetter > 0.99)
  assert.equal(analyzeExperiment({ controlN: 5, controlSuccesses: 1, treatmentN: 5, treatmentSuccesses: 4, plannedSample: 5 }).verdict, 'insufficient')
  assert.equal(analyzeExperiment({ controlN: 100, controlSuccesses: 20, treatmentN: 100, treatmentSuccesses: 22, plannedSample: 100 }).verdict, 'no_detectable_difference')
  const b = updateBelief({ priorSuccesses: 4, priorN: 10, successes: 6, n: 10 })
  assert.equal(b.mean, Math.round((11 / 22) * 1e4) / 1e4)
  assert.ok(wilson(0, 10).low === 0 && wilson(0, 10).high > 0.2)
})

// ---------- KPIs and evidence ----------
test('observatory: shared KPI definitions, only GetShowUps-owned businesses, missing data stays missing, cross-account research off', async () => {
  const t = Date.now()
  for (const id of ['poolthru-llc', 'acme']) db.sql.prepare("INSERT INTO customers (id, name, timezone, created_at, updated_at) VALUES (?, ?, 'UTC', ?, ?)").run(id, id, t, t)
  db.sql.prepare("INSERT INTO business_accounts (customer, classification, billing, environment, set_by, set_at) VALUES ('poolthru-llc', 'internal_live', 'complimentary', 'production', 'x', 1)").run()
  for (let i = 0; i < 3; i++) db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES (?, 'poolthru-llc', 'n', 'a@example.net', '1', 'x', 'new', 'h', ?, ?)").run(`l${i}`, t - DAY, t - DAY)
  db.sql.prepare("INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES ('other', 'acme', 'n', 'b@example.net', '1', 'x', 'new', 'h', ?, ?)").run(t, t)
  const o = await observatory(env)
  assert.deepEqual(o.businesses.map((b) => b.business), ['poolthru-llc'], 'a customer business is never read')
  const pt = o.businesses[0]
  assert.equal(pt.counts.leads, 3)
  assert.equal(pt.stages[0].sample, 'insufficient')
  assert.equal(pt.stages[0].rate, null, 'no rate from 3 leads')
  assert.equal(pt.providerAttendance.dataKind, 'missing')
  assert.equal(pt.money.spendKind, 'missing')
  assert.equal(o.crossAccount.enabled, false)
  assert.equal(CROSS_ACCOUNT.enabled, false)
  assert.ok(o.corporate.every((i) => ['measured', 'missing', 'estimated', 'test', 'unverified'].includes(i.dataKind)))
  const acc = accountability(await businessFunnel(env, 'poolthru-llc'))
  assert.ok(acc.losses.every((l) => ['unknown', 'data gap'].includes(l.attribution)), 'no blame without evidence')
})

test('evidence scan is dormant without enough data and creates nothing; decisions rank quantified ones by expected net value, unquantified last', async () => {
  const f = await session(FOUNDER)
  const r = await post(f, { action: 'scan' })
  assert.equal(r.data.dormant, true)
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM research_nodes WHERE kind = 'observation'").get().n, 0)
  const ranked = rankDecisions([
    { id: 'a', body: { benefitLow: 100, benefitHigh: 300, probability: 0.5, cost: 50 } },
    { id: 'b', body: {} },
    { id: 'c', body: { benefitLow: 1000, benefitHigh: 2000, probability: 0.3, cost: 100 } },
  ])
  assert.deepEqual(ranked.map((x) => x.id), ['c', 'a', 'b'])
  assert.deepEqual(ranked[1].value, { low: 0, mid: 50, high: 100 })
  assert.equal(ranked[2].value, null)
})

// ---------- isolation ----------
test('isolation: no customer-facing code or assistant imports research; no browser code contains the formulas', () => {
  const walk = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}${e.name}/`) : e.name.endsWith('.js') || e.name.endsWith('.jsx') ? [`${dir}${e.name}`] : []))
  const offenders = [...walk('../server/'), ...walk('../src/'), ...walk('../functions/')]
    .filter((f) => !f.includes('/research/') && !f.endsWith('research.test.js'))
    .filter((f) => /(from|import)\s*\(?\s*['"][^'"]*research\/(access|store|math|intelligence|programs)\.js['"]/.test(readFileSync(new URL(f, import.meta.url), 'utf8')))
  assert.deepEqual(offenders, [], 'only the research route and modules import server/research')
  for (const f of walk('../src/')) assert.ok(!readFileSync(new URL(f, import.meta.url), 'utf8').includes('v·a·√x'), `formula text in browser code: ${f}`)
})

test('no research records in the public repository: no file contains program or other research records (they belong in the vault)', () => {
  // Files Git tracks (what reaches the public repository); a git-ignored local file is fine.
  const root = new URL('../', import.meta.url)
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((f) => /\.(js|jsx|json|md|sql|mjs|txt|csv)$/.test(f))
  assert.ok(tracked.length > 100, 'git ls-files works here')
  // A research record in JSON form ({"kind": "program", "record": …}) is what the founder imports from a local file.
  const record = /"kind"\s*:\s*"(program|question|thesis|hypothesis|recommendation|evidence|experiment)"\s*,\s*"record"/
  const offenders = tracked.filter((f) => !f.endsWith('research.test.js') && record.test(readFileSync(new URL(f, root), 'utf8')))
  assert.deepEqual(offenders, [], 'research records must live in the vault (D1) or local ignored files, never in the repository')
})
