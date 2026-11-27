// POST /api/platform/qa/run { <the /plan body>, confirm: true, rerun?: true, planId? } — start an execution.
//   ci          dispatched to GitHub Actions (refused with the reason when CI isn't set up; never queued forever)
//   production  queued for the cron's read-only checks
//   manual      a guided session (results recorded by people)
// Refused: not confirmed (400 confirmation_required), plan changed since it was shown (409 plan_changed), same scope
// already active (409 already_running), results already on this commit without rerun (409 duplicate_results), not
// runnable (403 not_runnable + reason + text), paid without budget (403). Audited.
import { json } from '../../../../server/google-oauth.js'
import { audit } from '../../../../server/platform.js'
import { fail, qaPost } from '../../../../server/ops/qa-route.js'
import { makePlan, publicPlan } from '../../../../server/ops/qa-plan.js'
import { createExecution } from '../../../../server/ops/qa-executions.js'

export const onRequestPost = qaPost(
  async ({ env, body, admin, actor }) => {
    if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
    const plan = await makePlan(env, body)
    if (body.planId && body.planId !== plan.planId) return json(409, { error: 'plan_changed', plan: publicPlan(plan) })
    if (!plan.runnable) return json(403, { error: 'not_runnable', reason: plan.refusal.code, text: plan.refusal.text })
    if (plan.duplicate && body.rerun !== true) return json(409, { error: 'duplicate_results', duplicate: plan.duplicate })
    const r = await createExecution(env, plan, actor)
    await audit(env, admin.email, 'qa.execution_requested', null, { execution: r.execution?.id ?? r.executionId ?? null, environment: plan.environment, preset: plan.preset, tests: plan.scope.tests, usdMicros: plan.estimate.usdMicros, outcome: r.error || r.execution?.status })
    if (r.error) return fail(r)
    return json(201, { execution: r.execution, ...(r.dispatch && !r.dispatch.ok ? { dispatch: { ok: false, code: r.dispatch.code } } : {}) })
  },
  { rule: 'qaCenterRun', maxBytes: 200_000 },
)
