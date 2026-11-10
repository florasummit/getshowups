// /api/dashboard/domain — the business's own domain for its website.
//   GET  → { domain | null, target, provider }
//   POST { action: 'connect', hostname } | { action: 'check' } | { action: 'disconnect' }
// Ownership is proven by a DNS TXT record before anything is attached (server/domains.js).
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { track } from '../../../server/events.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { checkDomain, claimDomain, cnameTarget, disconnectDomain, domainFor } from '../../../server/domains.js'

const view = async (env, customerId) => ({ domain: await domainFor(env, customerId), target: cnameTarget(env) })

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, await view(env, session.customer.id))
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  const id = session.customer.id
  const rl = await hit(env, 'domain', id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  try {
    if (body?.action === 'connect') {
      const r = await claimDomain(env, id, body.hostname)
      if (!r.ok) return json(r.error === 'domain_in_use' || r.error === 'already_has_domain' ? 409 : 400, { error: r.error, suggestion: r.suggestion })
      await track(env, 'domain_claimed', { customer: id })
      // First check right away: the record may already be there.
      await checkDomain(env, r.domain.hostname)
      return json(200, await view(env, id))
    }
    if (body?.action === 'check') {
      const d = await domainFor(env, id)
      if (!d) return json(404, { error: 'not_found' })
      await checkDomain(env, d.hostname)
      return json(200, await view(env, id))
    }
    if (body?.action === 'disconnect') {
      const r = await disconnectDomain(env, id)
      if (!r.ok) return json(r.error === 'not_found' ? 404 : 503, { error: r.error })
      await track(env, 'domain_disconnected', { customer: id })
      return json(200, await view(env, id))
    }
    return json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('domain action failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
