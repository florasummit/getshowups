// GET /api/platform/qa/inventory?area=&q=&status=&class=&kind=&detail=tests — the test hierarchy (platform → area →
// journey → feature → test) with per-node status counts. Without a filter it stops at features. Read-only.
import { json } from '../../../../server/google-oauth.js'
import { qaGet } from '../../../../server/ops/qa-route.js'
import { inventory } from '../../../../server/ops/qa-overview.js'
import { AREAS, CLASSES, KINDS } from '../../../../server/ops/qa-tests.js'
import { TEST_STATES } from '../../../../server/ops/qa-freshness.js'

export const onRequestGet = qaGet(async ({ env, url }) => {
  const p = url.searchParams
  const pick = (k, list) => (p.get(k) && list.includes(p.get(k)) ? p.get(k) : null)
  for (const [k, list] of [['area', AREAS.map((a) => a.id)], ['status', TEST_STATES], ['class', CLASSES], ['kind', KINDS]]) if (p.get(k) && !list.includes(p.get(k))) return json(400, { error: `invalid_${k}` })
  return json(200, await inventory(env, { area: pick('area', AREAS.map((a) => a.id)), q: p.get('q'), status: pick('status', TEST_STATES), cls: pick('class', CLASSES), kind: pick('kind', KINDS), detail: p.get('detail') === 'tests' }))
})
