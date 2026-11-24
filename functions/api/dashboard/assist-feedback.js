// POST { id, reason }: the owner says an assistant answer wasn't right. Codes only (no question, answer or record text), for
// the session's own answer; the newest reason for an answer counts. What each reason leads to: docs/INTELLIGENCE.md §6.
// It never changes the business's facts, rules or instructions, here or for anyone else.
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { track } from '../../../server/events.js'

export const REASONS = ['wrong_fact', 'misunderstood', 'wrong_action', 'missing', 'not_useful']
export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'assistMessage', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = await request.json().catch(() => null)
  if (typeof b?.id !== 'string' || !/^ai_ask:[A-Za-z0-9_-]{6,40}$/.test(b.id) || !REASONS.includes(b?.reason)) return json(400, { error: 'invalid_request' })
  try {
    const a = await env.ONBOARDING_DB.prepare("SELECT at, props FROM events WHERE id = ?1 AND customer = ?2 AND type = 'ai_ask'").bind(b.id, session.customer.id).first()
    if (!a) return json(404, { error: 'not_found' })
    const p = JSON.parse(a.props)
    await track(env, 'ai_feedback', { id: `ai_feedback:${b.id}`, customer: session.customer.id, props: { answer: b.id, reason: b.reason, view: p.view, tools: p.tools, model: p.model }, replace: true })
    return json(200, { ok: true })
  } catch {
    return json(503, { error: 'storage_error' })
  }
}
