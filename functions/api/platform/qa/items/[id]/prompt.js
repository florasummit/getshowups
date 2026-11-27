// GET /api/platform/qa/items/<id>/prompt — a copyable Claude Code prompt from the item's recorded evidence
// (deterministic template, no model call). Read-only.
import { json } from '../../../../../../server/google-oauth.js'
import { qaGet } from '../../../../../../server/ops/qa-route.js'
import { getItemRow, presentItem } from '../../../../../../server/ops/qa-items.js'
import { evidenceFor } from '../../../../../../server/ops/qa-evidence.js'
import { testHistory } from '../../../../../../server/ops/qa-results.js'
import { itemPrompt } from '../../../../../../server/ops/qa-prompt.js'

export const onRequestGet = qaGet(async ({ env, params }) => {
  const db = env.ONBOARDING_DB
  const r = await getItemRow(db, String(params?.id || ''))
  if (!r) return json(404, { error: 'not_found' })
  const item = presentItem(r)
  const results = (await Promise.all(item.testIds.slice(0, 20).map((id) => testHistory(db, id, 1)))).flat()
  const evidence = [...(await evidenceFor(db, 'item', [item.id])), ...(await evidenceFor(db, 'result', [item.sourceResult, ...results.filter((x) => x.source === 'qa').map((x) => x.id)]))]
  return json(200, itemPrompt(item, { results, evidence }))
})
