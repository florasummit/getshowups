// Bring-your-own AI API keys (Claude / OpenAI) for website generation. One key per business (migration 0022).
//   - Encrypted at rest with AES-GCM under a key DERIVED (HKDF) from TOKEN_ENCRYPTION_KEY for this purpose only, and bound
//     to (business, provider) as additional authenticated data: a ciphertext copied to another business or provider
//     fails to decrypt.
//   - The raw key never leaves the server: views show the provider and the last 4 characters only. Never logged.
//   - Validated with a read-only provider call before it is stored; invalid keys are never saved.
import Anthropic from '@anthropic-ai/sdk'

export const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', keyRe: /^sk-ant-[A-Za-z0-9_-]{20,200}$/ },
  openai: { label: 'OpenAI', keyRe: /^sk-[A-Za-z0-9_-]{20,200}$/ },
}
// Models a business can choose (first = default). Only models we've built for: structured JSON output, and for Claude the
// request shape in ai-providers.js / ai-designer.js. Anything else is refused.
export const MODELS = {
  anthropic: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 · best design quality' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · faster, lower cost' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 · fastest, lowest cost' },
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini · fastest, lowest cost' },
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
  ],
}
export const modelFor = (provider, model) => (MODELS[provider]?.some((m) => m.id === model) ? model : MODELS[provider]?.[0]?.id)
const MOCK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/
export const providerMock = (env) => (typeof env.AI_API_MOCK_ORIGIN === 'string' && MOCK_RE.test(env.AI_API_MOCK_ORIGIN) ? env.AI_API_MOCK_ORIGIN : null)

const enc = new TextEncoder()
const b64 = (u8) => btoa(String.fromCharCode(...u8))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function derivedKey(env) {
  const master = await crypto.subtle.importKey('raw', unb64(env.TOKEN_ENCRYPTION_KEY), 'HKDF', false, ['deriveKey'])
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
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad(customer, provider) }, await derivedKey(env), unb64(ct)))
}

// Read-only check that the key works. Returns { ok } or { ok: false, error } (allowlisted codes).
export async function validateKey(env, provider, apiKey) {
  const mock = providerMock(env)
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 15000, ...(mock ? { baseURL: `${mock}/anthropic` } : {}) })
    try {
      await client.models.list({ limit: 1 })
      return { ok: true }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { ok: false, error: 'invalid_key' }
      if (err instanceof Anthropic.RateLimitError) return { ok: false, error: 'provider_rate_limited' }
      return { ok: false, error: 'provider_unavailable' }
    }
  }
  try {
    const res = await fetch(`${mock ? `${mock}/openai` : 'https://api.openai.com'}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) })
    if (res.ok) return { ok: true }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'invalid_key' }
    if (res.status === 429) return { ok: false, error: 'provider_rate_limited' }
    return { ok: false, error: 'provider_unavailable' }
  } catch {
    return { ok: false, error: 'provider_unavailable' }
  }
}

export async function saveCredential(env, customer, provider, apiKey, now = Date.now(), model = null) {
  const key = String(apiKey ?? '').trim()
  if (!PROVIDERS[provider]) return { ok: false, httpStatus: 400, error: 'invalid_provider' }
  if (!PROVIDERS[provider].keyRe.test(key)) return { ok: false, httpStatus: 400, error: 'invalid_key_format' }
  if (model != null && modelFor(provider, model) !== model) return { ok: false, httpStatus: 400, error: 'invalid_model' }
  const v = await validateKey(env, provider, key)
  if (!v.ok) return { ok: false, httpStatus: v.error === 'invalid_key' ? 400 : 503, error: v.error }
  await env.ONBOARDING_DB.prepare(
    `INSERT INTO ai_credentials (customer, provider, sealed, hint, model, status, validated_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?6, 'ok', ?5, ?5, ?5)
     ON CONFLICT(customer) DO UPDATE SET provider = ?2, sealed = ?3, hint = ?4, model = ?6, status = 'ok', validated_at = ?5, updated_at = ?5`,
  )
    .bind(customer, provider, await sealKey(env, customer, provider, key), key.slice(-4), now, modelFor(provider, model))
    .run()
  return { ok: true }
}

// Changes the model for the connected provider (allowlist only).
export async function setModel(env, customer, model, now = Date.now()) {
  const r = await env.ONBOARDING_DB.prepare('SELECT provider FROM ai_credentials WHERE customer = ?1').bind(customer).first()
  if (!r) return { ok: false, httpStatus: 404, error: 'not_found' }
  if (modelFor(r.provider, model) !== model) return { ok: false, httpStatus: 400, error: 'invalid_model' }
  await env.ONBOARDING_DB.prepare('UPDATE ai_credentials SET model = ?2, updated_at = ?3 WHERE customer = ?1').bind(customer, model, now).run()
  return { ok: true }
}

export async function removeCredential(env, customer) {
  await env.ONBOARDING_DB.prepare('DELETE FROM ai_credentials WHERE customer = ?1').bind(customer).run()
  return { ok: true }
}

// What the owner sees (no secret material).
export async function credentialView(env, customer) {
  const r = await env.ONBOARDING_DB.prepare('SELECT provider, hint, model, status, validated_at FROM ai_credentials WHERE customer = ?1').bind(customer).first()
  return r ? { provider: r.provider, label: PROVIDERS[r.provider]?.label ?? r.provider, hint: r.hint, model: modelFor(r.provider, r.model), models: MODELS[r.provider], status: r.status, validatedAt: r.validated_at } : null
}

// For a generation: { provider, apiKey } or null. A key that fails later is marked so the owner sees it.
export async function credentialFor(env, customer) {
  const r = await env.ONBOARDING_DB.prepare("SELECT provider, sealed, model FROM ai_credentials WHERE customer = ?1 AND status = 'ok'").bind(customer).first()
  if (!r) return null
  try {
    return { provider: r.provider, model: modelFor(r.provider, r.model), apiKey: await openKey(env, customer, r.provider, r.sealed) }
  } catch {
    return null
  }
}
export const markCredential = (env, customer, status, now = Date.now()) => env.ONBOARDING_DB.prepare('UPDATE ai_credentials SET status = ?2, updated_at = ?3 WHERE customer = ?1').bind(customer, status, now).run()
