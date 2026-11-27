// /api/research/vault — the Research Vault API (server/research/, docs/RESEARCH_VAULT.md). Every request is authorized
// server-side (requireResearcher); every refusal is the same 404. Deterministic: no model calls, no outside requests.
//   GET ?view=overview | programs | models | model&id= | records[&kind=&program=] | record&id= | trace&id= | observatory
//            | decisions | gaps
//   POST { action, … }: create {kind, record} · update {id, version, reason, record} · link {from, to, relation, note}
//        · evaluate {model, params} · verify {model, params} · sample_size {baseline, effect, alpha?, power?}
//        · analyze {id} (an experiment's recorded counts) · belief {priorSuccesses, priorN, successes, n} · scan
//        · member {email, role | revoke: true} (founder or director)
import { json } from '../../../server/google-oauth.js'
import { hit } from '../../../server/ratelimit.js'
import { NOT_FOUND, requireResearcher } from '../../../server/research/access.js'
import { createNode, getNode, importRecords, KINDS, link, listNodes, trace, updateNode } from '../../../server/research/store.js'
import { NEEDS } from '../../../server/research/programs.js'
import { MODELS, analyzeExperiment, cleanParams, describe, modelList, sampleSize, updateBelief } from '../../../server/research/math.js'
import { gaps, observatory, programStatus, rankDecisions, scan } from '../../../server/research/intelligence.js'
import { recordEvent } from '../../../server/auditlog.js'

const counts = async (db) => {
  const rows = (await db.prepare('SELECT kind, status, program, count(*) AS n FROM research_nodes GROUP BY kind, status, program').all()).results
  const sum = (f) => rows.filter(f).reduce((s, r) => s + r.n, 0)
  const byProgram = {}
  for (const r of rows) if (r.program) byProgram[r.program] = (byProgram[r.program] || 0) + r.n
  const byKind = {}
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + r.n
  return { total: sum(() => true), byKind, byProgram, completedExperiments: sum((r) => r.kind === 'experiment' && r.status === 'completed'), recommendations: sum((r) => r.kind === 'recommendation'), contradicted: sum((r) => r.status === 'contradicted') }
}

export async function onRequestGet({ request, env }) {
  const { researcher, response } = await requireResearcher(request, env)
  if (response) return response
  const rl = await hit(env, 'researchRead', researcher.email)
  if (rl.limited) return json(429, { error: 'rate_limited' })
  const db = env.ONBOARDING_DB
  const url = new URL(request.url)
  const view = url.searchParams.get('view') || 'overview'
  const id = url.searchParams.get('id') || ''
  try {
    if (view === 'overview' || view === 'programs') {
      const [c, obs, programs] = await Promise.all([counts(db), observatory(env), listNodes(db, { kind: 'program' })])
      const recs = rankDecisions(await listNodes(db, { kind: 'recommendation' })).filter((r) => ['proposed', 'approved'].includes(r.status)).slice(0, 5)
      return json(200, { you: { role: researcher.role }, counts: c, programs: programStatus(obs, c, programs), needs: NEEDS, models: modelList(), topDecisions: recs, gaps: await gaps(db), crossAccount: obs.crossAccount })
    }
    if (view === 'models') return json(200, { models: modelList() })
    if (view === 'model') return MODELS[id] ? json(200, { model: describe(id), counterexamples: MODELS[id].counterexamples() }) : NOT_FOUND()
    if (view === 'records') return json(200, { records: await listNodes(db, { kind: url.searchParams.get('kind'), program: url.searchParams.get('program') }), kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { statuses: v.statuses, required: v.required, needsList: v.needsList || [], text: v.text, lists: v.lists, nums: v.nums || [] }])) })
    if (view === 'record') {
      const n = await getNode(db, id)
      return n ? json(200, { record: n }) : NOT_FOUND()
    }
    if (view === 'trace') return json(200, await trace(db, id))
    if (view === 'observatory') return json(200, await observatory(env))
    if (view === 'decisions') return json(200, { decisions: rankDecisions(await listNodes(db, { kind: 'recommendation' })) })
    if (view === 'gaps') return json(200, { gaps: await gaps(db) })
    return NOT_FOUND()
  } catch (err) {
    console.error('research vault read failed:', view, err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const b = (await request.json().catch(() => null)) || {}
  const manage = b.action === 'member'
  const { researcher, response } = await requireResearcher(request, env, { write: true, manage })
  if (response) return response
  const rl = await hit(env, 'researchWrite', researcher.email)
  if (rl.limited) return json(429, { error: 'rate_limited' })
  const db = env.ONBOARDING_DB
  const done = (r) => (r.ok === false ? json(r.status || 400, { error: r.error, ...(r.fields ? { fields: r.fields } : {}) }) : json(200, r))
  try {
    switch (b.action) {
      case 'create':
        return done(await createNode(env, researcher, String(b.kind || ''), b.record || {}))
      case 'update':
        return done(await updateNode(env, researcher, b.id, { ...(b.record || {}), version: b.version, reason: b.reason }))
      case 'link':
        return done(await link(env, researcher, b))
      case 'evaluate':
      case 'verify': {
        const m = MODELS[b.model]
        if (!m) return NOT_FOUND()
        const p = cleanParams(b.model, b.params)
        return json(200, b.action === 'evaluate' ? { params: p, ...m.evaluate(p) } : { params: p, checks: m.verify(p), formal: 'not verified (no proof assistant integrated)' })
      }
      case 'sample_size':
        return done(sampleSize(b))
      case 'belief':
        return done(updateBelief(b))
      case 'analyze': {
        const n = await getNode(db, b.id)
        if (!n || n.kind !== 'experiment') return NOT_FOUND()
        return json(200, { analysis: analyzeExperiment(n.body) })
      }
      case 'import':
        return done(await importRecords(env, researcher, b.records))
      case 'scan':
        return json(200, await scan(env, researcher))
      case 'member': {
        const email = String(b.email || '').trim().toLowerCase()
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return json(400, { error: 'invalid_email' })
        if (b.revoke === true) await db.prepare('UPDATE research_members SET revoked_at = ?2 WHERE email = ?1 AND revoked_at IS NULL').bind(email, Date.now()).run()
        else {
          if (!['director', 'researcher'].includes(b.role) || (b.role === 'director' && researcher.role !== 'founder')) return json(400, { error: 'invalid_role' })
          await db.prepare('INSERT INTO research_members (email, role, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(email) DO UPDATE SET role = ?2, granted_by = ?3, granted_at = ?4, revoked_at = NULL').bind(email, b.role, researcher.email, Date.now()).run()
        }
        await recordEvent(db, { type: b.revoke ? 'research.member_revoked' : 'research.member_granted', actor: researcher.ref, capability: 'research.vault', resource: { type: 'research_member', id: 'member' }, outcome: 'success', details: { role: b.role || null } })
        return json(200, { ok: true })
      }
      default:
        return json(400, { error: 'invalid_action' })
    }
  } catch (err) {
    console.error('research vault write failed:', b.action, err?.name)
    return json(503, { error: 'storage_error' })
  }
}
