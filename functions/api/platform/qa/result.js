// POST /api/platform/qa/result — a person records one test result (guided/manual QA, or a manual check of anything).
// { testId, status: pass|fail|blocked|skipped|unverified|retest_required, confirm: true, executionId? (a manual
//   execution), humanRunId? (an existing Testing-tab run: the step is recorded there too), actual?, expected?,
//   evidence?: [{ kind: log|transcript|link|record, text?|url? }] (≤ 5), aiAssessment?: { text, model? } }
// An AI assessment is stored as labelled evidence only; the status is always the person's. Append-only (a retest is a
// new row). Audited.
import { json } from '../../../../server/google-oauth.js'
import { audit } from '../../../../server/platform.js'
import { fail, qaPost } from '../../../../server/ops/qa-route.js'
import { getTest } from '../../../../server/ops/qa-tests.js'
import { STATUSES, presentResult, resultsOf, storeResults } from '../../../../server/ops/qa-results.js'
import { addEvidence, evidenceFor } from '../../../../server/ops/qa-evidence.js'
import { onResults } from '../../../../server/ops/qa-items.js'
import { getExecutionRow, transition } from '../../../../server/ops/qa-executions.js'
import { buildInfo } from '../../../../server/ops/changes.js'
import { recordStep } from '../../../../server/ops/qa.js'

const OLD = { pass: 'pass', fail: 'fail', blocked: 'blocked' }

export const onRequestPost = qaPost(async ({ env, body, admin, actor }) => {
  const db = env.ONBOARDING_DB
  if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
  const t = getTest(String(body.testId || ''))
  if (!t) return json(404, { error: 'not_found' })
  if (!STATUSES.includes(body.status)) return json(400, { error: 'invalid_status' })
  // A blocked step (functionality not available) can't be passed; recording that it is still blocked is allowed.
  if (t.blocked && !['blocked', 'fail', 'skipped', 'unverified'].includes(body.status)) return json(409, { error: 'test_blocked', reason: t.blocked })
  const evidence = Array.isArray(body.evidence) ? body.evidence.slice(0, 5) : []
  // Checked before anything is stored (a result is never left half-recorded).
  if (evidence.some((e) => !e || !['log', 'transcript', 'link', 'record'].includes(e.kind) || (e.kind === 'link' ? !/^https:\/\/[^\s<>"']{3,500}$/.test(String(e.url || e.text || '')) : !String(e.text || '').trim()))) return json(400, { error: 'invalid_evidence' })
  let execution = null
  if (body.executionId) {
    execution = await getExecutionRow(db, String(body.executionId))
    if (!execution || execution.environment !== 'manual') return json(404, { error: 'unknown_execution' })
    if (execution.status !== 'running') return json(409, { error: 'not_active' })
    if (!JSON.parse(execution.scope || '{}').tests?.includes(t.id)) return json(400, { error: 'not_in_scope' })
  }
  const now = Date.now()
  const build = await buildInfo(env)
  const [row] = await storeResults(db, [{ testId: t.id, status: body.status, actual: body.actual ?? body.note ?? null, expected: body.expected ?? t.steps?.expected ?? t.expected ?? null, reviewer: actor, confirmedAt: now }], { executionId: execution?.id ?? null, environment: 'manual', revision: build?.commit ?? null, provider: 'real' }, now)
  const ev = []
  for (const e of evidence) {
    const r = await addEvidence(db, { ownerKind: 'result', ownerId: row.id, kind: e.kind, text: e.text, url: e.url, by: actor }, now)
    if (r.error) return fail(r)
    ev.push(r.evidence.id)
  }
  if (body.aiAssessment?.text) {
    const label = `AI assessment${body.aiAssessment.model ? ` (${String(body.aiAssessment.model).replace(/[^\w.:@/-]/g, '').slice(0, 60)})` : ''}, not a verified result: ${body.aiAssessment.text}`
    const r = await addEvidence(db, { ownerKind: 'result', ownerId: row.id, kind: 'ai_assessment', text: label, by: actor }, now)
    if (r.error) return fail(r)
  }
  // Keep the Testing tab's guided run in step (same journey ids).
  const run = body.humanRunId && t.kind === 'human' ? await db.prepare("SELECT journey FROM qa_runs WHERE id = ?1 AND kind = 'human'").bind(String(body.humanRunId)).first() : null
  if (run && run.journey === t.journey) {
    const step = t.id.slice(6).split('.')[1]
    await recordStep(db, { run: String(body.humanRunId), step, status: OLD[body.status] || 'not_tested', observed: body.actual ?? '' }).catch(() => null)
  }
  const items = await onResults(db, [row], now)
  if (execution) {
    const all = await resultsOf(db, execution.id, 1000)
    const total = JSON.parse(execution.scope || '{}').tests?.length || 0
    const latest = new Map()
    for (const x of all) if (!latest.has(x.testId)) latest.set(x.testId, x)
    const vals = [...latest.values()]
    const p = { done: vals.length, total, pass: vals.filter((x) => x.status === 'pass').length, fail: vals.filter((x) => x.status === 'fail').length, blocked: vals.filter((x) => x.status === 'blocked').length, skipped: vals.filter((x) => !['pass', 'fail', 'blocked'].includes(x.status)).length }
    await db.prepare('UPDATE qa_executions SET progress = ?2, updated_at = ?3 WHERE id = ?1').bind(execution.id, JSON.stringify(p), now).run()
    if (p.done >= total) await transition(db, execution.id, 'running', p.fail ? 'failed' : p.blocked || p.skipped ? 'partial' : 'passed', actor, { set: { finished_at: now } }, now)
  }
  await audit(env, admin.email, 'qa.result_recorded', null, { test: t.id, status: body.status, result: row.id, execution: execution?.id ?? null, evidence: ev.length, aiAssessment: Boolean(body.aiAssessment?.text) })
  return json(201, { result: { ...presentResult(row), evidence: await evidenceFor(db, 'result', [row.id]) }, items })
})
