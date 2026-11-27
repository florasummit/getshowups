// QA executions (migration 0051): one requested run, persisted, so closing the browser loses nothing.
//   ci          → dispatched to GitHub Actions (qa-dispatch.js); the workflow reports "started" and then its results
//                 through POST /api/qa/runs. Bounded: ≤ 3 dispatch attempts (free runs only, and only when the earlier
//                 attempt never started); a paid run whose dispatch outcome is unknown is never re-sent.
//   production  → read-only checks run by the cron (≤ 25 per run, continues next run), results in the same tables.
//   manual      → a guided session: results come from people (POST /api/platform/qa/result with executionId).
// Status moves forward: queued → dispatched → running → passed | failed | partial | cancelled | refused | expired.
// Every transition is a qa_execution_events row (append-only). One ACTIVE execution per (environment, commit, scope)
// (unique index on dedupe_key). Paid evaluations reserve their worst case before dispatch (qa-spend.js) and settle to
// the reported cost; an expired paid run keeps its reservation (it may have spent it).
import { randomToken, sha256Hex } from '../google-oauth.js'
import { allTests, getTest } from './qa-tests.js'
import { cancelWorkflowRun, dispatchWorkflow, runUrlFor, workflowInputs } from './qa-dispatch.js'
import { reserveQa, settleQa, qaSettings } from './qa-spend.js'
import { compactUnchanged, resultsOf, storeResults } from './qa-results.js'
import { onResults } from './qa-items.js'
import { PROD_CHECKS, edgeContext, runCheck } from './qa-production-checks.js'
import { getCapability } from './registry.js'
import { buildInfo } from './changes.js'

const MIN = 60_000
export const ACTIVE = ['queued', 'dispatched', 'running']
export const FINAL = ['passed', 'failed', 'partial', 'cancelled', 'refused', 'expired']
export const START_TIMEOUT_MS = 30 * MIN
export const RUN_TIMEOUT_MS = 90 * MIN
export const MANUAL_TIMEOUT_MS = 7 * 24 * 60 * MIN
export const MAX_ATTEMPTS = 3
export const PROD_PER_RUN = 25
const ID_RE = /^qx_[A-Za-z0-9_-]{6,40}$/

const parse = (s, d) => {
  try {
    return JSON.parse(s ?? '') ?? d
  } catch {
    return d
  }
}
export function present(r, { withIds = false } = {}) {
  const scope = parse(r.scope, {})
  return {
    id: r.id,
    environment: r.environment,
    preset: r.preset,
    status: r.status,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    commit: r.revision,
    deployment: r.deployment,
    scope: { tests: (scope.tests || []).length, journeys: scope.journeys || [], ...(withIds ? { testIds: scope.tests || [] } : {}) },
    estimate: parse(r.estimate, {}),
    progress: { done: 0, total: (scope.tests || []).length, pass: 0, fail: 0, blocked: 0, skipped: 0, ...parse(r.progress, {}) },
    runUrl: r.run_url,
    runId: r.run_id,
    attempts: r.attempts,
    reason: r.reason,
    reservedMicros: r.reserved_micros,
    costMicros: r.cost_micros,
    updatedAt: r.updated_at,
    // Cancellable while active; a recorded report (preset 'report') is finished by its own request.
    cancellable: ACTIVE.includes(r.status) && r.preset !== 'report',
    unchanged: r.unchanged ? (() => { const u = parse(r.unchanged, null); return u ? { files: u.files?.length || 0, tests: u.tests?.length || 0 } : null })() : null,
  }
}
export const getExecutionRow = (db, id) => (ID_RE.test(String(id || '')) ? db.prepare('SELECT * FROM qa_executions WHERE id = ?1').bind(id).first() : null)

async function addEvent(db, id, from, to, actor, detail, now) {
  await db.prepare('INSERT INTO qa_execution_events (execution_id, at, from_status, to_status, actor, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, now, from, to, actor, JSON.stringify(detail || {}).slice(0, 1024)).run()
}
// Forward-only transition (conditional on the current status). → true when it applied.
export async function transition(db, id, from, to, actor, { set = {}, detail = {} } = {}, now = Date.now()) {
  const cols = Object.keys(set)
  const res = await db
    .prepare(`UPDATE qa_executions SET status = ?2, updated_at = ?3${cols.map((c, i) => `, ${c} = ?${i + 5}`).join('')} WHERE id = ?1 AND status = ?4`)
    .bind(id, to, now, from, ...cols.map((c) => set[c]))
    .run()
  if ((res?.meta?.changes ?? 0) === 0) return false
  await addEvent(db, id, from, to, actor, detail, now)
  return true
}

export async function executionEvents(db, id) {
  const { results } = await db.prepare('SELECT at, from_status, to_status, actor, detail FROM qa_execution_events WHERE execution_id = ?1 ORDER BY at, id').bind(id).all()
  return results.map((e) => ({ at: e.at, from: e.from_status, to: e.to_status, actor: e.actor, detail: parse(e.detail, {}) }))
}

// Create from a plan (qa-plan.js makePlan). → { execution } | { error, ...}
export async function createExecution(env, plan, actor, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const tests = plan._tests
  const ids = tests.map((t) => t.id).sort()
  const dedupeKey = (await sha256Hex(`${plan.environment}|${plan.commit || ''}|${ids.join(',')}`)).slice(0, 32)
  const active = await db.prepare(`SELECT id FROM qa_executions WHERE dedupe_key = ?1 AND status IN ('queued', 'dispatched', 'running')`).bind(dedupeKey).first()
  if (active) return { error: 'already_running', executionId: active.id }
  const id = `qx_${randomToken(9)}`
  const scope = { tests: ids, journeys: plan.scope.journeys, preset: plan.preset }
  const status = plan.environment === 'manual' ? 'running' : 'queued'
  try {
    await db
      .prepare('INSERT INTO qa_executions (id, requested_by, requested_at, environment, preset, scope, estimate, status, revision, progress, dedupe_key, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?3)')
      .bind(id, actor, now, plan.environment, plan.preset, JSON.stringify(scope), JSON.stringify(plan.estimate), status, plan.commit, JSON.stringify({ done: 0, total: ids.length }), dedupeKey, status === 'running' ? now : null)
      .run()
  } catch (err) {
    // The unique index refused a concurrent identical request: that one won.
    if (/UNIQUE/i.test(String(err?.message))) {
      const other = await db.prepare(`SELECT id FROM qa_executions WHERE dedupe_key = ?1 AND status IN ('queued', 'dispatched', 'running')`).bind(dedupeKey).first()
      return { error: 'already_running', executionId: other?.id ?? null }
    }
    throw err
  }
  await addEvent(db, id, null, status, actor, { tests: ids.length, preset: plan.preset }, now)
  if (plan.environment !== 'ci') return { execution: present(await getExecutionRow(db, id)) }
  // Paid evaluations: reserve the worst case first.
  if (plan.estimate.usdMicros > 0) {
    const r = await reserveQa(env, plan.estimate.usdMicros, now)
    if (!r.ok) {
      await transition(db, id, 'queued', 'refused', 'system:qa', { set: { reason: r.reason, finished_at: now }, detail: { reason: r.reason } }, now)
      return { error: 'not_runnable', reason: r.reason, text: r.text, executionId: id }
    }
    await db.prepare('UPDATE qa_executions SET reserved_micros = ?2, reserved_at = ?3 WHERE id = ?1').bind(id, r.reserved, r.at).run()
  }
  const d = await dispatchOnce(env, id, now)
  return { execution: present(await getExecutionRow(db, id)), dispatch: d }
}

async function dispatchOnce(env, id, now) {
  const db = env.ONBOARDING_DB
  const r = await getExecutionRow(db, id)
  if (!r || r.status !== 'queued') return { ok: false, code: 'not_queued' }
  const scope = parse(r.scope, {})
  const tests = (scope.tests || []).map(getTest).filter(Boolean)
  const inputs = workflowInputs(id, tests, allTests().list, { capUsd: (r.reserved_micros || 0) / 1e6 })
  await db.prepare('UPDATE qa_executions SET attempts = attempts + 1, updated_at = ?2 WHERE id = ?1').bind(id, now).run()
  const d = await dispatchWorkflow(env, inputs)
  if (d.ok) {
    await transition(db, id, 'queued', 'dispatched', 'system:qa', { set: { reason: null }, detail: { attempt: r.attempts + 1 } }, now)
    return d
  }
  if (d.code === 'unknown') {
    // Unknown outcome: the run may have started. Paid runs are never re-sent (the cron expires them); free runs wait
    // for a "started" report before any retry.
    await transition(db, id, 'queued', 'dispatched', 'system:qa', { set: { reason: 'dispatch_unknown' }, detail: { attempt: r.attempts + 1, outcome: 'unknown' } }, now)
    return d
  }
  await transition(db, id, 'queued', 'refused', 'system:qa', { set: { reason: `dispatch_${d.code}`, finished_at: now }, detail: { code: d.code, status: d.status ?? null } }, now)
  await releaseReservation(env, r, 0)
  return d
}
async function releaseReservation(env, r, actual) {
  if (r.reserved_micros > 0 && r.cost_micros == null) {
    await settleQa(env, { reserved: r.reserved_micros, at: r.reserved_at, actual })
    await env.ONBOARDING_DB.prepare('UPDATE qa_executions SET cost_micros = ?2 WHERE id = ?1 AND cost_micros IS NULL').bind(r.id, actual).run()
  }
}

export async function cancelExecution(env, id, actor, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const r = await getExecutionRow(db, id)
  if (!r) return { error: 'not_found' }
  if (!ACTIVE.includes(r.status)) return { error: 'not_active', status: r.status }
  let githubCancelled = null
  if (r.environment === 'ci' && r.gh_run_id) githubCancelled = (await cancelWorkflowRun(env, r.gh_run_id)).ok
  const ok = await transition(db, id, r.status, 'cancelled', actor, { set: { reason: 'cancelled_by_admin', finished_at: now }, detail: { githubCancelled } }, now)
  if (!ok) return { error: 'conflict' }
  // Not yet dispatched: nothing could have been spent. Dispatched paid runs keep their reservation until a report or expiry.
  if (r.status === 'queued') await releaseReservation(env, r, 0)
  return { execution: present(await getExecutionRow(db, id)), githubCancelled }
}

// Filters (mandate §6): release (commit prefix), date (from/to on requested_at), environment, status, preset, and by
// what ran in it: area, test, result (a result status present in the run), severity (runs that include a test linked to
// a defect of that severity). Content filters read qa_test_results (bounded) and keep the newest matching runs.
export async function listExecutions(db, { environment = null, status = null, preset = null, from = null, to = null, commit = null, before = null, limit = 50, area = null, test = null, result = null, severity = null } = {}) {
  const where = []
  const args = []
  const add = (sql, v) => {
    args.push(v)
    where.push(sql.replace('?', `?${args.length}`))
  }
  if (environment) add('environment = ?', environment)
  if (status) add('status = ?', status)
  if (preset) add('preset = ?', preset)
  if (Number.isFinite(from)) add('requested_at >= ?', from)
  if (Number.isFinite(to)) add('requested_at <= ?', to)
  if (Number.isFinite(before)) add('requested_at < ?', before)
  if (commit && /^[a-f0-9]{4,40}$/.test(commit)) add('revision LIKE ?', `${commit}%`)
  const max = Math.min(Math.max(1, Number(limit) || 50), 200)
  const content = area || test || result || severity
  let only = null
  if (content) {
    let ids = null
    if (test) ids = new Set([test])
    if (area) {
      const inArea = new Set(allTests().list.filter((t) => t.area === area).map((t) => t.id))
      ids = ids ? new Set([...ids].filter((x) => inArea.has(x))) : inArea
    }
    if (severity) {
      const { results: items } = await db.prepare("SELECT test_ids FROM qa_items WHERE kind IN ('bug', 'regression') AND severity = ?1 LIMIT 500").bind(severity).all()
      const linked = new Set(items.flatMap((i) => parse(i.test_ids, [])))
      ids = ids ? new Set([...ids].filter((x) => linked.has(x))) : linked
    }
    if (ids && !ids.size) return { executions: [], next: null }
    const w = ['execution_id IS NOT NULL']
    const a = []
    if (result) {
      a.push(result)
      w.push(`status = ?${a.length}`)
    }
    if (ids && ids.size <= 50) {
      w.push(`test_id IN (${[...ids].map((x) => (a.push(x), `?${a.length}`)).join(', ')})`)
    }
    if (Number.isFinite(from)) {
      a.push(from)
      w.push(`at >= ?${a.length}`)
    }
    const { results: rows } = await db.prepare(`SELECT DISTINCT execution_id, test_id FROM qa_test_results WHERE ${w.join(' AND ')} ORDER BY at DESC LIMIT 20000`).bind(...a).all()
    only = new Set(rows.filter((x) => !ids || ids.has(x.test_id)).map((x) => x.execution_id))
    if (!only.size) return { executions: [], next: null }
  }
  args.push(content ? 1000 : max)
  const { results } = await db.prepare(`SELECT * FROM qa_executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC LIMIT ?${args.length}`).bind(...args).all()
  const list = (only ? results.filter((r) => only.has(r.id)) : results).slice(0, max)
  return { executions: list.map((r) => present(r)), next: list.length === max ? list.at(-1).requested_at : null }
}

export async function executionDetail(db, id) {
  const r = await getExecutionRow(db, id)
  if (!r) return null
  const [events, results] = await Promise.all([executionEvents(db, id), resultsOf(db, id)])
  const next = r.environment === 'production' && ACTIVE.includes(r.status) ? 'Checks run in the background every 5 minutes; you can close this page.' : r.environment === 'ci' && ACTIVE.includes(r.status) ? 'Running in GitHub Actions; results arrive when the run finishes. You can close this page.' : null
  return { execution: { ...present(r, { withIds: true }), next }, events, results }
}

const progressOf = (results, total) => {
  const p = { done: 0, total, pass: 0, fail: 0, blocked: 0, skipped: 0 }
  for (const x of results) {
    p.done++
    if (x.status === 'pass') p.pass++
    else if (x.status === 'fail') p.fail++
    else if (x.status === 'blocked') p.blocked++
    else p.skipped++
  }
  return p
}
const finalStatus = (p) => (p.fail ? 'failed' : p.done < p.total || p.blocked || p.skipped ? 'partial' : 'passed')

// The workflow started (from the ingest): record GitHub's run id + page and the commit it checked out.
export async function executionStarted(env, { executionId, ghRunId, revision }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const r = await getExecutionRow(db, executionId)
  if (!r || r.environment !== 'ci') return { error: 'not_found' }
  if (!['queued', 'dispatched'].includes(r.status)) return { ok: true, status: r.status }
  const set = { started_at: now, reason: null }
  if (/^\d{1,20}$/.test(String(ghRunId || ''))) Object.assign(set, { gh_run_id: String(ghRunId), run_url: runUrlFor(env, ghRunId) })
  if (/^[a-f0-9]{7,40}$/.test(String(revision || ''))) set.revision = revision
  await transition(db, r.id, r.status, 'running', 'system:ci', { set, detail: { ghRunId: set.gh_run_id ?? null } }, now)
  return { ok: true, status: 'running' }
}

// A report that arrived without an execution: recorded as one (status running until executionReported finishes it).
export async function recordedExecution(db, { environment, actor, revision, tests, runUrl = null }, now = Date.now()) {
  const id = `qx_${randomToken(9)}`
  const url = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(String(runUrl || '')) ? runUrl : null
  await db
    .prepare("INSERT INTO qa_executions (id, requested_by, requested_at, environment, preset, scope, estimate, status, revision, run_url, progress, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'report', ?5, '{}', 'running', ?6, ?7, ?8, ?3, ?3)")
    .bind(id, actor, now, environment, JSON.stringify({ tests: [...tests].sort() }), revision, url, JSON.stringify({ done: 0, total: tests.length }))
    .run()
  await addEvent(db, id, null, 'running', actor, { recorded: true, tests: tests.length }, now)
  return { id }
}

// A report for an execution was stored (qa-ingest.js): progress, final status, cost settlement, unchanged passes.
export async function executionReported(env, executionId, { runId, stored, costMicros, unchanged = [] }, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const r = await getExecutionRow(db, executionId)
  if (!r) return null
  const scope = parse(r.scope, {})
  const inScope = new Set(scope.tests || [])
  const p = progressOf(stored.filter((x) => inScope.has(x.test_id)), inScope.size)
  // Unchanged passes count as done + pass (they passed; only the row was not repeated).
  const again = unchanged.filter((id) => inScope.has(id))
  p.done += again.length
  p.pass += again.length
  if (again.length) p.unchanged = again.length
  if (again.length) await db.prepare('UPDATE qa_executions SET unchanged = ?2 WHERE id = ?1').bind(r.id, JSON.stringify(compactUnchanged(again))).run()
  if (r.reserved_micros > 0 && r.cost_micros == null) await settleQa(env, { reserved: r.reserved_micros, at: r.reserved_at, actual: costMicros })
  await db.prepare('UPDATE qa_executions SET run_id = coalesce(run_id, ?2), progress = ?3, cost_micros = coalesce(cost_micros, 0) + ?4, updated_at = ?5 WHERE id = ?1').bind(r.id, runId, JSON.stringify(p), costMicros, now).run()
  if (ACTIVE.includes(r.status)) await transition(db, r.id, r.status, finalStatus(p), 'system:ci', { set: { finished_at: now }, detail: { pass: p.pass, fail: p.fail, done: p.done } }, now)
  return p
}

// ---------- cron: recovery, production verification, post-deploy queueing ----------
export async function queueProductionVerify(env, actor, { preset = 'production_verify', now = Date.now() } = {}) {
  const { makePlan } = await import('./qa-plan.js')
  const plan = await makePlan(env, { preset: 'production_verify' }, now)
  plan.preset = preset
  return createExecution(env, plan, actor, now)
}

async function runProductionBatch(env, r, now) {
  const db = env.ONBOARDING_DB
  const scope = parse(r.scope, {})
  const done = new Set((await resultsOf(db, r.id, 1000)).map((x) => x.testId))
  const todo = (scope.tests || []).filter((id) => !done.has(id)).slice(0, PROD_PER_RUN)
  if (r.status === 'queued') await transition(db, r.id, 'queued', 'running', 'system:cron', { set: { started_at: now } }, now)
  const build = await buildInfo(env)
  const rows = []
  const checks = new Map(PROD_CHECKS.map((c) => [c.id, c]))
  // Through the edge when the production origin answers; otherwise in process, labelled (never "verified").
  const ctx = todo.some((id) => checks.get(id)?.http) ? await edgeContext(env) : { mode: 'none' }
  let rateLimited = 0
  await Promise.all(
    todo.map(async (id) => {
      const t0 = Date.now()
      let out
      try {
        if (checks.has(id)) out = await withTimeout(runCheck(checks.get(id), env, ctx), 6000)
        else if (id.startsWith('prod:cap:')) out = await capabilityCheck(env, id.slice(9), now)
        else out = { status: 'skipped', actual: 'unknown check' }
      } catch (err) {
        out = { status: 'blocked', actual: `check error: ${err?.message === 'timeout' ? 'timeout' : err?.name || 'error'}` }
      }
      if (out.rateLimited) rateLimited++
      rows.push({ testId: id, status: out.status, actual: out.actual, expected: checks.get(id)?.expected ?? null, ms: Date.now() - t0, provider: 'real' })
    }),
  )
  const stored = await storeResults(db, rows, { executionId: r.id, environment: 'production', revision: build?.commit || r.revision, deployment: r.deployment, provider: 'real' }, now)
  await onResults(db, stored, now)
  const all = await resultsOf(db, r.id, 1000)
  const prev = parse(r.progress, {})
  const p = { ...progressOf(all.map((x) => ({ status: x.status, test_id: x.testId })), (scope.tests || []).length), mode: ctx.mode === 'none' ? prev.mode ?? null : ctx.mode, ...(ctx.mode === 'in_process' ? { modeReason: ctx.why } : {}), rateLimitRows: (prev.rateLimitRows || 0) + rateLimited }
  await db.prepare('UPDATE qa_executions SET progress = ?2, updated_at = ?3 WHERE id = ?1').bind(r.id, JSON.stringify(p), now).run()
  if (p.done >= p.total) await transition(db, r.id, 'running', finalStatus(p), 'system:cron', { set: { finished_at: now }, detail: { pass: p.pass, fail: p.fail, mode: p.mode, rateLimitRows: p.rateLimitRows } }, now)
  return { checked: rows.length, mode: ctx.mode }
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
// Capability production check: its configuration (state) and, where it has one, its read-only activity check (verify).
async function capabilityCheck(env, capId, now) {
  const c = getCapability(capId)
  if (!c) return { status: 'skipped', actual: 'capability no longer registered' }
  const s = (await withTimeout(Promise.resolve(c.state(env)), 4000)) || {}
  if (s.mode === 'disabled' || s.mode === 'missing') return { status: 'skipped', actual: `${s.mode}${s.note ? `: ${s.note}` : ''}${s.approval ? ` (approval: ${s.approval})` : ''}` }
  if (s.mode === 'unknown') return { status: 'blocked', actual: `configuration unknown${s.note ? `: ${s.note}` : ''}` }
  if (!c.verify) return { status: 'unverified', actual: `${s.mode}: configured; no activity check exists for it` }
  const v = await withTimeout(c.verify(env, now), 4000)
  if (s.mode === 'sandbox') return { status: 'unverified', actual: `sandbox: ${v?.evidence || 'no evidence'}` }
  return v?.ok ? { status: 'pass', actual: v.evidence || 'seen working' } : { status: 'unverified', actual: `live, not seen working recently: ${v?.evidence || 'no evidence'}` }
}

// The QA cron step (last in /api/cron/run): bounded, read-only toward everything but QA tables.
export async function qaCron(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const out = { expired: 0, redispatched: 0, production: 0, queued: null }
  const { results: active } = await db.prepare("SELECT * FROM qa_executions WHERE status IN ('queued', 'dispatched', 'running') ORDER BY requested_at LIMIT 50").all()
  for (const r of active) {
    if (r.environment === 'ci') {
      const age = now - (r.started_at || r.updated_at)
      if (r.status === 'running' && age > RUN_TIMEOUT_MS) {
        if (await transition(db, r.id, 'running', 'expired', 'system:cron', { set: { reason: 'no_report', finished_at: now } }, now)) out.expired++
      } else if (r.status === 'dispatched' && now - r.updated_at > START_TIMEOUT_MS) {
        if (!r.reserved_micros && r.attempts < MAX_ATTEMPTS && (await transition(db, r.id, 'dispatched', 'queued', 'system:cron', { detail: { retry: r.attempts + 1 } }, now))) {
          await dispatchOnce(env, r.id, now)
          out.redispatched++
        } else if (await transition(db, r.id, 'dispatched', 'expired', 'system:cron', { set: { reason: r.reserved_micros ? 'never_started_paid' : 'never_started', finished_at: now } }, now)) out.expired++
      } else if (r.status === 'queued' && now - r.updated_at > START_TIMEOUT_MS) {
        if (await transition(db, r.id, 'queued', 'expired', 'system:cron', { set: { reason: 'never_dispatched', finished_at: now } }, now)) {
          await releaseReservation(env, r, 0)
          out.expired++
        }
      }
    } else if (r.environment === 'manual' && now - r.requested_at > MANUAL_TIMEOUT_MS) {
      if (await transition(db, r.id, r.status, 'partial', 'system:cron', { set: { reason: 'manual_timeout', finished_at: now } }, now)) out.expired++
    }
  }
  // Production verification: one execution per run, ≤ PROD_PER_RUN checks.
  const prod = active.find((r) => r.environment === 'production')
  if (prod) out.production = (await runProductionBatch(env, prod, now)).checked
  // Post-deploy (always, free, read-only) and the optional daily schedule: queue one verification per new deployment.
  else {
    const build = await buildInfo(env)
    if (build?.commit) {
      const seen = await db.prepare("SELECT max(requested_at) AS at FROM qa_executions WHERE environment = 'production' AND revision = ?1 AND status NOT IN ('refused')").bind(build.commit).first()
      const daily = (await qaSettings(db)).values.schedule_production === 1
      if (!seen?.at || (daily && now - seen.at > 24 * 60 * MIN)) {
        const q = await queueProductionVerify(env, seen?.at ? 'system:schedule' : 'system:release', { now })
        out.queued = q.execution?.id ?? q.error ?? null
      }
    }
  }
  return out
}
