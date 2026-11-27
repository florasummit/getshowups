// GET /api/platform/qa/executions/<id> — one execution: status, progress, events, results. Read-only.
import { json } from '../../../../../server/google-oauth.js'
import { qaGet } from '../../../../../server/ops/qa-route.js'
import { executionDetail } from '../../../../../server/ops/qa-executions.js'

export const onRequestGet = qaGet(async ({ env, params }) => {
  const d = await executionDetail(env.ONBOARDING_DB, String(params?.id || ''))
  return d ? json(200, d) : json(404, { error: 'not_found' })
})
