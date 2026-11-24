// The dashboard assistant (server/operator.js): the session's own business; looks up, reasons, prepares; saves nothing.
//   GET → { enabled }.
//   POST { question, topic?, view?, days?, history?, refs?, pending? }
//     → { kind, answer, raw?, records?, proposals?, withdraw?, go?, refs?, note?, evidence?, days } | { error, evidence?, records? }.
// error: rate_limited | unchecked | quota | setup | timeout | busy | unavailable; with `try` (questions answered without the
// model) and, for quota, resumesAt. Where things are and curated definitions need no model and doesn't use the daily allowance.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson, unhit } from '../../../server/ratelimit.js'
import { track } from '../../../server/events.js'
import { chatAccess, evidenceFor, helpFor, isSensitive, SENSITIVE_NOTE, validateQuestion, withoutModel } from '../../../server/assist.js'
import { placeAnswer, worksWithoutAi } from '../../../server/assist-plain.js'
import { operate } from '../../../server/operator.js'
import { MIN_CHARGE_MICROS, operatorModel, overBudget } from '../../../server/operator-model.js'

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
  const [error, req] = validateQuestion(await request.json().catch(() => null))
  if (error) return json(400, { error })
  const burst = await hit(env, 'assistMessage', customer.id)
  if (burst.limited) return tooManyJson(burst.retryAfter)
  const help = req.topic ? null : helpFor(req.question)
  if (help) return json(200, { kind: 'help', answer: help, days: req.days })
  // Only "where is…". "How do I change…" goes to the model, which can look it up and prepare the change.
  const place = /^\W*how\b/i.test(req.question) ? null : placeAnswer(req)
  if (place) return json(200, { kind: 'help', ...place, days: req.days })
  // What the owner gets when the model can't answer: the records themselves, never a guess.
  // It says so (aiOut): a list of records must never pass for the assistant's analysis.
  const fallback = async (status, error, r = {}) => {
    const out = { aiOut: error, ...(error === 'quota' ? { resumesAt: (Math.floor(Date.now() / 86_400_000) + 1) * 86_400_000 } : {}) }
    const [plain, evidence] = await Promise.all([withoutModel(env, customer, req).catch(() => null), evidenceFor(env, customer, req).catch(() => null)])
    if (plain) return json(200, { ...plain, days: req.days, limited: error === 'rate_limited', ...(plain.kind === 'records' ? out : {}), ...(evidence ? { evidence } : {}) })
    if (r.proposals?.length) return json(200, { kind: 'prepared', answer: 'Here’s what I prepared. Nothing is saved until you approve it.', proposals: r.proposals, records: r.records, refs: r.refs, days: req.days })
    if (r.looked && r.records?.length) return json(200, { kind: 'records', answer: 'Here’s what’s recorded:', records: r.records.slice(0, 8), refs: r.refs, days: req.days, ...out })
    return json(status, { error, days: req.days, try: worksWithoutAi(req.view), ...(out.resumesAt ? { resumesAt: out.resumesAt } : {}), ...(evidence ? { evidence } : {}) })
  }
  const model = operatorModel(env)
  // The included model shares one small platform allowance; a paid provider is bounded by money instead.
  if (await overBudget(env, customer.id)) return fallback(429, 'rate_limited')
  const limits = [['aiAskBurst', customer.id], ['aiAsk', customer.id], ...(model.provider === 'workers' ? [['aiAskAll', 'all']] : [])]
  for (const [rule, key] of limits) {
    const rl = await hit(env, rule, key)
    if (rl.limited) return fallback(429, 'rate_limited')
  }
  let r
  try {
    r = await operate(env, customer, req)
  } catch (err) {
    console.error('assist failed:', err?.name)
    return fallback(503, 'unavailable')
  }
  // Codes, tool names and numbers only; never the question, the answer or a record.
  await track(env, 'ai_ask', { customer: customer.id, props: { topic: req.topic, view: req.view, ok: r.ok, tools: r.tools.slice(0, 8), ...(r.ok ? {} : { reason: r.reason }), proposals: r.proposals.map((p) => p.type), model: model.model, costMicros: model.provider === 'claude' && !r.ok ? Math.max(r.costMicros, MIN_CHARGE_MICROS) : r.costMicros, ms: r.ms } })
  // A refusal before any model work isn't one of the owner's questions for the day.
  if (['quota', 'setup'].includes(r.reason) && !r.costMicros) for (const [rule, key] of limits) if (rule !== 'aiAskBurst') await unhit(env, rule, key)
  if (!r.ok) return fallback(r.reason === 'unchecked' ? 422 : 503, r.reason, r)
  return json(200, { kind: r.looked || r.records.length ? 'business' : 'general', answer: r.answer, raw: r.raw, lookups: r.lookups, records: r.records, proposals: r.proposals, withdraw: r.withdraw, go: r.go, refs: r.refs, days: req.days, ...(isSensitive(req.question) && !r.records.length ? { note: SENSITIVE_NOTE } : {}) })
}
