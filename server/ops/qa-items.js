// Defects + Product Improvement Backlog in ONE table (migration 0051 qa_items; history in qa_item_events, append-only).
// Defects (bug, regression): open → in_progress → fixed_pending_qa (needs a fix reference: PR or commit) → verified ONLY
// when every linked test has a PASSING result recorded after the fix (onResults), never because a fix was merged; a
// linked test failing after the fix reopens it (history kept). wont_fix is a person's decision.
// Backlog (feature, ux, ai, performance, cost, tech_debt, observation): inbox | under_review | planned | in_progress |
// awaiting_qa | released | deferred, changed ONLY by a platform admin: recording an idea never starts work, and no
// result, release or assistant ever moves a backlog entry.
import { randomToken } from '../google-oauth.js'
import { getTest } from './qa-tests.js'
import { redactEvidence } from './qa-evidence.js'
import { AREAS } from './qa-inventory.generated.js'

export const DEFECT_KINDS = ['bug', 'regression']
export const BACKLOG_KINDS = ['feature', 'ux', 'ai', 'performance', 'cost', 'tech_debt', 'observation']
export const DEFECT_STATUSES = ['open', 'in_progress', 'fixed_pending_qa', 'verified', 'wont_fix']
export const BACKLOG_STATUSES = ['inbox', 'under_review', 'planned', 'in_progress', 'awaiting_qa', 'released', 'deferred']
export const SEVERITIES = ['critical', 'high', 'medium', 'low']
export const PRIORITIES = ['p1', 'p2', 'p3', 'p4']
const isDefect = (kind) => DEFECT_KINDS.includes(kind)
export const groupOf = (kind) => (isDefect(kind) ? 'defects' : 'backlog')
const ID_RE = /^qi_[A-Za-z0-9_-]{6,40}$/
const AREA_IDS = new Set(AREAS.map((a) => a.id))

const parse = (s, d) => {
  try {
    return JSON.parse(s ?? '') ?? d
  } catch {
    return d
  }
}
export const presentItem = (r) => ({
  id: r.id,
  kind: r.kind,
  group: groupOf(r.kind),
  title: r.title,
  description: r.description,
  expected: r.expected,
  actual: r.actual,
  steps: r.steps,
  area: r.area,
  feature: r.feature,
  severity: r.severity,
  priority: r.priority,
  customerImpact: r.customer_impact,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  testIds: parse(r.test_ids, []),
  refs: { pr: null, commit: null, release: null, ...parse(r.refs, {}) },
  sourceResult: r.source_result,
  fixedAt: r.fixed_at,
  verifiedBy: r.verified_by,
})

const text = (v, n) => (v == null || String(v).trim() === '' ? null : redactEvidence(v, n).trim())
const cleanRefs = (refs = {}) => {
  const out = {}
  if (refs.pr != null && refs.pr !== '') {
    const n = Number(String(refs.pr).replace(/^#/, ''))
    if (!Number.isInteger(n) || n <= 0 || n > 1e7) return { error: 'invalid_pr' }
    out.pr = n
  }
  if (refs.commit != null && refs.commit !== '') {
    if (!/^[a-f0-9]{7,40}$/.test(String(refs.commit))) return { error: 'invalid_commit' }
    out.commit = String(refs.commit)
  }
  if (refs.release != null && refs.release !== '') {
    if (!/^[A-Za-z0-9._:-]{3,60}$/.test(String(refs.release))) return { error: 'invalid_release' }
    out.release = String(refs.release)
  }
  return { refs: out }
}
const cleanTests = (ids) => {
  if (ids == null) return { ids: null }
  if (!Array.isArray(ids) || ids.length > 50) return { error: 'invalid_tests' }
  const list = [...new Set(ids.map(String))]
  if (!list.every((id) => getTest(id))) return { error: 'unknown_test' }
  return { ids: list }
}
function fields(b, kind) {
  const f = {}
  if (b.title !== undefined) {
    f.title = text(b.title, 160)
    if (!f.title) return { error: 'title_required' }
  }
  for (const [k, col, n] of [['description', 'description', 4000], ['expected', 'expected', 1000], ['actual', 'actual', 1000], ['steps', 'steps', 2000], ['customerImpact', 'customer_impact', 500]]) if (b[k] !== undefined) f[col] = text(b[k], n)
  if (b.area !== undefined) {
    if (b.area !== null && !AREA_IDS.has(b.area)) return { error: 'invalid_area' }
    f.area = b.area
  }
  if (b.feature !== undefined) {
    if (b.feature !== null && !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(String(b.feature))) return { error: 'invalid_feature' }
    f.feature = b.feature
  }
  if (b.severity !== undefined) {
    if (b.severity !== null && !SEVERITIES.includes(b.severity)) return { error: 'invalid_severity' }
    f.severity = b.severity
  }
  if (b.priority !== undefined) {
    if (b.priority !== null && !PRIORITIES.includes(b.priority)) return { error: 'invalid_priority' }
    f.priority = b.priority
  }
  if (!isDefect(kind) && f.severity) f.severity = null
  return { f }
}

async function event(db, itemId, { actor, type, from = null, to = null, detail = {} }, now) {
  await db.prepare('INSERT INTO qa_item_events (item_id, at, actor, type, from_status, to_status, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(itemId, now, actor, type, from, to, JSON.stringify(detail).slice(0, 1024)).run()
}
export const getItemRow = (db, id) => (ID_RE.test(String(id || '')) ? db.prepare('SELECT * FROM qa_items WHERE id = ?1').bind(id).first() : null)

export async function createItem(db, b, actor, now = Date.now()) {
  const kind = b.kind
  if (![...DEFECT_KINDS, ...BACKLOG_KINDS].includes(kind)) return { error: 'invalid_kind' }
  if (b.title === undefined) return { error: 'title_required' }
  const { f, error } = fields(b, kind)
  if (error) return { error }
  const t = cleanTests(b.testIds ?? [])
  if (t.error) return { error: t.error }
  const r = cleanRefs(b.refs || {})
  if (r.error) return { error: r.error }
  let testIds = t.ids
  let source = null
  if (b.fromResult) {
    const res = /^qr_[A-Za-z0-9_-]{6,40}$/.test(String(b.fromResult)) ? await db.prepare('SELECT id, test_id, actual, expected FROM qa_test_results WHERE id = ?1').bind(b.fromResult).first() : null
    if (!res) return { error: 'result_not_found' }
    source = res.id
    if (!testIds.includes(res.test_id)) testIds = [...testIds, res.test_id]
    f.actual ??= res.actual
    f.expected ??= res.expected
    const test = getTest(res.test_id)
    f.area ??= test?.area ?? null
    f.feature ??= test?.feature ?? null
  }
  const status = isDefect(kind) ? 'open' : 'inbox'
  if (isDefect(kind)) f.severity ??= 'medium'
  const id = `qi_${randomToken(9)}`
  await db
    .prepare('INSERT INTO qa_items (id, kind, title, description, expected, actual, steps, area, feature, severity, priority, customer_impact, status, created_by, created_at, updated_at, test_ids, refs, source_result) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?16, ?17, ?18)')
    .bind(id, kind, f.title, f.description ?? null, f.expected ?? null, f.actual ?? null, f.steps ?? null, f.area ?? null, f.feature ?? null, f.severity ?? null, f.priority ?? null, f.customer_impact ?? null, status, actor, now, JSON.stringify(testIds), JSON.stringify(r.refs), source)
    .run()
  await event(db, id, { actor, type: 'created', to: status, detail: source ? { fromResult: source } : {} }, now)
  return { item: presentItem(await getItemRow(db, id)) }
}

export async function changeStatus(db, { id, status, note = null }, actor, now = Date.now()) {
  const r = await getItemRow(db, id)
  if (!r) return { error: 'not_found' }
  const allowed = isDefect(r.kind) ? DEFECT_STATUSES : BACKLOG_STATUSES
  if (!allowed.includes(status)) return { error: 'invalid_status' }
  if (status === 'verified') return { error: 'verified_by_results_only' }
  if (status === r.status) return { item: presentItem(r) }
  const refs = parse(r.refs, {})
  if (status === 'fixed_pending_qa' && !refs.pr && !refs.commit) return { error: 'fix_ref_required' }
  if (status === 'fixed_pending_qa' && !parse(r.test_ids, []).length) return { error: 'tests_required' }
  const fixedAt = status === 'fixed_pending_qa' ? now : r.fixed_at
  const res = await db.prepare('UPDATE qa_items SET status = ?2, updated_at = ?3, fixed_at = ?4, verified_by = NULL WHERE id = ?1 AND status = ?5').bind(r.id, status, now, fixedAt, r.status).run()
  if ((res?.meta?.changes ?? 0) === 0) return { error: 'conflict' }
  await event(db, r.id, { actor, type: 'status', from: r.status, to: status, detail: note ? { note: text(note, 300) } : {} }, now)
  return { item: presentItem(await getItemRow(db, r.id)) }
}

export async function linkItem(db, { id, pr, commit, release, testIds }, actor, now = Date.now()) {
  const r = await getItemRow(db, id)
  if (!r) return { error: 'not_found' }
  const c = cleanRefs({ pr, commit, release })
  if (c.error) return { error: c.error }
  const t = cleanTests(testIds)
  if (t.error) return { error: t.error }
  const refs = { ...parse(r.refs, {}), ...c.refs }
  const tests = t.ids ? [...new Set([...parse(r.test_ids, []), ...t.ids])] : parse(r.test_ids, [])
  await db.prepare('UPDATE qa_items SET refs = ?2, test_ids = ?3, updated_at = ?4 WHERE id = ?1').bind(r.id, JSON.stringify(refs), JSON.stringify(tests), now).run()
  await event(db, r.id, { actor, type: 'link', detail: { ...c.refs, ...(t.ids ? { testIds: t.ids } : {}) } }, now)
  return { item: presentItem(await getItemRow(db, r.id)) }
}

export async function noteItem(db, { id, text: t }, actor, now = Date.now()) {
  const r = await getItemRow(db, id)
  if (!r) return { error: 'not_found' }
  const note = text(t, 1000)
  if (!note) return { error: 'text_required' }
  await db.prepare('UPDATE qa_items SET updated_at = ?2 WHERE id = ?1').bind(r.id, now).run()
  await event(db, r.id, { actor, type: 'note', detail: { note } }, now)
  return { item: presentItem(await getItemRow(db, r.id)) }
}

export async function editItem(db, b, actor, now = Date.now()) {
  const r = await getItemRow(db, b.id)
  if (!r) return { error: 'not_found' }
  const { f, error } = fields(b, r.kind)
  if (error) return { error }
  const cols = Object.keys(f)
  if (!cols.length) return { item: presentItem(r) }
  await db.prepare(`UPDATE qa_items SET ${cols.map((c, i) => `${c} = ?${i + 3}`).join(', ')}, updated_at = ?2 WHERE id = ?1`).bind(r.id, now, ...cols.map((c) => f[c])).run()
  await event(db, r.id, { actor, type: 'edit', detail: { fields: cols } }, now)
  return { item: presentItem(await getItemRow(db, r.id)) }
}

export async function listItems(db, { group = null, kind = null, status = null, area = null, severity = null, q = null, limit = 100 } = {}) {
  const where = []
  const args = []
  const kinds = kind ? [kind] : group === 'defects' ? DEFECT_KINDS : group === 'backlog' ? BACKLOG_KINDS : null
  if (kinds) where.push(`kind IN (${kinds.map((k) => `'${k.replace(/[^a-z_]/g, '')}'`).join(', ')})`)
  for (const [col, v, list] of [['status', status, [...DEFECT_STATUSES, ...BACKLOG_STATUSES]], ['area', area, [...AREA_IDS]], ['severity', severity, SEVERITIES]]) {
    if (v == null || v === '') continue
    if (!list.includes(v)) return { error: `invalid_${col}` }
    args.push(v)
    where.push(`${col} = ?${args.length}`)
  }
  if (q) {
    args.push(`%${String(q).slice(0, 80).replace(/[%_]/g, '')}%`)
    where.push(`(title LIKE ?${args.length} OR description LIKE ?${args.length})`)
  }
  args.push(Math.min(Math.max(1, Number(limit) || 100), 300))
  const { results } = await db.prepare(`SELECT * FROM qa_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?${args.length}`).bind(...args).all()
  const { results: c } = await db.prepare('SELECT kind, status, count(*) AS n FROM qa_items GROUP BY kind, status').all()
  const counts = { defects: Object.fromEntries([...DEFECT_STATUSES, 'total'].map((s) => [s, 0])), backlog: Object.fromEntries([...BACKLOG_STATUSES, 'total'].map((s) => [s, 0])) }
  for (const x of c) {
    const g = counts[groupOf(x.kind)]
    g[x.status] = (g[x.status] || 0) + x.n
    g.total += x.n
  }
  return { items: results.map(presentItem), counts }
}

export async function itemEvents(db, id) {
  const { results } = await db.prepare('SELECT at, actor, type, from_status, to_status, detail FROM qa_item_events WHERE item_id = ?1 ORDER BY at, id').bind(id).all()
  return results.map((e) => ({ at: e.at, actor: e.actor, type: e.type, from: e.from_status, to: e.to_status, detail: parse(e.detail, {}) }))
}

// After results are stored: defects waiting for QA are verified (every linked test passed after the fix) or reopened
// (a linked test failed after the fix). Backlog entries are never touched. → [{ id, status, by }]
export async function onResults(db, stored, now = Date.now()) {
  const tested = new Set(stored.map((r) => r.test_id))
  if (!tested.size) return []
  const { results } = await db.prepare("SELECT * FROM qa_items WHERE kind IN ('bug', 'regression') AND status = 'fixed_pending_qa' LIMIT 500").all()
  const changed = []
  for (const item of results) {
    const ids = parse(item.test_ids, [])
    if (!ids.some((t) => tested.has(t))) continue
    const after = stored.filter((r) => ids.includes(r.test_id) && r.at > item.fixed_at)
    const failed = after.find((r) => r.status === 'fail')
    if (failed) {
      const res = await db.prepare("UPDATE qa_items SET status = 'open', updated_at = ?2 WHERE id = ?1 AND status = 'fixed_pending_qa'").bind(item.id, now).run()
      if ((res?.meta?.changes ?? 0) > 0) {
        await event(db, item.id, { actor: 'system:qa', type: 'reopened', from: 'fixed_pending_qa', to: 'open', detail: { result: failed.id, test: failed.test_id } }, now)
        changed.push({ id: item.id, status: 'open', by: failed.id })
      }
      continue
    }
    // Every linked test needs a pass after the fix (from this batch or an earlier one).
    const { results: passes } = await db.prepare(`SELECT test_id, max(at) AS at, id FROM qa_test_results WHERE status = 'pass' AND at > ?1 AND test_id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')}) GROUP BY test_id`).bind(item.fixed_at, ...ids).all()
    const { results: fails } = await db.prepare(`SELECT test_id, max(at) AS at FROM qa_test_results WHERE status IN ('fail', 'blocked', 'retest_required') AND at > ?1 AND test_id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')}) GROUP BY test_id`).bind(item.fixed_at, ...ids).all()
    const ok = ids.every((t) => {
      const p = passes.find((x) => x.test_id === t)
      const f = fails.find((x) => x.test_id === t)
      return p && (!f || f.at < p.at)
    })
    if (!ok) continue
    const by = after.filter((r) => r.status === 'pass').at(-1)?.id || passes[0]?.id
    const res = await db.prepare("UPDATE qa_items SET status = 'verified', verified_by = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'fixed_pending_qa'").bind(item.id, by, now).run()
    if ((res?.meta?.changes ?? 0) > 0) {
      await event(db, item.id, { actor: 'system:qa', type: 'verified', from: 'fixed_pending_qa', to: 'verified', detail: { result: by, tests: ids.length } }, now)
      changed.push({ id: item.id, status: 'verified', by })
    }
  }
  return changed
}
