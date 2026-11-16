// /api/dashboard/website/designer — the conversational AI website designer (server/ai-designer.js).
//   GET  → { turns, key: { provider, hint, status } | null, hasSite }
//   POST { action: 'message', message }        one design turn, streamed as NDJSON:
//                                               {"type":"progress","chars":n}… then {"type":"done",reply,generationId,removed}
//                                               or {"type":"error","error"}. The result is the PRIVATE draft (never live).
//        { action: 'undo', generationId }      put back the design from before that turn
// Owner session, same-origin, the business's own AI key, rate limits and the daily AI allowance (runaway guard).
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { aiUsage, recordAiUse } from '../../../../server/ai-usage.js'
import { credentialView } from '../../../../server/ai-credentials.js'
import { loadWebsite } from '../../../../server/website.js'
import { conversation, designTurn, undoTurn } from '../../../../server/ai-designer.js'
import { studioEnabledFor } from '../../../../server/website-studio.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  // Internal pilot (server/website-studio.js): businesses outside it don't have this route.
  if (!studioEnabledFor(env, session.customer.id)) return json(404, { error: 'not_found' })
  try {
    const [turns, key, website] = await Promise.all([conversation(env.ONBOARDING_DB, session.customer.id), credentialView(env, session.customer.id).catch(() => null), loadWebsite(env.ONBOARDING_DB, session.customer)])
    return json(200, { turns, key, hasSite: Boolean(website.draft.site) })
  } catch (err) {
    console.error('designer load failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  // Internal pilot (server/website-studio.js): businesses outside it don't have this route.
  if (!studioEnabledFor(env, session.customer.id)) return json(404, { error: 'not_found' })
  const body = await request.json().catch(() => null)
  const customer = session.customer
  if (body?.action === 'undo') {
    const r = await undoTurn(env, customer, body.generationId).catch(() => ({ ok: false, httpStatus: 503, error: 'storage_error' }))
    return r.ok ? json(200, { ok: true }) : json(r.httpStatus, { error: r.error })
  }
  if (body?.action !== 'message') return json(400, { error: 'invalid_request' })
  const rl = await hit(env, 'websiteAi', customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const website = await loadWebsite(env.ONBOARDING_DB, customer)
  const kind = website.draft.site ? 'revision' : 'generation'
  const usage = await aiUsage(env, customer, session.email)
  if (usage[kind].remaining <= 0) return json(429, { error: 'daily_limit', kind, limit: usage[kind].limit, resetsAt: usage.resetsAt })

  const { readable, writable } = new TransformStream()
  const w = writable.getWriter()
  const enc = new TextEncoder()
  let open = true
  const send = (o) => (open ? w.write(enc.encode(`${JSON.stringify(o)}\n`)).catch(() => (open = false)) : null)
  let last = 0
  const heartbeat = setInterval(() => send({ type: 'progress', chars: last }), 10000)
  const work = (async () => {
    try {
      const r = await designTurn(env, customer, body.message, {
        by: session.email,
        onProgress: (chars) => {
          if (chars - last >= 400 || chars === 0) {
            last = chars
            send({ type: 'progress', chars })
          }
        },
      })
      if (r.ok) {
        await recordAiUse(env.ONBOARDING_DB, customer.id, kind)
        await send({ type: 'done', reply: r.reply, generationId: r.generationId, removed: r.warnings.length })
      } else await send({ type: 'error', error: r.error })
    } catch (err) {
      console.error('designer turn failed:', err?.name)
      await send({ type: 'error', error: 'storage_error' })
    } finally {
      clearInterval(heartbeat)
      open = false
      await w.close().catch(() => {})
    }
  })()
  void work
  return new Response(readable, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}
