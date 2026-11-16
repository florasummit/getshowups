// /api/dashboard/followups/thread — one conversation of the signed-in business.
//   GET ?id=<lead id>  → { thread, messages, upcoming }
//   POST { id, action: 'reply' (text, channel?) | 'takeover' | 'release' | 'done' | 'close' }   (same-origin)
// The lead must belong to the session's business (every query is scoped by customer); otherwise 404.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { followupsReady } from '../../../../server/followups/settings.js'
import { ownerAction, sendQueued, threadView } from '../../../../server/followups/engine.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await followupsReady(env.ONBOARDING_DB))) return json(409, { error: 'not_ready' })
  const r = await threadView(env, session.customer.id, new URL(request.url).searchParams.get('id'))
  return r.ok ? json(200, { thread: r.thread, messages: r.messages, upcoming: r.upcoming }) : json(r.httpStatus, { error: r.error })
}

export async function onRequestPost({ request, env, waitUntil }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!(await followupsReady(env.ONBOARDING_DB))) return json(409, { error: 'not_ready' })
  const rl = await hit(env, 'followupWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  if (!body || typeof body.id !== 'string' || typeof body.action !== 'string') return json(400, { error: 'invalid_request' })
  const r = await ownerAction(env, session.customer.id, body.id, body.action, { text: body.text, channel: body.channel === 'sms' || body.channel === 'email' ? body.channel : null })
  if (!r.ok) return json(r.httpStatus, { error: r.error })
  if (body.action === 'reply') {
    // Send now (the same checks as every message); the cron is the safety net.
    const work = sendQueued(env).catch(() => {})
    if (typeof waitUntil === 'function') waitUntil(work)
    else await work
  }
  const v = await threadView(env, session.customer.id, body.id)
  return json(200, { thread: v.thread, messages: v.messages, upcoming: v.upcoming, sent: r.id ? { id: r.id, channel: r.channel } : null })
}
