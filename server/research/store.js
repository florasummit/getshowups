// Research records (docs/RESEARCH_VAULT.md): one store for every kind, versioned and append-only (migration 0052).
// A change never edits history: it writes the next version with a reason. Links are append-only, so contradictions
// stay visible after beliefs change. Every write is audited (audit_log, capability research.vault, ids only).
import { randomToken } from '../google-oauth.js'
import { recordEvent } from '../auditlog.js'
import { NEEDS } from './programs.js'

export const LIMITS = { title: 160, text: 4000, list: 30, nodes: 200, traceNodes: 80, traceDepth: 5 }
const TXT = (v, max = LIMITS.text) => String(v ?? '').replace(/\p{Cc}/gu, (c) => (c === '\n' ? c : ' ')).trim().slice(0, max)
const LIST = (v) => (Array.isArray(v) ? v.map((x) => TXT(x, 600)).filter(Boolean).slice(0, LIMITS.list) : [])
const NUM = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN)

// What each kind must say. Required fields are checked on every version; a missing one is refused (never defaulted).
// `empirical` hypotheses must name what would falsify them; experiments must fix success criteria and limits BEFORE
// they start; recommendations carry all 18 fields of the decision queue.
export const KINDS = {
  program: { statuses: ['active', 'dormant', 'retired'], required: ['question'], text: ['question', 'dormantUntil'], lists: ['needs', 'models'] },
  question: { statuses: ['open', 'answered', 'dormant', 'retired'], required: [], text: ['detail', 'whyItMatters'], lists: ['kpis'] },
  thesis: { statuses: ['draft', 'active', 'supported', 'contradicted', 'retired'], required: ['claim'], text: ['claim', 'detail'], lists: ['assumptions'], needsList: ['assumptions'] },
  assumption: { statuses: ['active', 'questioned', 'invalid', 'retired'], required: ['statement'], text: ['statement', 'basis'], lists: [] },
  hypothesis: { statuses: ['draft', 'active', 'supported', 'contradicted', 'retired'], required: ['statement', 'falsifiedBy'], text: ['statement', 'falsifiedBy', 'mechanism'], lists: ['assumptions'], needsList: ['assumptions'] },
  model: { statuses: ['draft', 'illustrative', 'hypothesis', 'validated', 'retired'], required: ['expression'], text: ['expression', 'derivation', 'limitations'], lists: ['assumptions', 'variables'], needsList: ['assumptions'] },
  experiment: {
    statuses: ['proposed', 'approved', 'running', 'completed', 'abandoned'],
    required: ['primaryOutcome', 'design', 'successCriteria', 'stoppingRule', 'assignment', 'budgetLimit'],
    text: ['primaryOutcome', 'design', 'successCriteria', 'stoppingRule', 'assignment', 'budgetLimit', 'nullHypothesis', 'alternative', 'population', 'confounders', 'results', 'limitations'],
    lists: ['secondaryOutcomes'],
    nums: ['plannedSample', 'minimumDetectableEffect', 'controlN', 'controlSuccesses', 'treatmentN', 'treatmentSuccesses'],
  },
  observation: { statuses: ['proposed', 'confirmed', 'rejected'], required: ['what'], text: ['what', 'source', 'quality'], lists: [] },
  evidence: { statuses: ['recorded', 'questioned', 'retracted'], required: ['what', 'source', 'quality'], text: ['what', 'source', 'quality', 'dataKind'], lists: [], nums: ['n', 'successes'] },
  counterexample: { statuses: ['recorded', 'resolved'], required: ['what'], text: ['what', 'inputs'], lists: [] },
  recommendation: {
    statuses: ['proposed', 'approved', 'rejected', 'deferred', 'completed'],
    required: ['improve', 'whyItMatters', 'kpi', 'action', 'risks', 'evidence', 'uncertainty', 'validationStatus', 'invalidatedBy', 'approval', 'successCriteria', 'followUp'],
    text: ['improve', 'whyItMatters', 'kpi', 'action', 'time', 'risks', 'evidence', 'uncertainty', 'validationStatus', 'invalidatedBy', 'approval', 'successCriteria', 'followUp', 'derivation', 'actualOutcome'],
    lists: ['alternatives'],
    nums: ['benefitLow', 'benefitHigh', 'probability', 'cost'],
  },
  outcome: { statuses: ['recorded'], required: ['what'], text: ['what', 'predicted', 'actual'], lists: [], nums: ['predictedValue', 'actualValue'] },
  note: { statuses: ['active', 'retired'], required: [], text: ['text'], lists: [] },
}
export const RELATIONS = ['supports', 'contradicts', 'assumes', 'tests', 'derives', 'informs', 'answers', 'supersedes', 'measures']
export const DATA_KINDS = ['measured', 'estimated', 'simulated', 'test', 'missing', 'unverified']

// → [errors[], { title, status, body, confidence, program }]
export function validate(kind, input) {
  const k = KINDS[kind]
  if (!k) return [['invalid_kind']]
  const errors = []
  const title = TXT(input?.title, LIMITS.title)
  if (title.length < 3) errors.push('title')
  const status = input?.status ?? k.statuses[0]
  if (!k.statuses.includes(status)) errors.push('status')
  const body = {}
  for (const f of k.text || []) if (input?.body?.[f] !== undefined) body[f] = TXT(input.body[f])
  for (const f of k.lists || []) if (input?.body?.[f] !== undefined) body[f] = LIST(input.body[f])
  for (const f of k.nums || []) if (input?.body?.[f] !== undefined) {
    body[f] = NUM(input.body[f])
    if (Number.isNaN(body[f])) errors.push(f)
  }
  for (const f of k.required) if (!body[f]) errors.push(f)
  for (const f of k.needsList || []) if (!body[f]?.length) errors.push(f)
  if (kind === 'evidence' && body.dataKind && !DATA_KINDS.includes(body.dataKind)) errors.push('dataKind')
  if (kind === 'program' && (!input?.program || (body.needs || []).some((n) => !Object.hasOwn(NEEDS, n)))) errors.push(input?.program ? 'needs' : 'program')
  if (kind === 'recommendation' && body.probability != null && !(body.probability >= 0 && body.probability <= 1)) errors.push('probability')
  const confidence = input?.confidence === undefined || input?.confidence === null ? null : Number(input.confidence)
  if (confidence !== null && !(confidence >= 0 && confidence <= 1)) errors.push('confidence')
  const program = input?.program ? TXT(input.program, 20) : null
  if (program && !/^GS-[A-Z]{3}-\d{3}$/.test(program)) errors.push('program')
  return [errors, { title, status, body, confidence, program }]
}

const audit = (db, r, type, id) => recordEvent(db, { type, actor: r.ref, capability: 'research.vault', resource: { type: 'research_node', id }, outcome: 'success' }).catch(() => {})

export async function createNode(env, r, kind, input, now = Date.now()) {
  const [errors, v] = validate(kind, input)
  if (errors.length) return { ok: false, status: 400, error: 'invalid_record', fields: errors }
  const db = env.ONBOARDING_DB
  const count = Number((await db.prepare('SELECT count(*) AS n FROM research_nodes').first())?.n || 0)
  if (count >= 5000) return { ok: false, status: 409, error: 'vault_full' } // bounded storage; raise deliberately
  const id = `${kind.slice(0, 3)}_${randomToken(9)}`
  const body = JSON.stringify(v.body)
  await db.batch([
    db.prepare('INSERT INTO research_nodes (id, kind, program, title, status, body, confidence, version, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?9)').bind(id, kind, v.program, v.title, v.status, body, v.confidence, r.ref, now),
    db.prepare("INSERT INTO research_versions (node_id, version, title, status, body, confidence, reason, changed_by, changed_at) VALUES (?1, 1, ?2, ?3, ?4, ?5, 'created', ?6, ?7)").bind(id, v.title, v.status, body, v.confidence, r.ref, now),
  ])
  await audit(db, r, 'research.created', id)
  return { ok: true, id }
}

// A new version with a reason; `version` must be the current one (409 otherwise: never a silent overwrite).
export async function updateNode(env, r, id, input, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const cur = await db.prepare('SELECT * FROM research_nodes WHERE id = ?1').bind(String(id)).first()
  if (!cur) return { ok: false, status: 404, error: 'not_found' }
  const reason = TXT(input?.reason, 300)
  if (reason.length < 3) return { ok: false, status: 400, error: 'invalid_record', fields: ['reason'] }
  if (input?.version !== cur.version) return { ok: false, status: 409, error: 'stale' }
  const merged = { title: input.title ?? cur.title, status: input.status ?? cur.status, body: { ...JSON.parse(cur.body), ...(input.body || {}) }, confidence: input.confidence === undefined ? cur.confidence : input.confidence, program: input.program ?? cur.program }
  const [errors, v] = validate(cur.kind, merged)
  if (errors.length) return { ok: false, status: 400, error: 'invalid_record', fields: errors }
  const next = cur.version + 1
  const body = JSON.stringify(v.body)
  const r1 = await db.prepare('UPDATE research_nodes SET title = ?2, status = ?3, body = ?4, confidence = ?5, program = ?6, version = ?7, updated_at = ?8 WHERE id = ?1 AND version = ?9').bind(cur.id, v.title, v.status, body, v.confidence, v.program, next, now, cur.version).run()
  if (!r1.meta.changes) return { ok: false, status: 409, error: 'stale' }
  await db.prepare('INSERT INTO research_versions (node_id, version, title, status, body, confidence, reason, changed_by, changed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)').bind(cur.id, next, v.title, v.status, body, v.confidence, reason, r.ref, now).run()
  await audit(db, r, 'research.updated', cur.id)
  return { ok: true, id: cur.id, version: next }
}

export async function link(env, r, { from, to, relation, note }, now = Date.now()) {
  if (!RELATIONS.includes(relation)) return { ok: false, status: 400, error: 'invalid_relation' }
  const db = env.ONBOARDING_DB
  const ids = [String(from), String(to)]
  if (ids[0] === ids[1]) return { ok: false, status: 400, error: 'invalid_link' }
  const found = (await db.prepare('SELECT id FROM research_nodes WHERE id IN (?1, ?2)').bind(...ids).all()).results.length
  if (found !== 2) return { ok: false, status: 404, error: 'not_found' }
  const id = `edg_${randomToken(9)}`
  const res = await db.prepare('INSERT OR IGNORE INTO research_edges (id, from_id, to_id, relation, note, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(id, ids[0], ids[1], relation, TXT(note, 300), r.ref, now).run()
  if (!res.meta.changes) return { ok: true, already: true }
  await audit(db, r, 'research.linked', ids[0])
  return { ok: true, id }
}

// Import a batch of records (e.g. the founder's program list, kept in a local file outside the public repository).
// At most 50 per call; a program whose id already exists is skipped (re-import is harmless); every record is validated.
export async function importRecords(env, r, records, now = Date.now()) {
  if (!Array.isArray(records) || !records.length || records.length > 50) return { ok: false, status: 400, error: 'invalid_import' }
  const db = env.ONBOARDING_DB
  const out = { ok: true, created: [], skipped: [], refused: [] }
  for (const [i, x] of records.entries()) {
    const kind = String(x?.kind || '')
    if (kind === 'program' && x?.record?.program && (await db.prepare("SELECT 1 FROM research_nodes WHERE kind = 'program' AND program = ?1").bind(String(x.record.program)).first())) {
      out.skipped.push(i)
      continue
    }
    const res = await createNode(env, r, kind, x?.record || {}, now)
    if (res.ok) out.created.push(res.id)
    else out.refused.push({ index: i, fields: res.fields || [res.error] })
  }
  return out
}

const out = (n) => ({ id: n.id, kind: n.kind, program: n.program, title: n.title, status: n.status, body: JSON.parse(n.body), confidence: n.confidence, version: n.version, createdAt: n.created_at, updatedAt: n.updated_at })

export async function listNodes(db, { kind, program } = {}) {
  const where = []
  const args = []
  if (kind && KINDS[kind]) where.push(`kind = ?${args.push(kind)}`)
  if (program && /^GS-[A-Z]{3}-\d{3}$/.test(program)) where.push(`program = ?${args.push(program)}`)
  const { results } = await db.prepare(`SELECT * FROM research_nodes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ${LIMITS.nodes}`).bind(...args).all()
  return results.map(out)
}

export async function getNode(db, id) {
  const n = await db.prepare('SELECT * FROM research_nodes WHERE id = ?1').bind(String(id)).first()
  if (!n) return null
  const [versions, edges] = await Promise.all([
    db.prepare('SELECT version, title, status, confidence, reason, changed_by, changed_at FROM research_versions WHERE node_id = ?1 ORDER BY version DESC LIMIT 100').bind(n.id).all(),
    db.prepare('SELECT e.*, a.title AS from_title, a.kind AS from_kind, b.title AS to_title, b.kind AS to_kind FROM research_edges e JOIN research_nodes a ON a.id = e.from_id JOIN research_nodes b ON b.id = e.to_id WHERE e.from_id = ?1 OR e.to_id = ?1 ORDER BY e.created_at LIMIT 200').bind(n.id).all(),
  ])
  return {
    ...out(n),
    versions: versions.results.map((v) => ({ version: v.version, title: v.title, status: v.status, confidence: v.confidence, reason: v.reason, at: v.changed_at })),
    links: edges.results.map((e) => ({ id: e.id, relation: e.relation, note: e.note, from: { id: e.from_id, title: e.from_title, kind: e.from_kind }, to: { id: e.to_id, title: e.to_title, kind: e.to_kind } })),
  }
}

// Traceability: everything a record rests on (what it assumes, what supports or contradicts it, what derived it, what
// tested it), followed backwards through the links up to LIMITS.traceDepth, at most LIMITS.traceNodes records.
// Contradicting records are always included and flagged.
export async function trace(db, id) {
  const seen = new Map()
  let frontier = [String(id)]
  const edges = []
  for (let depth = 0; depth < LIMITS.traceDepth && frontier.length && seen.size < LIMITS.traceNodes; depth++) {
    const marks = frontier.map((_, i) => `?${i + 1}`).join(',')
    const { results } = await db.prepare(`SELECT * FROM research_edges WHERE to_id IN (${marks}) OR (from_id IN (${marks}) AND relation IN ('assumes', 'derives', 'informs'))`).bind(...frontier).all()
    const next = []
    for (const e of results) {
      edges.push({ from: e.from_id, to: e.to_id, relation: e.relation })
      for (const nid of [e.from_id, e.to_id]) if (!seen.has(nid) && !frontier.includes(nid) && nid !== String(id)) next.push(nid)
    }
    for (const f of frontier) seen.set(f, depth)
    frontier = [...new Set(next)].slice(0, LIMITS.traceNodes - seen.size)
  }
  for (const f of frontier) seen.set(f, LIMITS.traceDepth)
  const ids = [...seen.keys()]
  const nodes = ids.length ? (await db.prepare(`SELECT * FROM research_nodes WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(',')})`).bind(...ids).all()).results.map(out) : []
  const uniq = [...new Map(edges.map((e) => [`${e.from}|${e.to}|${e.relation}`, e])).values()]
  return { root: String(id), nodes, edges: uniq, contradictions: uniq.filter((e) => e.relation === 'contradicts').length }
}
