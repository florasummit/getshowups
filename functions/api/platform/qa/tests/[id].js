// GET /api/platform/qa/tests/<test id> — one test: definition, class, current status, full history (newest first,
// legacy rows included), evidence and linked items. Read-only.
import { json } from '../../../../../server/google-oauth.js'
import { qaGet } from '../../../../../server/ops/qa-route.js'
import { testDetail } from '../../../../../server/ops/qa-overview.js'

export const onRequestGet = qaGet(async ({ env, params }) => {
  const id = decodeURIComponent(String(params?.id || ''))
  if (!/^[a-z0-9:._-]{3,160}$/.test(id)) return json(404, { error: 'not_found' })
  const d = await testDetail(env, id)
  return d ? json(200, d) : json(404, { error: 'not_found' })
})
