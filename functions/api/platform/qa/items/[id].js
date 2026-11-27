// GET /api/platform/qa/items/<id> — one defect / backlog entry: fields, full event history, linked tests with their
// current status, evidence (the item's own + its source result's). Read-only.
import { json } from '../../../../../server/google-oauth.js'
import { qaGet } from '../../../../../server/ops/qa-route.js'
import { getItemRow, itemEvents, presentItem } from '../../../../../server/ops/qa-items.js'
import { evidenceFor } from '../../../../../server/ops/qa-evidence.js'
import { freshness } from '../../../../../server/ops/qa-freshness.js'
import { getTest } from '../../../../../server/ops/qa-tests.js'

export const onRequestGet = qaGet(async ({ env, params }) => {
  const db = env.ONBOARDING_DB
  const r = await getItemRow(db, String(params?.id || ''))
  if (!r) return json(404, { error: 'not_found' })
  const item = presentItem(r)
  const { statuses } = await freshness(env)
  const tests = item.testIds.map((id) => ({ id, title: getTest(id)?.title ?? id, status: statuses.get(id)?.status ?? 'untested', last: statuses.get(id)?.last ?? null, lastPass: statuses.get(id)?.lastPass ?? null }))
  const evidence = [...(await evidenceFor(db, 'item', [item.id])), ...(item.sourceResult ? await evidenceFor(db, 'result', [item.sourceResult]) : [])]
  return json(200, { item, events: await itemEvents(db, item.id), tests, evidence })
})
