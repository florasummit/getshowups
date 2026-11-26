// The dashboard assistant (server/operator.js): the session's own business; looks up, reasons, prepares; saves nothing.
//   GET → { enabled }.
//   POST { question, topic?, view?, days?, history?, refs?, pending? }
//     → { kind, answer, raw?, records?, proposals?, withdraw?, go?, refs?, note?, evidence?, days } | { error, evidence?, records? }.
// POST { restore: true, refs } → { names } (the session business's own records only; a removed or foreign one is left out).
// error: rate_limited | unchecked | quota | setup | timeout | busy | unavailable; with `try` (questions answered without the
// model) and, for quota, resumesAt. Where things are and curated definitions need no model and doesn't use the daily allowance.
import { json, randomToken } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson, unhit } from '../../../server/ratelimit.js'
import { track } from '../../../server/events.js'
import { chatAccess, evidenceFor, helpFor, isSensitive, ownStepInstead, SENSITIVE_NOTE, validateQuestion, withoutModel } from '../../../server/assist.js'
import { offeredAnswer, placeAnswer, worksWithoutAi } from '../../../server/assist-plain.js'
import { namesFor } from '../../../server/operator-tools.js'
import { operate } from '../../../server/operator.js'
import { answersUsedUp, MIN_CHARGE_MICROS, operatorModel, overBudget } from '../../../server/operator-model.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, { enabled: await chatAccess(env, session.customer) })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const customer = session.customer
  if (!(await chatAccess(env, customer))) return json(404, { error: 'not_found' })
  const body = await request.json().catch(() => null)
  // A conversation kept in the owner's browser is opened again: the names behind its references, as they are now. No model.
  if (body?.restore === true) {
    if ((await hit(env, 'assistMessage', customer.id)).limited) return tooManyJson(600)
    return json(200, { names: await namesFor(env, customer, body.refs) })
  }
  const [error, req] = validateQuestion(body)
  if (error) return json(400, { error })
  const burst = await hit(env, 'assistMessage', customer.id)
  if (burst.limited) return tooManyJson(burst.retryAfter)
  // Without a conversation only: inside one, the same words refer to what was said or shown.
  const help = req.topic || req.history.length ? null : helpFor(req.question)
  if (help) return json(200, { kind: 'help', answer: help, days: req.days })
  // Only "where is…". "How do I change…" goes to the model, which can look it up and prepare the change.
  const place = /^\W*how\b/i.test(req.question) ? null : placeAnswer(req)
  if (place) return json(200, { kind: 'help', ...place, days: req.days })
  // A question the product itself suggests (the panel's chips) that asks for a fact: the records answer it, always, with
  // no model call and no AI allowance used. Unreadable records fall through to the usual path.
  const offered = await offeredAnswer(env, customer, req).catch(() => null)
  if (offered) return json(200, { ...offered, days: req.days })
  // What the owner gets when the model can't answer: the records themselves, never a guess.
  // It says so (aiOut): a list of records must never pass for the assistant's analysis.
  const fallback = async (status, error, r = {}, limit = null) => {
    const out = { aiOut: error, ...(limit ? { limit } : {}), ...(error === 'quota' ? { resumesAt: (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000 } : {}) }
    const [plain, evidence] = await Promise.all([withoutModel(env, customer, req).catch(() => null), evidenceFor(env, customer, req).catch(() => null)])
    if (plain) return json(200, { ...plain, days: req.days, limited: error === 'rate_limited', ...(plain.kind === 'records' ? out : {}), ...(evidence ? { evidence } : {}) })
    if (r.proposals?.length) return json(200, { kind: 'prepared', answer: 'Here’s what I prepared. Nothing is saved until you approve it.', proposals: r.proposals, records: r.records, refs: r.refs, days: req.days })
    if (r.looked && r.records?.length) return json(200, { kind: 'records', answer: 'Here’s what’s recorded:', records: r.records.slice(0, 8), refs: r.refs, days: req.days, ...out })
    return json(status, { error, ...(limit ? { limit } : {}), days: req.days, try: worksWithoutAi(req.view), ...(out.resumesAt ? { resumesAt: out.resumesAt } : {}), ...(evidence ? { evidence } : {}) })
  }
  const model = operatorModel(env)
  // The included model shares one small platform allowance; a paid provider is bounded by money instead.
  // Each limit says which one it is, so the owner is never told the wrong reason.
  if (await overBudget(env, customer.id)) return fallback(429, 'rate_limited', {}, 'spending')
  if (await answersUsedUp(env, customer.id)) return fallback(429, 'rate_limited', {}, 'answers')
  const limits = [['aiAskBurst', customer.id], ['aiAttempt', customer.id], ...(model.provider === 'workers' ? [['aiAskAll', 'all']] : [])]
  for (const [rule, key] of limits) {
    const rl = await hit(env, rule, key)
    if (rl.limited) return fallback(429, 'rate_limited', {}, { aiAskBurst: 'minute', aiAttempt: 'attempts', aiAskAll: 'shared' }[rule])
  }
  const answerId = `ai_ask:${randomToken(9)}`
  const record = (props) => track(env, 'ai_ask', { id: answerId, customer: customer.id, props: { topic: req.topic, view: req.view, ...props, model: model.model } })
  let r
  try {
    r = await operate(env, customer, req)
  } catch (err) {
    console.error('assist failed:', err?.name)
    // Recorded like any failure: the provider may have billed it, so the money limits must see it.
    await record({ ok: false, reason: 'unavailable', tools: [], proposals: [], costMicros: model.provider === 'claude' ? MIN_CHARGE_MICROS : 0 })
    return fallback(503, 'unavailable')
  }
  // Codes, tool names and numbers only; never the question, the answer or a record.
  await record({ ok: r.ok, tools: r.tools.slice(0, 8), lookups: r.tools.filter((t) => !/^(no_lookup_needed|show_page|prepare_|withdraw)/.test(t)).length, ...(r.ok ? {} : { reason: r.reason }), proposals: r.proposals.map((p) => p.type), costMicros: model.provider === 'claude' && !r.ok ? Math.max(r.costMicros, MIN_CHARGE_MICROS) : r.costMicros, usage: r.usage, ...(r.refusals?.length ? { refusals: r.refusals } : {}), ms: r.ms })
  // A refusal before any model work doesn't count as an attempt either.
  if (['quota', 'setup'].includes(r.reason) && !r.costMicros) for (const [rule, key] of limits) if (rule !== 'aiAskBurst') await unhit(env, rule, key)
  if (!r.ok) return fallback(r.reason === 'unchecked' ? 422 : 503, r.reason, r)
  // An answer that isn't about the hours, price, notice or outcome that was asked for: the place to do it, not the answer.
  const own = ownStepInstead(req.question, r)
  if (own) return json(200, { id: answerId, kind: 'help', answer: own.answer, go: own.go, refs: r.refs, days: req.days })
  return json(200, { id: answerId, kind: r.looked || r.records.length ? 'business' : 'general', answer: r.answer, raw: r.raw, lookups: r.lookups, records: r.records, proposals: r.proposals, withdraw: r.withdraw, go: r.go, refs: r.refs, days: req.days, ...(isSensitive(req.question) && !r.records.length ? { note: SENSITIVE_NOTE } : {}) })
}
