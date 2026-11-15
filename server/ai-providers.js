// Website AI with the business's OWN API key (server/ai-credentials.js): Claude (Anthropic SDK) or OpenAI (REST).
// Same contract as the included Workers AI path in server/website-ai.js: the model returns JSON matching our schema
// (named design options + prose), and the caller validates/repairs everything (claims filter, invented-number check,
// design repair) exactly as before. The model never writes HTML, CSS or scripts.
// Returns { ok: true, raw, usage: { input, output }, model } or { ok: false, error } with an allowlisted error code.
import Anthropic from '@anthropic-ai/sdk'
import { providerMock } from './ai-credentials.js'
import { MAX_OUTPUT, claudeFallbackFor } from './ai-models.js'

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

async function runClaude(env, apiKey, msgs, schema, model = CLAUDE_MODEL) {
  const mock = providerMock(env)
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: TIMEOUT, ...(mock ? { baseURL: `${mock}/anthropic` } : {}) })
  let response
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: MAX_OUTPUT.writer,
      ...claudeFallbackFor(model),
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: strictSchema(schema) } },
      system: msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'),
      messages: msgs.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
    })
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { ok: false, error: 'invalid_key' }
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: 'provider_rate_limited' }
    if (err instanceof Anthropic.BadRequestError) return { ok: false, error: 'provider_rejected' } // e.g. no credit on the API account
    return { ok: false, error: 'provider_unavailable' }
  }
  const usage = { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 }
  if (response.stop_reason === 'refusal') return { ok: false, error: 'ai_declined', usage }
  if (response.stop_reason === 'max_tokens') return { ok: false, error: 'ai_invalid_output', usage }
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  try {
    return { ok: true, raw: JSON.parse(text), usage, model: `anthropic:${response.model || model}` }
  } catch {
    return { ok: false, error: 'ai_invalid_output', usage }
  }
}

async function runOpenAI(env, apiKey, msgs, schema, model = OPENAI_DEFAULT_MODEL) {
  const mock = providerMock(env)
  let res
  try {
    res = await fetch(`${mock ? `${mock}/openai` : 'https://api.openai.com'}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: msgs, max_completion_tokens: MAX_OUTPUT.writer, response_format: { type: 'json_schema', json_schema: { name: 'website', strict: true, schema: strictSchema(schema) } } }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch {
    return { ok: false, error: 'provider_unavailable' }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'invalid_key' }
    if (res.status === 429) return { ok: false, error: body?.error?.code === 'insufficient_quota' ? 'provider_rejected' : 'provider_rate_limited' }
    if (res.status === 400) return { ok: false, error: 'provider_rejected' }
    return { ok: false, error: 'provider_unavailable' }
  }
  const choice = body?.choices?.[0]
  const usage = { input: body?.usage?.prompt_tokens ?? 0, output: body?.usage?.completion_tokens ?? 0 }
  if (choice?.message?.refusal) return { ok: false, error: 'ai_declined', usage }
  if (choice?.finish_reason === 'length') return { ok: false, error: 'ai_invalid_output', usage }
  try {
    return { ok: true, raw: JSON.parse(choice?.message?.content || ''), usage, model: `openai:${body?.model || model}` }
  } catch {
    return { ok: false, error: 'ai_invalid_output', usage }
  }
}

export const runWithOwnKey = (env, cred, msgs, schema) => (cred.provider === 'anthropic' ? runClaude(env, cred.apiKey, msgs, schema, cred.model) : runOpenAI(env, cred.apiKey, msgs, schema, cred.model))
