// Signed links in messages to leads: "pick a time" (resume booking for an existing lead) and
// "confirm I'll be there". Token = HMAC-SHA256 over purpose + id with a key derived from
// TOKEN_ENCRYPTION_KEY, so nothing extra is stored and a token only works for its own record.
import { b64url, timingSafeEqual } from './google-oauth.js'
import { siteOrigin } from './auth.js'

const enc = new TextEncoder()
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

async function hmacKey(key) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`gsu-links:v1:${key}`))
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

export async function linkToken(env, purpose, id, key = env.TOKEN_ENCRYPTION_KEY) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(key), enc.encode(`${purpose}:${id}`))
  return b64url(new Uint8Array(sig))
}

export async function verifyLinkToken(env, purpose, id, token) {
  if (typeof id !== 'string' || !id || typeof token !== 'string' || !TOKEN_RE.test(token)) return false
  if (timingSafeEqual(token, await linkToken(env, purpose, id))) return true
  // During a key rotation, links already sent keep working (docs/KEY_ROTATION.md).
  return Boolean(env.TOKEN_ENCRYPTION_KEY_PREVIOUS) && timingSafeEqual(token, await linkToken(env, purpose, id, env.TOKEN_ENCRYPTION_KEY_PREVIOUS))
}

export const resumeUrl = async (env, customer, leadId) =>
  `${siteOrigin(env)}/book/${customer}?lead=${encodeURIComponent(leadId)}&k=${await linkToken(env, 'lead', leadId)}`

export const confirmUrl = async (env, appointmentId) =>
  `${siteOrigin(env)}/api/appointment/confirm?a=${encodeURIComponent(appointmentId)}&k=${await linkToken(env, 'confirm', appointmentId)}`
