// Platform (GetShowUps staff) authorization, separate from customer access: a signed-in Google
// identity is a platform admin only if its verified email is listed in PLATFORM_ADMIN_EMAILS.
// Business membership (customer_users) never grants platform access, and vice versa.
import { json, missingConfig } from './google-oauth.js'
import { getSession, isSameOrigin } from './auth.js'

export const adminEmails = (env) =>
  String(env.PLATFORM_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)

export async function requirePlatformAdmin(request, env, { write = false } = {}) {
  if (missingConfig(env).length) return { response: json(503, { error: 'not_configured' }) }
  if (write && !isSameOrigin(request, env)) return { response: json(403, { error: 'forbidden' }) }
  let session
  try {
    session = await getSession(request, env)
  } catch (err) {
    console.error('Session lookup failed:', err?.message)
    return { response: json(503, { error: 'storage_error' }) }
  }
  if (!session) return { response: json(401, { error: 'unauthenticated' }) }
  if (!adminEmails(env).includes(session.email)) return { response: json(403, { error: 'not_platform_admin' }) }
  return { admin: { email: session.email } }
}

// Records a privileged action. details must never contain secrets or tokens.
export async function audit(env, actor, action, customer = null, details = {}) {
  await env.ONBOARDING_DB.prepare('INSERT INTO admin_audit (at, actor, action, customer, details) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(Date.now(), actor, action, customer, JSON.stringify(details))
    .run()
}
