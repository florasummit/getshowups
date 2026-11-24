// Bring-your-own AI API keys (Claude / OpenAI) for website generation. One key per business (migration 0022).
//   - Encrypted at rest with AES-GCM under a key DERIVED (HKDF) from TOKEN_ENCRYPTION_KEY for this purpose only, and bound
//     to (business, provider) as additional authenticated data: a ciphertext copied to another business or provider
//     fails to decrypt.
//   - The raw key never leaves the server: views show the provider and the last 4 characters only. Never logged.
//   - Validated with a read-only provider call before it is stored; invalid keys are never saved.

import { withEitherKey } from './google-oauth.js'
export const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', keyRe: /^sk-ant-[A-Za-z0-9_-]{20,200}$/ },
  openai: { label: 'OpenAI', keyRe: /^sk-[A-Za-z0-9_-]{20,200}$/ },
}
const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/
export const providerMock = (env) => (typeof env.AI_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.AI_API_MOCK_ORIGIN) ? env.AI_API_MOCK_ORIGIN : null)

const enc = new TextEncoder()
const b64 = (u8) => btoa(String.fromCharCode(...u8))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function derivedKey(env, key = env.TOKEN_ENCRYPTION_KEY) {
  const master = await crypto.subtle.importKey('raw', unb64(key), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('getshowups/ai-credentials/v1'), info: enc.encode('aes-gcm') }, master, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const aad = (customer, provider) => enc.encode(`${customer}|${provider}`)

export async function sealKey(env, customer, provider, apiKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(customer, provider) }, await derivedKey(env), enc.encode(apiKey)))
  return `v1.${b64(iv)}.${b64(ct)}`
}
export async function openKey(env, customer, provider, sealed) {
  const [v, iv, ct] = String(sealed).split('.')
  if (v !== 'v1') throw new Error('bad credential')
  return withEitherKey(env, async (key) => new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad(customer, provider) }, await derivedKey(env, key), unb64(ct))))
}

export async function saveCredential(env, customer, provider, apiKey, now = Date.now(), model = null) {
  const key = String(apiKey ?? '').trim()
  if (!PROVIDERS[provider]) return { ok: false, httpStatus: 400, error: 'invalid_provider' }
  if (!PROVIDERS[provider].keyRe.test(key)) return { ok: false, httpStatus: 400, error: 'invalid_key_format' }
  // The model list doubles as the key check (read-only, free) and gives this account's catalog.
  const { discoverModels, registry, choices } = await import('./ai-models.js')
  const d = await discoverModels(env, provider, key)
  if (!d.ok) return { ok: false, httpStatus: d.error === 'invalid_key' ? 400 : 503, error: d.error }
  const selectable = choices(d.models, await registry(env.ONBOARDING_DB, provider)).filter((c) => c.selectable)
  if (model != null && model !== 'auto' && !selectable.some((c) => c.id === model)) return { ok: false, httpStatus: 400, error: 'invalid_model' }
  await env.ONBOARDING_DB.prepare(
    `INSERT INTO ai_credentials (customer, provider, sealed, hint, model, auto_model, catalog, catalog_at, monthly_budget_cents, status, validated_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?6, NULL, ?7, ?5, ?8, 'ok', ?5, ?5, ?5)
     ON CONFLICT(customer) DO UPDATE SET provider = ?2, sealed = ?3, hint = ?4, model = ?6, auto_model = NULL, catalog = ?7, catalog_at = ?5, status = 'ok', validated_at = ?5, updated_at = ?5`,
  )
    .bind(customer, provider, await sealKey(env, customer, provider, key), key.slice(-4), now, model || 'auto', JSON.stringify(d.models), (await import('./ai-models.js')).DEFAULT_BUDGET_CENTS)
    .run()
  return { ok: true }
}

// 'auto' or a model this account offers that is compatible and priced. A manual choice is never changed by us.
export async function setModel(env, customer, model, now = Date.now()) {
  const r = await env.ONBOARDING_DB.prepare('SELECT provider, catalog FROM ai_credentials WHERE customer = ?1').bind(customer).first()
  if (!r) return { ok: false, httpStatus: 404, error: 'not_found' }
  const { registry, choices } = await import('./ai-models.js')
  if (model !== 'auto' && !choices(JSON.parse(r.catalog || '[]'), await registry(env.ONBOARDING_DB, r.provider)).some((c) => c.selectable && c.id === model)) return { ok: false, httpStatus: 400, error: 'invalid_model' }
  await env.ONBOARDING_DB.prepare('UPDATE ai_credentials SET model = ?2, updated_at = ?3 WHERE customer = ?1').bind(customer, model, now).run()
  return { ok: true }
}

// The owner's monthly limit for AI website work on this key ($1–$1,000). Requests whose worst case would cross it are refused.
export async function setBudget(env, customer, cents, now = Date.now()) {
  const c = Number(cents)
  if (!Number.isInteger(c) || c < 100 || c > 100_000) return { ok: false, httpStatus: 400, error: 'invalid_budget' }
  const r = await env.ONBOARDING_DB.prepare('UPDATE ai_credentials SET monthly_budget_cents = ?2, updated_at = ?3 WHERE customer = ?1 RETURNING customer').bind(customer, c, now).first()
  return r ? { ok: true } : { ok: false, httpStatus: 404, error: 'not_found' }
}

export async function removeCredential(env, customer) {
  await env.ONBOARDING_DB.prepare('DELETE FROM ai_credentials WHERE customer = ?1').bind(customer).run()
  return { ok: true }
}

// What the owner sees (no secret material): provider, last 4, model choice, Auto's pick, budget, spend, catalog choices.
export async function credentialView(env, customer, now = Date.now()) {
  const r = await env.ONBOARDING_DB.prepare('SELECT provider, hint, model, auto_model, catalog, catalog_at, monthly_budget_cents, status, validated_at FROM ai_credentials WHERE customer = ?1').bind(customer).first()
  if (!r) return null
  const { registry, choices, monthSpend, DEFAULT_BUDGET_CENTS } = await import('./ai-models.js')
  const list = choices(JSON.parse(r.catalog || '[]'), await registry(env.ONBOARDING_DB, r.provider))
  const model = r.model || 'auto'
  return {
    provider: r.provider,
    label: PROVIDERS[r.provider]?.label ?? r.provider,
    hint: r.hint,
    status: r.status,
    validatedAt: r.validated_at,
    model,
    autoModel: r.auto_model,
    // A chosen model the account no longer offers is reported, never silently replaced.
    modelUnavailable: model !== 'auto' && !list.some((c) => c.selectable && c.id === model),
    choices: list,
    catalogAt: r.catalog_at,
    budgetCents: r.monthly_budget_cents ?? DEFAULT_BUDGET_CENTS,
    spentUsd: Math.round((await monthSpend(env.ONBOARDING_DB, customer, r.provider, now)) * 100) / 100,
  }
}

// For a generation: { provider, apiKey } or null. A key that fails later is marked so the owner sees it.
export async function credentialFor(env, customer) {
  const r = await env.ONBOARDING_DB.prepare("SELECT provider, sealed FROM ai_credentials WHERE customer = ?1 AND status = 'ok'").bind(customer).first()
  if (!r) return null
  try {
    return { provider: r.provider, apiKey: await openKey(env, customer, r.provider, r.sealed) }
  } catch {
    return null
  }
}
// Whatever key the business has stored, usable or not: { provider, apiKey } | { provider, unusable: true } | null.
// A stored key is the owner's choice to pay for AI with their own account, so a key that was marked invalid or can't be
// opened is reported to them, never replaced by the included (GetShowUps-paid) model. null only when no key is stored
// (or the table doesn't exist yet: migration 0022 not applied, so nothing can have been stored).
export async function storedCredential(env, customer) {
  let r
  try {
    r = await env.ONBOARDING_DB.prepare('SELECT provider, sealed, status FROM ai_credentials WHERE customer = ?1').bind(customer).first()
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return null
    throw err
  }
  if (!r) return null
  if (r.status !== 'ok') return { provider: r.provider, unusable: true }
  try {
    return { provider: r.provider, apiKey: await openKey(env, customer, r.provider, r.sealed) }
  } catch {
    return { provider: r.provider, unusable: true }
  }
}
export const markCredential = (env, customer, status, now = Date.now()) => env.ONBOARDING_DB.prepare('UPDATE ai_credentials SET status = ?2, updated_at = ?3 WHERE customer = ?1').bind(customer, status, now).run()
