// Twilio accounts: ONE GetShowUps parent account (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN, production secrets) and ONE
// Twilio SUBACCOUNT per business (migration 0025, sms_accounts). Why subaccounts: Twilio's preferred ISV architecture —
// each business's registration, numbers, Messaging Service, opt-outs and usage live in its own account, so one
// business's traffic or suspension never touches another's.
//
// Credentials (Twilio docs, iam/api/subaccounts): parent credentials may call v2010 resources (api.twilio.com
// /2010-04-01/Accounts/<sub>/…) of any subaccount — used for sending, numbers, addresses, usage. Subdomain APIs
// (trusthub.twilio.com, messaging.twilio.com) must be called with the SUBACCOUNT's own credentials — used for the
// registration (provisioning.js). The subaccount auth token is stored AES-GCM encrypted under an HKDF subkey of
// TOKEN_ENCRYPTION_KEY, bound to (business, account SID); it never leaves the server and is never logged.
//
// Creating a subaccount is free; it is still a provider write, so it runs only as a confirmed, audited admin action.
// TWILIO_API_MOCK_ORIGIN (loopback only) is a test stand-in for every Twilio host.
import { CUSTOMER_RE } from '../invites.js'

export const ACCOUNT_TABLES = ['sms_accounts', 'sms_provider_objects', 'sms_registration_extra']
const HOSTS = { api: 'https://api.twilio.com', trusthub: 'https://trusthub.twilio.com', messaging: 'https://messaging.twilio.com' }
const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d+$/
const mockOrigin = (env) => (typeof env.TWILIO_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.TWILIO_API_MOCK_ORIGIN) ? env.TWILIO_API_MOCK_ORIGIN : null)
export const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/
// v2010 paths keep their own prefix on the mock (/2010-04-01/…); other hosts get /<host>/… so tests can tell them apart.
export function twilioUrl(env, host, path) {
  const mock = mockOrigin(env)
  if (mock) return host === 'api' ? `${mock}${path}` : `${mock}/${host}${path}`
  return `${HOSTS[host]}${path}`
}
export const parentConfigured = (env) => Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN)
export const parentAuth = (env) => ({ sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN })

// One Twilio REST call. params: [[key, value], …] (repeatable keys, e.g. MessageSamples). Never logs bodies.
// → { ok, status, body } | { ok: false, error (allowlisted), unknown: true when the outcome can't be known }
export async function twilioRequest(env, { host = 'api', path, method = 'POST', params = [], auth }) {
  if (!auth?.sid || !auth?.token) return { ok: false, error: 'provider_not_configured' }
  const form = new URLSearchParams()
  for (const [k, v] of params) if (v !== undefined && v !== null && v !== '') form.append(k, String(v))
  const url = twilioUrl(env, host, path) + (method === 'GET' && params.length ? `?${form}` : '')
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Basic ${btoa(`${auth.sid}:${auth.token}`)}`, ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
      body: method === 'GET' ? undefined : form,
      signal: AbortSignal.timeout(10_000),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok) return { ok: true, status: res.status, body }
    const code = Number.isInteger(body?.code) ? body.code : null
    // 5xx after a write: Twilio may or may not have acted. Treated like a timeout (never blindly repeated).
    return { ok: false, status: res.status, error: code ? `twilio_${code}` : `http_${res.status}`, unknown: method !== 'GET' && res.status >= 500 }
  } catch {
    return { ok: false, error: 'network_error', unknown: method !== 'GET' }
  }
}

// ---------- readiness of the tables ----------
const ready = new WeakSet()
export async function accountsReady(db) {
  if (!db) return false
  if (ready.has(db)) return true
  try {
    const r = await db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${ACCOUNT_TABLES.map((_, i) => `?${i + 1}`).join(', ')})`)
      .bind(...ACCOUNT_TABLES)
      .first()
    const ok = Number(r?.n) === ACCOUNT_TABLES.length
    if (ok) ready.add(db)
    return ok
  } catch {
    return false
  }
}

// ---------- subaccount credentials at rest ----------
const enc = new TextEncoder()
const b64 = (u8) => btoa(String.fromCharCode(...u8))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
async function derivedKey(env) {
  const master = await crypto.subtle.importKey('raw', unb64(env.TOKEN_ENCRYPTION_KEY), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('getshowups/twilio-subaccount/v1'), info: enc.encode('aes-gcm') }, master, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const aad = (customer, sid) => enc.encode(`${customer}|${sid}`)
export async function sealToken(env, customer, sid, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(customer, sid) }, await derivedKey(env), enc.encode(token)))
  return `v1.${b64(iv)}.${b64(ct)}`
}
async function openToken(env, customer, sid, sealed) {
  const [v, iv, ct] = String(sealed).split('.')
  if (v !== 'v1') throw new Error('bad token')
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad(customer, sid) }, await derivedKey(env), unb64(ct)))
}

export async function accountOf(db, customer) {
  if (!CUSTOMER_RE.test(customer || '') || !(await accountsReady(db))) return null
  return db.prepare('SELECT customer, account_sid, status, usage_period, usage_count, usage_micros, usage_synced_at, created_at FROM sms_accounts WHERE customer = ?1').bind(customer).first()
}
export async function accountForSid(db, sid) {
  if (!ACCOUNT_SID_RE.test(sid || '') || !(await accountsReady(db))) return null
  return db.prepare('SELECT customer, account_sid, auth_token_enc, status FROM sms_accounts WHERE account_sid = ?1').bind(sid).first()
}
// The business's own subaccount credentials (for trusthub/messaging calls inside it). null if missing/unreadable.
export async function subaccountAuth(env, customer) {
  if (!(await accountsReady(env.ONBOARDING_DB))) return null
  const r = await env.ONBOARDING_DB.prepare("SELECT account_sid, auth_token_enc FROM sms_accounts WHERE customer = ?1 AND status = 'active'").bind(customer).first()
  if (!r) return null
  try {
    return { sid: r.account_sid, token: await openToken(env, customer, r.account_sid, r.auth_token_enc) }
  } catch {
    return null
  }
}
// Webhook signature keys for an AccountSid Twilio reported: the subaccount's token (numbers live there) and the parent's.
export async function signingKeys(env, accountSid) {
  if (accountSid && accountSid === env.TWILIO_ACCOUNT_SID) return { customer: null, tokens: [env.TWILIO_AUTH_TOKEN] }
  const r = await accountForSid(env.ONBOARDING_DB, accountSid)
  if (!r || r.status !== 'active') return null
  let sub = null
  try {
    sub = await openToken(env, r.customer, r.account_sid, r.auth_token_enc)
  } catch {
    sub = null
  }
  return { customer: r.customer, tokens: [sub, env.TWILIO_AUTH_TOKEN].filter(Boolean) }
}

const friendlyName = (customer) => `GetShowUps ${customer}`

// Create (or recover) the business's subaccount. Idempotent: an existing row is returned; a subaccount Twilio already
// has under our stable FriendlyName (e.g. after a lost response) is adopted instead of creating a second one.
export async function ensureSubaccount(env, customer, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!CUSTOMER_RE.test(customer || '')) return { ok: false, error: 'invalid_request' }
  if (!(await accountsReady(db))) return { ok: false, error: 'not_ready' }
  if (!parentConfigured(env)) return { ok: false, error: 'provider_not_configured' }
  const existing = await accountOf(db, customer)
  if (existing) return { ok: true, accountSid: existing.account_sid, created: false }
  const parent = parentAuth(env)
  const found = await twilioRequest(env, { method: 'GET', path: '/2010-04-01/Accounts.json', params: [['FriendlyName', friendlyName(customer)], ['Status', 'active']], auth: parent })
  if (!found.ok) return { ok: false, error: found.error }
  let acct = (found.body?.accounts || []).find((a) => a?.owner_account_sid === parent.sid && ACCOUNT_SID_RE.test(a?.sid || ''))
  let created = false
  if (!acct) {
    const r = await twilioRequest(env, { path: '/2010-04-01/Accounts.json', params: [['FriendlyName', friendlyName(customer)]], auth: parent })
    // Unknown outcome: the next run finds it by FriendlyName (never a second subaccount).
    if (!r.ok) return { ok: false, error: r.unknown ? 'unknown_outcome' : r.error }
    acct = r.body
    created = true
  }
  if (!ACCOUNT_SID_RE.test(acct?.sid || '') || typeof acct?.auth_token !== 'string' || acct.auth_token.length < 16) return { ok: false, error: 'provider_bad_response' }
  try {
    await db
      .prepare("INSERT INTO sms_accounts (customer, account_sid, auth_token_enc, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)")
      .bind(customer, acct.sid, await sealToken(env, customer, acct.sid, acct.auth_token), now)
      .run()
  } catch (err) {
    // The same subaccount can never belong to two businesses (UNIQUE account_sid).
    if (String(err?.message).includes('UNIQUE')) return { ok: false, error: 'account_in_use' }
    throw err
  }
  return { ok: true, accountSid: acct.sid, created }
}

// Provider-reported SMS usage this month for the business's subaccount (read-only; parent credentials).
export async function syncUsage(env, customer, now = Date.now()) {
  const a = await accountOf(env.ONBOARDING_DB, customer)
  if (!a) return { ok: false, error: 'no_account' }
  const r = await twilioRequest(env, { method: 'GET', path: `/2010-04-01/Accounts/${a.account_sid}/Usage/Records/ThisMonth.json`, params: [['Category', 'sms']], auth: parentAuth(env) })
  if (!r.ok) return { ok: false, error: r.error }
  const rec = (r.body?.usage_records || []).find((u) => u?.category === 'sms') || {}
  const count = Number.parseInt(rec.count, 10)
  const price = Number(rec.price)
  const period = new Date(now).toISOString().slice(0, 7)
  await env.ONBOARDING_DB.prepare('UPDATE sms_accounts SET usage_period = ?2, usage_count = ?3, usage_micros = ?4, usage_synced_at = ?5, updated_at = ?5 WHERE customer = ?1')
    .bind(customer, period, Number.isFinite(count) ? count : 0, Number.isFinite(price) ? Math.round(Math.abs(price) * 1e6) : 0, now)
    .run()
  return { ok: true, period, count: Number.isFinite(count) ? count : 0 }
}

// Account deletion: close the business's subaccount (Twilio releases its numbers). Idempotent; parent credentials.
export async function closeSubaccount(env, customer, now = Date.now()) {
  const a = await accountOf(env.ONBOARDING_DB, customer)
  if (!a || a.status === 'closed') return { ok: true, skipped: true }
  if (!parentConfigured(env)) return { ok: false, error: 'provider_not_configured' }
  const r = await twilioRequest(env, { path: `/2010-04-01/Accounts/${a.account_sid}.json`, params: [['Status', 'closed']], auth: parentAuth(env) })
  if (!r.ok && r.status !== 404) return { ok: false, error: r.error }
  await env.ONBOARDING_DB.prepare("UPDATE sms_accounts SET status = 'closed', updated_at = ?2 WHERE customer = ?1").bind(customer, now).run()
  return { ok: true }
}
