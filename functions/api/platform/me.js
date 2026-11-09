// GET /api/platform/me — is the signed-in user a platform admin? Also reports integration status.
import { json } from '../../../server/google-oauth.js'
import { requirePlatformAdmin } from '../../../server/platform.js'
import { emailConfigured } from '../../../server/email.js'
import { stripeConfigured } from '../../../server/stripe.js'

export async function onRequestGet({ request, env }) {
  const { admin, response } = await requirePlatformAdmin(request, env)
  if (response) return response
  return json(200, { email: admin.email, emailConfigured: emailConfigured(env), billingConfigured: stripeConfigured(env) })
}
