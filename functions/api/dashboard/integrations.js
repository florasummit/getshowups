// /api/dashboard/integrations — every connected service: state, what it does, what disconnecting means.
//   GET → { items }    POST { action: 'disconnect', id: 'calendar' | 'meta' | 'gbp', confirm: true, pauseRunning? }  (owner)
// Google Ads, ChatGPT Ads, GoHighLevel, the AI key and the domain are disconnected on their own pages (same rules there).
import { json } from '../../../server/google-oauth.js'
import { isOwner, requireSession } from '../../../server/auth.js'
import { disconnectService, listServices } from '../../../server/integrations.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, { items: await listServices(env, session.customer) })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const rl = await hit(env, 'accountWrite', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const b = (await request.json().catch(() => null)) || {}
  if (b.action !== 'disconnect') return json(400, { error: 'invalid_request' })
  if (b.confirm !== true) return json(400, { error: 'confirmation_required' })
  try {
    if (!(await isOwner(env.ONBOARDING_DB, session))) return json(403, { error: 'owner_only' })
    const r = await disconnectService(env, session, b.id, { pauseRunning: b.pauseRunning === true })
    return r.ok ? json(200, r) : json(r.status || 409, r)
  } catch (err) {
    console.error('disconnect failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
