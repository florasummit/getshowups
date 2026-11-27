// Defects + Product Improvement Backlog (platform admins).
//   GET  /api/platform/qa/items?group=defects|backlog&kind=&status=&area=&severity=&q=&limit=
//   POST /api/platform/qa/items { action: create | status | link | note | edit, ... }  (same-origin, audited)
// 'verified' is never accepted from a person: it comes only from a passing result recorded after the fix. Backlog
// entries change only here, by a platform admin; recording an idea starts nothing.
import { json } from '../../../../server/google-oauth.js'
import { audit } from '../../../../server/platform.js'
import { fail, qaGet, qaPost } from '../../../../server/ops/qa-route.js'
import { changeStatus, createItem, editItem, linkItem, listItems, noteItem } from '../../../../server/ops/qa-items.js'

export const onRequestGet = qaGet(async ({ env, url }) => {
  const p = url.searchParams
  const group = p.get('group')
  if (group && !['defects', 'backlog'].includes(group)) return json(400, { error: 'invalid_group' })
  const r = await listItems(env.ONBOARDING_DB, { group, kind: p.get('kind') || null, status: p.get('status') || null, area: p.get('area') || null, severity: p.get('severity') || null, q: p.get('q') || null, limit: Number(p.get('limit')) || 100 })
  return r.error ? fail(r) : json(200, r)
})

const ACTIONS = { create: createItem, status: changeStatus, link: linkItem, note: noteItem, edit: editItem }
export const onRequestPost = qaPost(async ({ env, body, admin, actor }) => {
  const fn = ACTIONS[body.action]
  if (!fn) return json(400, { error: 'invalid_action' })
  const r = await fn(env.ONBOARDING_DB, body, actor)
  if (r.error) return fail(r)
  await audit(env, admin.email, `qa.item_${body.action}`, null, { item: r.item.id, kind: r.item.kind, status: r.item.status })
  return json(body.action === 'create' ? 201 : 200, r)
})
