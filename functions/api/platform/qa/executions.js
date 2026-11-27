// GET /api/platform/qa/executions?environment=&status=&preset=&from=&to=&commit=&before=&limit=&area=&test=&result=&severity=
// — execution history (newest first). commit = release (commit prefix); area / test / result / severity filter by what
// ran in the execution (result = a result status present; severity = includes a test linked to a defect of that
// severity). Read-only.
import { json } from '../../../../server/google-oauth.js'
import { qaGet } from '../../../../server/ops/qa-route.js'
import { ACTIVE, FINAL, listExecutions } from '../../../../server/ops/qa-executions.js'
import { PRESETS } from '../../../../server/ops/qa-plan.js'
import { AREAS, getTest } from '../../../../server/ops/qa-tests.js'
import { STATUSES } from '../../../../server/ops/qa-results.js'
import { SEVERITIES } from '../../../../server/ops/qa-items.js'

export const onRequestGet = qaGet(async ({ env, url }) => {
  const p = url.searchParams
  const num = (k) => (/^\d{1,15}$/.test(p.get(k) || '') ? Number(p.get(k)) : null)
  const environment = p.get('environment')
  const status = p.get('status')
  const preset = p.get('preset')
  const area = p.get('area')
  const test = p.get('test')
  const result = p.get('result')
  const severity = p.get('severity')
  if (environment && !['ci', 'production', 'manual', 'local'].includes(environment)) return json(400, { error: 'invalid_environment' })
  if (status && ![...ACTIVE, ...FINAL].includes(status)) return json(400, { error: 'invalid_status' })
  if (preset && ![...PRESETS, 'report'].includes(preset)) return json(400, { error: 'invalid_preset' })
  if (area && !AREAS.some((a) => a.id === area)) return json(400, { error: 'invalid_area' })
  if (test && !getTest(test)) return json(400, { error: 'invalid_test' })
  if (result && !STATUSES.includes(result)) return json(400, { error: 'invalid_result' })
  if (severity && !SEVERITIES.includes(severity)) return json(400, { error: 'invalid_severity' })
  return json(200, await listExecutions(env.ONBOARDING_DB, { environment, status, preset, from: num('from'), to: num('to'), before: num('before'), commit: p.get('commit'), limit: num('limit') ?? 50, area, test, result, severity }))
})
