// Platform admins: acceptance test grants (server/acceptance.js). GET lists; POST approve (a pairing code, for a test business
// typed twice, confirmed) | revoke (confirmed). Same-origin, rate-limited, audited. Never shows a code, secret or token.
import { json } from '../../../server/google-oauth.js'
import { audit, requirePlatformAdmin } from '../../../server/platform.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { acceptanceEnabled, approvePairing, listGrants, revokeGrant } from '../../../server/acceptance.js'

export async function onRequestGet({ request, env }) {
  const { response } = await requirePlatformAdmin(request, env)
  if (response) return response
  try {
    const { results } = await env.ONBOARDING_DB.prepare("SELECT t.customer AS id, c.name FROM test_businesses t JOIN customers c ON c.id = t.customer WHERE t.is_test = 1 AND c.status = 'active' ORDER BY c.name").all()
    return json(200, { enabled: acceptanceEnabled(env), grants: await listGrants(env), businesses: results })
  } catch {
    return json(200, { enabled: false, unavailable: true, grants: [], businesses: [] })
  }
}

export async function onRequestPost({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env, { write: true })
  if (response) return response
  if ((await hit(env, 'acceptanceAdmin', admin.email)).limited) return tooManyJson(600)
  const b = await request.json().catch(() => null)
  try {
    if (b?.action === 'approve') {
      const r = await approvePairing(env, admin.email, b)
      await audit(env, admin.email, r.ok ? 'acceptance.approve' : 'acceptance.approve_refused', r.ok ? r.grant.customer : null, r.ok ? { grant: r.grant.id } : { error: r.error })
      return r.ok ? json(200, { grant: r.grant }) : json(r.status, { error: r.error })
    }
    if (b?.action === 'revoke' && typeof b.id === 'string' && b.confirm === true) {
      const r = await revokeGrant(env, b.id)
      if (r.ok) await audit(env, admin.email, 'acceptance.revoke', r.customer, { grant: b.id })
      return r.ok ? json(200, { ok: true }) : json(r.status, { error: r.error })
    }
    return json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('acceptance admin failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
