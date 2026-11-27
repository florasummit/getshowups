// One automated report into BOTH QA stores: the 0032 run record (ingestAutomatedRun, unchanged behaviour for browser
// results: replay keys, staleness, journey-linked rows) and the 0051 per-test results (every unit / browser / eval
// result matched to the inventory, with the hashes the run computed). Used by POST /api/qa/runs (CI, bearer
// QA_INGEST_TOKEN) and POST /api/platform/qa/import (a platform admin uploading a local or eval report).
// Extra body fields (all optional): executionId, hashes { <hash key>: { def, deps } }, results[].kind ('unit'|'e2e'|'eval'),
// results[].testId (evals), results[].costMicros, results[].model; event 'started' (+ ghRunId) for a dispatched run.
import { ingestAutomatedRun } from './qa.js'
import { matchResult } from './qa-tests.js'
import { qaCenterReady, storeResults } from './qa-results.js'
import { onResults } from './qa-items.js'
import { executionReported, executionStarted, getExecutionRow, recordedExecution } from './qa-executions.js'

const STATUS = { passed: 'pass', expected: 'pass', flaky: 'pass', pass: 'pass', failed: 'fail', unexpected: 'fail', timedOut: 'fail', fail: 'fail', interrupted: 'blocked', blocked: 'blocked', skipped: 'skipped', todo: 'skipped', cancelled: 'skipped' }
const HEX = /^[a-f0-9]{8,64}$/
// Durations the run reported (ms): the CI job's own elapsed time, node:test total, Playwright total. Anything else, or
// a value outside 0 … 6 h, is dropped: a duration is never estimated or filled in.
const MAX_MS = 6 * 3600_000
export function cleanDurations(d) {
  if (!d || typeof d !== 'object') return null
  const out = {}
  for (const k of ['jobMs', 'unitMs', 'e2eMs']) if (Number.isFinite(d[k]) && d[k] >= 0 && d[k] <= MAX_MS) out[k] = Math.round(d[k])
  return Object.keys(out).length ? out : null
}
const cleanHashes = (h) => {
  const out = {}
  if (!h || typeof h !== 'object') return out
  for (const [k, v] of Object.entries(h).slice(0, 5000)) if (k.length <= 200 && v && HEX.test(String(v.def || '')) && (v.deps == null || HEX.test(String(v.deps)))) out[k] = { def: v.def, deps: v.deps ?? null }
  return out
}

// A report without an execution (a main-branch CI run, an admin's import) is recorded as a FINISHED execution of its own
// (requested_by = the importing admin's ref, or system:ci), so every result belongs to a run with a commit, and the
// tests that passed again unchanged are listed compactly on it.
export async function ingestReport(env, body, now = Date.now(), { bodyHash = null, forceSource = null, actor = null } = {}) {
  const db = env.ONBOARDING_DB
  const executionId = body?.executionId != null ? String(body.executionId) : null
  if (executionId && !/^qx_[A-Za-z0-9_-]{6,40}$/.test(executionId)) return { error: 'invalid_request' }
  if (body?.event === 'started') {
    if (!executionId || !(await qaCenterReady(db))) return { error: 'invalid_request' }
    return executionStarted(env, { executionId, ghRunId: body.ghRunId, revision: body.revision }, now)
  }
  if (!Array.isArray(body?.results)) return { error: 'invalid_request' }
  if (forceSource) body = { ...body, source: forceSource }
  const ready = await qaCenterReady(db)
  const execution = executionId && ready ? await getExecutionRow(db, executionId) : null
  if (executionId && ready && !execution) return { error: 'unknown_execution' }
  // 0032: browser results only (unit / eval results are new kinds it never stored).
  // An empty report for an execution (nothing ran) only closes the execution: no "passed" run with zero tests.
  const legacy = body.results.length || !execution ? await ingestAutomatedRun(db, { ...body, results: body.results.filter((r) => r && r.kind !== 'unit' && r.kind !== 'eval') }, now, { bodyHash }) : { id: null, status: 'blocked', counts: { pass: 0, fail: 0, blocked: 0, not_tested: 0, total: 0 } }
  if (legacy.error) return legacy
  if (legacy.duplicate) return legacy
  // Before 0051: exactly the earlier behaviour.
  if (!ready) return legacy
  const hashes = cleanHashes(body.hashes)
  const rows = []
  let unmatched = 0
  let cost = 0
  for (const r of body.results.slice(0, 5000)) {
    const t = matchResult({ file: r?.file, title: r?.title, project: r?.project, testId: r?.kind === 'eval' ? r?.testId : null })
    if (!t) {
      unmatched++
      continue
    }
    const h = t.h ? hashes[t.h] : null
    const costMicros = Number.isFinite(r.costMicros) && r.costMicros >= 0 && r.costMicros <= 10_000_000 ? Math.round(r.costMicros) : null
    if (costMicros) cost += costMicros
    rows.push({ testId: t.id, status: STATUS[r.status] || 'blocked', actual: r.status && STATUS[r.status] !== 'pass' ? r.error : null, ms: r.durationMs, costMicros, model: r.model, defHash: h?.def ?? null, depsHash: h?.deps ?? null, provider: t.kind === 'eval' ? 'real' : body.provider })
  }
  // One row per test: a failure wins over a pass of the same test (retries, projects).
  const one = new Map()
  for (const r of rows) if (!one.has(r.testId) || r.status === 'fail') one.set(r.testId, r)
  const environment = body.source === 'local' ? 'local' : 'ci'
  const revision = /^[a-f0-9]{7,40}$/.test(String(body.revision || '')) ? body.revision : null
  const ex = execution ? executionId : (await recordedExecution(db, { environment, actor: actor || (environment === 'ci' ? 'system:ci' : 'system:import'), revision, tests: [...one.keys()], runUrl: body.artifactsUrl }, now)).id
  const unchanged = []
  const stored = await storeResults(db, [...one.values()], { executionId: ex, runId: legacy.id, environment, revision, provider: body.provider, dedupe: !execution, unchanged }, now)
  const items = await onResults(db, stored, now)
  await executionReported(env, ex, { runId: legacy.id, stored, costMicros: cost, unchanged, durations: environment === 'ci' ? cleanDurations(body.durations) : null }, now)
  return { ...legacy, executionId: ex, qa: { matched: one.size, stored: stored.length, unchanged: unchanged.length, unmatched, costMicros: cost, items } }
}
