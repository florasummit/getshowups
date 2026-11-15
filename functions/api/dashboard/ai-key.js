// /api/dashboard/ai-key — the business's own Claude or OpenAI API key for website generation (optional).
//   GET  → { key: { provider, label, hint, status } | null }   (never the key itself)
//   POST { action: 'save', provider: 'anthropic' | 'openai', key }   validated with the provider, then stored encrypted
//        { action: 'model', model }   choose one of the allowlisted models (server/ai-credentials.js MODELS)
//        { action: 'remove' }
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { recordEvent } from '../../../server/auditlog.js'
import { credentialView, removeCredential, saveCredential, setModel } from '../../../server/ai-credentials.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  return json(200, { key: await credentialView(env, session.customer.id).catch(() => null) })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  const id = session.customer.id
  try {
    if (body?.action === 'save') {
      const rl = await hit(env, 'aiKey', id)
      if (rl.limited) return tooManyJson(rl.retryAfter)
      const r = await saveCredential(env, id, body.provider, body.key, Date.now(), body.model ?? null)
      if (!r.ok) return json(r.httpStatus, { error: r.error })
      await recordEvent(env.ONBOARDING_DB, { type: 'ai.key_saved', actor: `owner:${session.email}`, customer: id, capability: 'website.ai', resource: { type: 'ai_key', id }, outcome: 'success', details: { provider: body.provider } })
      return json(200, { key: await credentialView(env, id) })
    }
    if (body?.action === 'model') {
      const r = await setModel(env, id, body.model)
      if (!r.ok) return json(r.httpStatus, { error: r.error })
      return json(200, { key: await credentialView(env, id) })
    }
    if (body?.action === 'remove') {
      await removeCredential(env, id)
      await recordEvent(env.ONBOARDING_DB, { type: 'ai.key_removed', actor: `owner:${session.email}`, customer: id, capability: 'website.ai', resource: { type: 'ai_key', id }, outcome: 'success' })
      return json(200, { key: null })
    }
    return json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('ai key failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
