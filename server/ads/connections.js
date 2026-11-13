// Ad platform connections. OAuth tokens are AES-GCM encrypted (TOKEN_ENCRYPTION_KEY) in KV under
// ads:<platform>:<customer>; D1 ad_connections holds only non-secret account selection and status.
import { decrypt, encrypt } from '../google-oauth.js'

const key = (platform, customer) => `ads:${platform}:${customer}`

export async function saveToken(env, platform, customer, token) {
  await env.GOOGLE_TOKENS.put(key(platform, customer), await encrypt(env, JSON.stringify({ ...token, savedAt: Date.now() })))
}

// Owner disconnect: forget our stored access. Never revokes at Google: the same Google grant may also power the
// business's Calendar connection (one grant per Google account + OAuth client); the owner can remove access in
// their Google Account.
export async function forgetConnection(env, platform, customer) {
  await env.GOOGLE_TOKENS.delete(key(platform, customer))
  await env.ONBOARDING_DB.prepare('DELETE FROM ad_connections WHERE customer = ?1 AND platform = ?2').bind(customer, platform).run()
}

export async function loadToken(env, platform, customer) {
  const raw = await env.GOOGLE_TOKENS.get(key(platform, customer))
  if (!raw) return null
  try {
    return JSON.parse(await decrypt(env, raw))
  } catch {
    return null
  }
}

export async function upsertConnection(env, customer, platform, { accountId = null, accountName = null, currency = null, extra = {}, status }, now = Date.now()) {
  await env.ONBOARDING_DB.prepare(
    `INSERT INTO ad_connections (customer, platform, account_id, account_name, currency, extra, status, connected_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT(customer, platform) DO UPDATE SET account_id = ?3, account_name = ?4, currency = ?5, extra = ?6, status = ?7, updated_at = ?8`,
  )
    .bind(customer, platform, accountId, accountName, currency, JSON.stringify(extra), status, now)
    .run()
}

export async function getConnection(env, customer, platform) {
  const row = await env.ONBOARDING_DB.prepare('SELECT * FROM ad_connections WHERE customer = ?1 AND platform = ?2').bind(customer, platform).first()
  return row ? { ...row, extra: JSON.parse(row.extra || '{}') } : null
}

export async function markReconnect(env, customer, platform) {
  await env.ONBOARDING_DB.prepare("UPDATE ad_connections SET status = 'reconnect_required', updated_at = ?3 WHERE customer = ?1 AND platform = ?2")
    .bind(customer, platform, Date.now())
    .run()
}

// Adapter results share one shape: { ok: true, ... } or { ok: false, error, httpStatus, retryable, reconnect }.
// error is an allowlisted code, never a provider message (messages can echo account data).
export const failure = (error, { httpStatus = 0, retryable = false, reconnect = false } = {}) => ({ ok: false, error, httpStatus, retryable, reconnect })
