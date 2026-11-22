// /api/dashboard/domain — the business's own domain for its website.
//   GET  → { domain | null, target, provider }
//   POST { action: 'connect', hostname } | { action: 'check' } | { action: 'disconnect' }
// Ownership is proven by a DNS TXT record before anything is attached (server/domains.js).
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { track } from '../../../server/events.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { apexStatus, checkDomain, claimDomain, cnameTarget, currentPointer, disconnectDomain, domainFor, dnsViews, zoneProvider } from '../../../server/domains.js'

// While the owner is pointing the domain at us: where it points right now (e.g. Squarespace), read live from public DNS,
// so the screen can say which existing record to change. Never stored; null when DNS can't be read.
//   GET → { domain | null, target, provider }. For a www hostname at the pointing/connected stage the view also carries,
//   read live from public DNS and one HTTPS request (never stored): the DNS provider (from the zone's nameservers), what
//   each public resolver answers for www (so a half-propagated change is named, not called "waiting"), and the root
//   domain's state (forwards to www / points elsewhere / nothing), so the setup checklist is complete and honest.
const view = async (env, customerId) => {
  const domain = await domainFor(env, customerId)
  const current = domain?.step === 'point' && domain.status !== 'connected' ? await currentPointer(env, domain.hostname).catch(() => null) : null
  let extra = {}
  if (domain && domain.step === 'point') {
    const [provider, apex, www] = await Promise.all([zoneProvider(env, domain.hostname).catch(() => null), apexStatus(env, domain.hostname).catch(() => null), dnsViews(env, domain.hostname, 'CNAME').catch(() => null)])
    const t = cnameTarget(env)
    extra = {
      provider,
      apex,
      resolvers: www ? { cloudflare: www.cloudflare.ok ? www.cloudflare.values.includes(t) : null, google: www.google.ok ? www.google.values.includes(t) : null, cloudflareSees: www.cloudflare.ok ? www.cloudflare.values[0] || null : null, googleSees: www.google.ok ? www.google.values[0] || null : null } : null,
    }
  }
  return { domain: domain && { ...domain, current, ...extra }, target: cnameTarget(env) }
}

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
