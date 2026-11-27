// The platform-admin assistant (server/admin-assist/). Platform admins only (PLATFORM_ADMIN_EMAILS); a business-owner
// session, a sales representative or onboarding staff get 403 like every /api/platform route.
//   GET  → { enabled, brief }   the weekly brief needs no model and works with the assistant switched off.
//   POST { question, history?, refs? } → { kind, answer, raw?, proposals?, refs?, sources?, evidence?, usage? }
//        | { kind: 'records', aiOut, brief } when the model can't answer (the records, never a guess)
//   POST { restore: true, refs } → { names } (no model).
// Off switch: ADMIN_ASSIST_ENABLED=false → POST 404. Spend: its own daily ceiling (admin_ai_ask events, UTC day).
import { json, randomToken } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { hit, tooManyJson, unhit } from '../../../server/ratelimit.js'
import { track } from '../../../server/events.js'
import { MIN_CHARGE_MICROS, operatorModel } from '../../../server/operator-model.js'
import { adminAssistEnabled, adminLimitReached, validateAdminQuestion } from '../../../server/admin-assist/index.js'
import { weeklyBrief } from '../../../server/admin-assist/brief.js'
import { confirmAsk, consequentialAsk, ownerDataAsk } from '../../../server/admin-assist/guard.js'
import { operateAdmin } from '../../../server/admin-assist/operator.js'
import { adminContext, namesFor } from '../../../server/admin-assist/tools.js'
import { loaders } from '../../../server/admin-assist/data.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    return json(200, { enabled: adminAssistEnabled(env), brief: await weeklyBrief(env) })
  } catch (err) {
    console.error('admin brief failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  if (!adminAssistEnabled(env)) return json(404, { error: 'not_found' })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid_request' })
  if (body.restore === true) {
    const [, req] = validateAdminQuestion({ question: 'restore', refs: body.refs })
    const c = adminContext(env, req.refs)
    return json(200, { names: await namesFor(c, Object.keys(req.refs)) })
  }
  const [error, req] = validateAdminQuestion(body)
  if (error) return json(400, { error })
  // Never the model: what it may not do, and owners' private records.
  const fixed = confirmAsk(req.question) || ownerDataAsk(req.question) || consequentialAsk(req.question)
  if (fixed) return json(200, fixed)
  const now = Date.now()
  const L = loaders(env, now)
  // The records, when the model can't answer: the brief itself (and anything already prepared), never a guess.
  const fallback = async (status, why, r = {}) => {
    const brief = await weeklyBrief(env, now, L).catch(() => null)
    if (r.proposals?.length) return json(200, { kind: 'prepared', answer: 'Here’s what I prepared. Nothing happens until you approve it.', proposals: r.proposals, refs: r.refs })
    return json(brief ? 200 : status, { kind: 'records', aiOut: why, ...(r.refusals?.length ? { held: r.refusals } : {}), answer: 'I couldn’t write an answer just now. Here’s what the records show this week:', brief, ...(why === 'quota' ? { resumesAt: (Math.floor(now / 86_400_000) + 1) * 86_400_000 } : {}) })
  }
  const limit = await adminLimitReached(env, now)
  if (limit) return fallback(429, limit)
  for (const rule of ['adminAssist', 'adminAssistDay']) {
    const rl = await hit(env, rule, admin.email)
    if (rl.limited) return rule === 'adminAssist' ? tooManyJson(rl.retryAfter) : fallback(429, 'answers')
  }
  const model = operatorModel(env)
  const id = `admin_ai_ask:${randomToken(9)}`
  const record = (props) => track(env, 'admin_ai_ask', { id, props: { ...props, model: model.model } })
  let r
  try {
    // One loader for the turn: the records in front of the model are the ones behind the fallback.
    const context = adminContext(env, req.refs, now)
    context.L = L
    r = await operateAdmin(env, req, { now, model, context })
  } catch (err) {
    console.error('admin assist failed:', err?.name)
    await record({ ok: false, reason: 'unavailable', tools: [], costMicros: model.provider === 'claude' ? MIN_CHARGE_MICROS : 0 })
    return fallback(503, 'unavailable')
  }
  // Codes, tool names and numbers only; never the question, the answer or a record.
  await record({ ok: r.ok, tools: r.tools.slice(0, 10), proposals: r.proposals.map((p) => p.type), costMicros: model.provider === 'claude' && !r.ok ? Math.max(r.costMicros, MIN_CHARGE_MICROS) : r.costMicros, usage: r.usage, ...(r.ok ? {} : { reason: r.reason }), ...(r.refusals.length ? { refusals: r.refusals } : {}), ms: r.ms })
  if (['quota', 'setup'].includes(r.reason) && !r.costMicros) await unhit(env, 'adminAssistDay', admin.email)
  if (!r.ok) return fallback(r.reason === 'unchecked' ? 422 : 503, r.reason, r)
  return json(200, { id, kind: r.proposals.length ? 'prepared' : 'answer', answer: r.answer, raw: r.raw, proposals: r.proposals, refs: r.refs, sources: r.sources.filter((s) => s.tool !== 'weekly_brief' || r.tools.includes('weekly_brief')), evidence: r.evidence, lookups: r.lookups, usage: { ...r.usage, costMicros: r.costMicros, ms: r.ms } })
}
