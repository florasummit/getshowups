// Website AI with the business's OWN API key (server/ai-credentials.js): Claude (Anthropic SDK) or OpenAI (REST).
// Same contract as the included Workers AI path in server/website-ai.js: the model returns JSON matching our schema
// (named design options + prose), and the caller validates/repairs everything (claims filter, invented-number check,
// design repair) exactly as before. The model never writes HTML, CSS or scripts.
// Returns { ok: true, raw, usage: { input, output }, model } or { ok: false, error } with an allowlisted error code.
import Anthropic from '@anthropic-ai/sdk'
import { providerMock } from './ai-credentials.js'
import { MAX_OUTPUT } from './ai-models.js'

export const CLAUDE_MODEL = 'claude-opus-5-5'
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini'
const TIMEOUT = 120000

// Both providers' structured-output modes want closed objects with every property listed as required.
export function strictSchema(s) {
  if (Array.isArray(s)) return s.map(strictSchema)
  if (!s || typeof s !== 'object') return s
  const out = {}
  for (const [k, v] of Object.entries(s)) if (!['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'pattern'].includes(k)) out[k] = strictSchema(v)
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false
    out.required = Object.keys(out.properties)
  }
  return out
}

// Provider errors → our allowlisted codes. Billing problems are not temporary (retrying won't help; the owner must add
// credit), so they are 'provider_billing', never a rate limit:
//   Anthropic: HTTP 402 / type billing_error.
//   OpenAI: HTTP 429 with error.type insufficient_quota or a billing code such as credit_balance_exhausted (OpenAI:
//   "inspect error.code … the broader error.type can still be insufficient_quota").
// `detail` keeps the provider's own error type/code (short identifiers only, never the message text) for diagnosis.
const ident = (v) => (typeof v === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(v) ? v : null)
const OPENAI_BILLING_CODE = /(quota|credit|billing|spend|payment)/i
export function openAiError(status, body) {
  const detail = { status, type: ident(body?.error?.type), code: ident(body?.error?.code) }
  const billing = body?.error?.type === 'insufficient_quota' || OPENAI_BILLING_CODE.test(body?.error?.code || '')
  if (status === 401 || status === 403) return { error: 'invalid_key', detail }
  if (billing || status === 402) return { error: 'provider_billing', detail }
  if (status === 429) return { error: 'provider_rate_limited', detail }
  if (status === 400 || status === 404 || status === 422) return { error: 'provider_rejected', detail }
  return { error: 'provider_unavailable', detail }
}
export function claudeError(err) {
  const status = typeof err?.status === 'number' ? err.status : null
  const detail = { status, type: ident(err?.error?.error?.type ?? err?.type) }
  if (status === 401 || status === 403) return { error: 'invalid_key', detail }
  if (status === 402 || detail.type === 'billing_error') return { error: 'provider_billing', detail }
  if (status === 429) return { error: 'provider_rate_limited', detail }
  if (status === 400 || status === 404 || status === 413 || status === 422) return { error: 'provider_rejected', detail }
  return { error: 'provider_unavailable', detail }
}

async function runClaude(env, apiKey, msgs, schema, model = CLAUDE_MODEL, maxOutput = MAX_OUTPUT.writer) {
  const mock = providerMock(env)
  // maxRetries 0: a retry would be a second billed request the budget check did not account for.
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: TIMEOUT, ...(mock ? { baseURL: `${mock}/anthropic` } : {}) })
  let response
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: maxOutput,
      // No server-side fallback (owner decision 2026-11-16): a refused request is reported, never re-run on another model.
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: strictSchema(schema) } },
      system: msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'),
      messages: msgs.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
    })
  } catch (err) {
    return { ok: false, ...claudeError(err) }
  }
  const usage = { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 }
  if (response.stop_reason === 'refusal') return { ok: false, error: 'ai_declined', usage }
  if (response.stop_reason === 'max_tokens') return { ok: false, error: 'ai_invalid_output', usage }
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  try {
    // Recorded and priced as the model we asked for (and reserved the budget for), whatever the response calls itself.
    return { ok: true, raw: JSON.parse(text), usage, model: `anthropic:${model}` }
  } catch {
    return { ok: false, error: 'ai_invalid_output', usage }
  }
}

async function runOpenAI(env, apiKey, msgs, schema, model = OPENAI_DEFAULT_MODEL, maxOutput = MAX_OUTPUT.writer) {
  const mock = providerMock(env)
  let res
  try {
    res = await fetch(`${mock ? `${mock}/openai` : 'https://api.openai.com'}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: msgs, max_completion_tokens: maxOutput, response_format: { type: 'json_schema', json_schema: { name: 'website', strict: true, schema: strictSchema(schema) } } }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch {
    return { ok: false, error: 'provider_unavailable' }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, ...openAiError(res.status, body) }
  const choice = body?.choices?.[0]
  const usage = { input: body?.usage?.prompt_tokens ?? 0, output: body?.usage?.completion_tokens ?? 0 }
  if (choice?.message?.refusal) return { ok: false, error: 'ai_declined', usage }
  if (choice?.finish_reason === 'length') return { ok: false, error: 'ai_invalid_output', usage }
  try {
    return { ok: true, raw: JSON.parse(choice?.message?.content || ''), usage, model: `openai:${model}` }
  } catch {
    return { ok: false, error: 'ai_invalid_output', usage }
  }
}

export const runWithOwnKey = (env, cred, msgs, schema) => (cred.provider === 'anthropic' ? runClaude(env, cred.apiKey, msgs, schema, cred.model, cred.maxOutput) : runOpenAI(env, cred.apiKey, msgs, schema, cred.model, cred.maxOutput))
