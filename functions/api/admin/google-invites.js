// POST /api/admin/google-invites — issue a single-use Google Calendar onboarding link.
//   Authorization: Bearer <ADMIN_API_TOKEN>
//   Body: { "customer": "acme-dental", "purpose": "connect" | "reconnect" }
// Only POST is exported, so Cloudflare Pages answers other methods with 405.
import { json, missingConfig, sha256Hex, timingSafeEqual } from '../../../server/google-oauth.js'
import { CUSTOMER_RE, createInvite } from '../../../server/invites.js'

export async function onRequestPost({ request, env }) {
  const missing = missingConfig(env)
  if (missing.length) {
    console.error('Google OAuth not configured; missing:', missing.join(', '))
    return json(503, { error: 'not_configured' })
  }

  const header = request.headers.get('Authorization') || ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  // Compare fixed-length digests so timing does not leak the token length or prefix.
  if (!presented || !timingSafeEqual(await sha256Hex(presented), await sha256Hex(env.ADMIN_API_TOKEN))) {
    return json(401, { error: 'unauthorized' })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'invalid_json' })
  }
  const customer = String(body?.customer || '').toLowerCase()
  const purpose = body?.purpose ?? 'connect'
  if (!CUSTOMER_RE.test(customer)) return json(400, { error: 'invalid_customer' })
  if (purpose !== 'connect' && purpose !== 'reconnect') return json(400, { error: 'invalid_purpose' })

  const { token, expiresAt } = await createInvite(env.ONBOARDING_DB, customer, purpose)
  const origin = new URL(env.GOOGLE_REDIRECT_URI).origin
  return json(201, {
    customer,
    purpose,
    url: `${origin}/api/google/oauth/start?invite=${token}`,
    expiresAt: new Date(expiresAt).toISOString(),
  })
}
