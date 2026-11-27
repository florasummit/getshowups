// QA results (migration 0051 qa_test_results): append-only. A retest is a new row (retest_of = the previous row of that
// test), so a failure is never overwritten. Readers merge the older 0032 rows (qa_results) in, labelled source
// 'legacy'. Writers: CI / eval reports (recordReport), the production cron (recordOne), people (recordOne, reviewer).
// Bounded writes: a large report without an execution stores failures + passes whose status, hashes or environment
// changed since that test's latest row (the same pass on the same code isn't stored again); reports for an execution
// store every result of its scope.
import { randomToken } from '../google-oauth.js'
import { linkedTests } from './journeys.js'
import { allTests, getTest } from './qa-tests.js'
import { redactEvidence } from './qa-evidence.js'

export const STATUSES = ['pass', 'fail', 'blocked', 'skipped', 'unverified', 'retest_required']
export const ENVIRONMENTS = ['ci', 'production', 'manual', 'local']
export const MAX_ROWS = 2000
const DECISIVE = ['pass', 'fail', 'blocked', 'retest_required']

export async function qaCenterReady(db) {
  try {
    await db.prepare('SELECT 1 FROM qa_test_results LIMIT 1').first()
    return true
  } catch {
    return false
  }
}

const clip = (s, n) => (s == null || s === '' ? null : redactEvidence(s, n))
const row = (r) => ({
  id: r.id,
  source: 'qa',
  executionId: r.execution_id,
  runId: r.run_id,
  testId: r.test_id,
  title: getTest(r.test_id)?.title ?? r.test_id,
  environment: r.environment,
  revision: r.revision,
  deployment: r.deployment,
  status: r.status,
  expected: r.expected,
  actual: r.actual,
  ms: r.ms,
  costMicros: r.cost_micros,
  model: r.model,
  provider: r.provider,
  reviewer: r.reviewer,
  confirmedAt: r.confirmed_at,
  evidence: parseList(r.evidence),
  retestOf: r.retest_of,
  at: r.at,
  defHash: r.def_hash,
  depsHash: r.deps_hash,
})
const parseList = (s) => {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
export const presentResult = row

const COLS = ['id', 'execution_id', 'run_id', 'test_id', 'environment', 'revision', 'deployment', 'def_hash', 'deps_hash', 'status', 'expected', 'actual', 'ms', 'cost_micros', 'model', 'provider', 'reviewer', 'confirmed_at', 'evidence', 'retest_of', 'at']
const PER_STATEMENT = Math.floor(100 / COLS.length) // D1: ≤ 100 bound parameters per statement
async function insertRows(db, rows) {
  const stmts = []
  for (let i = 0; i < rows.length; i += PER_STATEMENT) {
    const chunk = rows.slice(i, i + PER_STATEMENT)
    const values = chunk.map((_, j) => `(${COLS.map((__, k) => `?${j * COLS.length + k + 1}`).join(', ')})`).join(', ')
    stmts.push(db.prepare(`INSERT INTO qa_test_results (${COLS.join(', ')}) VALUES ${values}`).bind(...chunk.flatMap((r) => COLS.map((c) => r[c] ?? (c === 'evidence' ? '[]' : null)))))
  }
  if (db.batch && stmts.length > 1) await db.batch(stmts)
  else for (const s of stmts) await s.run()
}

// Latest row per test (optionally only some statuses). → Map test_id → raw row
export async function latestRows(db, { statuses = null, testIds = null } = {}) {
  const where = []
  const args = []
  if (statuses) where.push(`status IN (${statuses.map((s) => `'${s}'`).join(', ')})`)
  if (testIds) {
    if (!testIds.length) return new Map()
    if (testIds.length <= 90) {
      where.push(`test_id IN (${testIds.map((_, i) => `?${i + 1}`).join(', ')})`)
      args.push(...testIds)
    }
  }
  const q = `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY test_id ORDER BY at DESC, id DESC) AS rn FROM qa_test_results ${where.length ? `WHERE ${where.join(' AND ')}` : ''}) WHERE rn = 1`
  const { results } = await db.prepare(q).bind(...args).all()
  const want = testIds && testIds.length > 90 ? new Set(testIds) : null
  return new Map(results.filter((r) => !want || want.has(r.test_id)).map((r) => [r.test_id, r]))
}

// Older 0032 rows as results of inventory tests (journey-linked browser tests and human steps). Bounded to 90 days.
const LEGACY_STATUS = { pass: 'pass', fail: 'fail', blocked: 'blocked', not_tested: 'skipped' }
let legacyIds = null
function legacyMap(id) {
  if (!legacyIds) {
    legacyIds = new Map()
    const tests = allTests().list.filter((t) => t.kind === 'e2e')
    for (const lt of linkedTests()) {
      const t = tests.find((x) => !x.mobile && x.file.endsWith(`/${lt.spec}`) && x.title.startsWith(lt.title))
      if (t) legacyIds.set(lt.id, t.id)
    }
  }
  const [base, project] = String(id).split('@')
  if (legacyIds.has(base)) return project === 'mobile' ? `${legacyIds.get(base)}.mobile` : legacyIds.get(base)
  if (/^[a-z-]+\.[a-z-]+$/.test(base) && getTest(`human:${base}`)) return `human:${base}`
  return null
}
export async function legacyRows(db, { since = Date.now() - 90 * 86_400_000, testId = null, limit = 2000 } = {}) {
  try {
    const { results } = await db
      .prepare(`SELECT q.run_id, q.test_id, q.status, q.observed, q.ms, q.at, r.revision, r.source, r.provider, r.kind, r.tester FROM qa_results q JOIN qa_runs r ON r.id = q.run_id WHERE q.at >= ?1 ORDER BY q.at DESC LIMIT ?2`)
      .bind(since, limit)
      .all()
    const out = []
    for (const x of results) {
      const id = legacyMap(x.test_id)
      if (!id || (testId && id !== testId)) continue
      out.push({ id: `legacy:${x.run_id}:${x.test_id}`, source: 'legacy', executionId: null, runId: x.run_id, testId: id, title: getTest(id)?.title ?? id, environment: x.kind === 'human' ? 'manual' : x.source === 'local' ? 'local' : 'ci', revision: x.revision, deployment: null, status: LEGACY_STATUS[x.status] || 'blocked', expected: null, actual: x.observed, ms: x.ms, costMicros: null, model: null, provider: x.provider, reviewer: x.kind === 'human' ? x.tester : null, confirmedAt: x.kind === 'human' ? x.at : null, evidence: [], retestOf: null, at: x.at, defHash: null, depsHash: null })
    }
    return out
  } catch {
    return []
  }
}

// Latest decisive result and latest pass per test, new + legacy. → { decisive: Map, pass: Map } of presented results
export async function latestByTest(db) {
  const [d, p, a, legacy] = await Promise.all([latestRows(db, { statuses: DECISIVE }), latestRows(db, { statuses: ['pass'] }), latestRows(db), legacyRows(db)])
  const decisive = new Map([...d].map(([k, v]) => [k, row(v)]))
  const pass = new Map([...p].map(([k, v]) => [k, row(v)]))
  // The latest result of any status (skipped / unverified included: shown, never counted as verified).
  const any = new Map([...a].map(([k, v]) => [k, row(v)]))
  for (const l of legacy) {
    if (DECISIVE.includes(l.status) && !(decisive.get(l.testId)?.at >= l.at)) decisive.set(l.testId, l)
    if (l.status === 'pass' && !(pass.get(l.testId)?.at >= l.at)) pass.set(l.testId, l)
    if (!(any.get(l.testId)?.at >= l.at)) any.set(l.testId, l)
  }
  // Later identical passes recorded compactly by runs: they move "last verified" forward (keeping the stored row's hashes).
  const runs = (await unchangedRuns(db, { limit: 30 })).reverse()
  const byFile = new Map()
  if (runs.length) for (const t of allTests().list) if (t.file && (t.kind === 'unit' || t.kind === 'e2e')) byFile.set(t.file, [...(byFile.get(t.file) || []), t.id])
  for (const e of runs) {
    const ids = [...e.u.tests, ...e.u.files.flatMap((f) => byFile.get(f) || [])]
    for (const id of ids) {
      const c = confirmation(e, id)
      const p = pass.get(id)
      if (!p || p.at >= c.at) continue
      const withHashes = { ...c, defHash: p.defHash, depsHash: p.depsHash }
      pass.set(id, withHashes)
      if (!(decisive.get(id)?.at >= c.at)) decisive.set(id, withHashes)
      if (!(any.get(id)?.at >= c.at)) any.set(id, withHashes)
    }
  }
  return { decisive, pass, any }
}

export async function testHistory(db, testId, limit = 50) {
  const { results } = await db.prepare('SELECT * FROM qa_test_results WHERE test_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2').bind(testId, limit).all()
  const legacy = await legacyRows(db, { testId, since: 0, limit: 500 })
  const t = getTest(testId)
  const again = await unchangedRuns(db, { like: [`"${testId}"`, ...(t?.file ? [`"${t.file}"`] : [])], limit: 30 })
  const confirmations = again.filter((e) => covers(e, t)).map((e) => confirmation(e, testId))
  return [...results.map(row), ...legacy, ...confirmations].sort((a, b) => b.at - a.at).slice(0, limit)
}

// "Passed again, identical code" records: executions whose compact `unchanged` list covers a test.
export function compactUnchanged(ids) {
  const set = new Set(ids)
  const files = []
  const tests = []
  const byFile = new Map()
  for (const id of set) {
    const t = getTest(id)
    if (!t?.file || (t.kind !== 'unit' && t.kind !== 'e2e')) tests.push(id)
    else byFile.set(t.file, [...(byFile.get(t.file) || []), id])
  }
  for (const [file, list] of byFile) {
    const all = allTests().list.filter((t) => t.file === file && (t.kind === 'unit' || t.kind === 'e2e'))
    if (all.every((t) => set.has(t.id))) files.push(file)
    else tests.push(...list)
  }
  return { files: files.sort(), tests: tests.sort() }
}
const parseU = (s) => {
  try {
    const v = JSON.parse(s || 'null')
    return v && Array.isArray(v.files) && Array.isArray(v.tests) ? v : { files: [], tests: [] }
  } catch {
    return { files: [], tests: [] }
  }
}
async function unchangedRuns(db, { like = null, limit = 30 } = {}) {
  try {
    const where = like ? `AND (${like.map((_, i) => `unchanged LIKE ?${i + 2}`).join(' OR ')})` : ''
    const { results } = await db.prepare(`SELECT id, environment, revision, deployment, run_id, finished_at, requested_at, unchanged FROM qa_executions WHERE unchanged IS NOT NULL ${where} ORDER BY requested_at DESC LIMIT ?1`).bind(limit, ...(like || []).map((x) => `%${x}%`)).all()
    return results.map((e) => ({ ...e, u: parseU(e.unchanged) }))
  } catch {
    return []
  }
}
const covers = (e, t) => Boolean(t && (e.u.tests.includes(t.id) || (t.file && e.u.files.includes(t.file))))
const confirmation = (e, testId) => ({ id: `unchanged:${e.id}:${testId}`, source: 'unchanged', executionId: e.id, runId: e.run_id, testId, title: getTest(testId)?.title ?? testId, environment: e.environment, revision: e.revision, deployment: e.deployment, status: 'pass', expected: null, actual: 'Passed again with identical code and dependencies (recorded in the run, not as its own row)', ms: null, costMicros: null, model: null, provider: null, reviewer: null, confirmedAt: null, evidence: [], retestOf: null, at: e.finished_at || e.requested_at, defHash: null, depsHash: null })

export async function resultsOf(db, executionId, limit = 500) {
  const { results } = await db.prepare("SELECT * FROM qa_test_results WHERE execution_id = ?1 ORDER BY status = 'pass', at LIMIT ?2").bind(executionId, limit).all()
  return results.map(row)
}

// Store results (already matched to inventory tests). input rows: { testId, status, expected?, actual?, ms?, costMicros?,
// model?, defHash?, depsHash?, reviewer?, confirmedAt?, evidence? }. → stored rows (raw)
// `unchanged` (an array) collects the test ids a deduped report passed again with identical hashes (not stored as rows;
// the execution records them compactly, see compactUnchanged).
export async function storeResults(db, rows, { executionId = null, runId = null, environment, revision = null, deployment = null, provider = null, dedupe = false, unchanged = null }, now = Date.now()) {
  if (!ENVIRONMENTS.includes(environment)) throw new Error('invalid environment')
  const list = rows.filter((r) => STATUSES.includes(r.status) && getTest(r.testId)).slice(0, MAX_ROWS)
  if (!list.length) return []
  const prev = await latestRows(db, { testIds: [...new Set(list.map((r) => r.testId))] })
  const out = []
  for (const r of list) {
    const p = prev.get(r.testId)
    if (dedupe && r.status === 'pass' && p && p.status === 'pass' && p.environment === environment && p.def_hash === (r.defHash ?? null) && p.deps_hash === (r.depsHash ?? null) && (p.revision === revision || (p.def_hash && p.deps_hash))) {
      unchanged?.push(r.testId)
      continue
    }
    out.push({
      id: `qr_${randomToken(9)}`,
      execution_id: executionId,
      run_id: runId,
      test_id: r.testId,
      environment,
      revision,
      deployment,
      def_hash: r.defHash ?? null,
      deps_hash: r.depsHash ?? null,
      status: r.status,
      expected: clip(r.expected, 500),
      actual: clip(r.actual, 1024),
      ms: Number.isFinite(r.ms) ? Math.round(r.ms) : null,
      cost_micros: Number.isFinite(r.costMicros) && r.costMicros >= 0 ? Math.round(r.costMicros) : null,
      model: r.model ? String(r.model).replace(/[^\w.:@/-]/g, '').slice(0, 80) : null,
      provider: ['mocked', 'real'].includes(r.provider ?? provider) ? (r.provider ?? provider) : null,
      reviewer: r.reviewer ?? null,
      confirmed_at: r.confirmedAt ?? null,
      evidence: JSON.stringify(Array.isArray(r.evidence) ? r.evidence.slice(0, 20) : []),
      retest_of: p?.id ?? null,
      at: now,
    })
  }
  await insertRows(db, out)
  return out
}
