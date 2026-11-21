// /api/dashboard/website/designer — the conversational AI website designer (server/ai-designer.js).
//   GET  → { turns, key: { provider, hint, status } | null, hasSite }
//   POST { action: 'message', message }        one turn, streamed as NDJSON. The message is read on the server FIRST
//                                               (server/designer-intents.js): a precise request ("remove my logo",
//                                               "change the headline to …", "remove the photo in the About section") is
//                                               ONE allowlisted operation on the current draft — no model, no key, no
//                                               allowance — answered as {"type":"done",reply,generationId,applied,notApplied};
//                                               an unclear one gets a clarifying reply (applied: [], nothing changed);
//                                               anything else is a design turn: {"type":"progress","chars":n}… then
//                                               {"type":"done",reply,generationId,removed} or {"type":"error","error"}.
//                                               Every result is the PRIVATE draft (never live).
//        { action: 'different' }               a fresh design in a genuinely different direction (always a design turn)
//        { action: 'undo', generationId }      put back the draft from before that turn
// Owner session, same-origin, the business's own AI key (design turns), rate limits and the daily AI allowance.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { aiUsage, recordAiUse } from '../../../../server/ai-usage.js'
import { credentialView } from '../../../../server/ai-credentials.js'
import { loadWebsite } from '../../../../server/website.js'
import { conversation, designTurn, undoTurn } from '../../../../server/ai-designer.js'
import { applyIntent, detectIntent } from '../../../../server/designer-intents.js'
import { studioAccess } from '../../../../server/website-studio.js'

const NDJSON = { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  // Website Studio (server/website-studio.js): only eligible businesses have this route.
  if (!(await studioAccess(env, session.customer))) return json(404, { error: 'not_found' })
  try {
    const [turns, key, website] = await Promise.all([conversation(env.ONBOARDING_DB, session.customer.id), credentialView(env, session.customer.id).catch(() => null), loadWebsite(env.ONBOARDING_DB, session.customer)])
    return json(200, { turns, key, hasSite: Boolean(website.draft.site), direction: website.draft.site?.direction || '' })
  } catch (err) {
    console.error('designer load failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  // Website Studio (server/website-studio.js): only eligible businesses have this route.
  if (!(await studioAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const body = await request.json().catch(() => null)
  const customer = session.customer
  if (body?.action === 'undo') {
    const r = await undoTurn(env, customer, body.generationId).catch(() => ({ ok: false, httpStatus: 503, error: 'storage_error' }))
    return r.ok ? json(200, { ok: true }) : json(r.httpStatus, { error: r.error })
  }
  // 'different': a fresh design that must move away from the current one (counts as a new design, not a change).
  if (body?.action !== 'message' && body?.action !== 'different') return json(400, { error: 'invalid_request' })
  const rl = await hit(env, 'websiteAi', customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const message = String(body.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200)
  const website = await loadWebsite(env.ONBOARDING_DB, customer)
  // Precise requests are decided here, before any model is involved, from the message and the CURRENT draft only.
  const intent = body.action === 'message' ? detectIntent(message, website.draft) : { kind: 'broad' }
  if (intent.kind !== 'broad') {
    try {
      const r = await applyIntent(env, customer, { ...intent, message }, { by: session.email })
      if (!r.ok) return json(r.httpStatus, { error: r.error })
      return new Response(`${JSON.stringify({ type: 'done', reply: r.reply, generationId: r.generationId, applied: r.applied, notApplied: r.notApplied, options: r.options || [] })}\n`, { status: 200, headers: NDJSON })
    } catch (err) {
      console.error('designer change failed:', err?.name)
      return json(503, { error: 'storage_error' })
    }
  }
  const different = body.action === 'different' && Boolean(website.draft.site)
  const kind = website.draft.site && !different ? 'revision' : 'generation'
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
      const r = await designTurn(env, customer, different ? 'Show me a different direction' : message, {
        by: session.email,
        mode: different ? 'different' : 'design',
        onProgress: (chars) => {
          if (chars - last >= 400 || chars === 0) {
            last = chars
            send({ type: 'progress', chars })
          }
        },
      })
      if (r.ok) {
        await recordAiUse(env.ONBOARDING_DB, customer.id, kind)
        await send({ type: 'done', reply: r.reply, generationId: r.generationId, removed: r.removed, revised: r.revised })
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
  return new Response(readable, { status: 200, headers: NDJSON })
}
