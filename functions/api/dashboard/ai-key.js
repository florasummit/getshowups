// /api/dashboard/ai-key — the business's own Claude or OpenAI API key for website generation (optional).
//   GET  → { key: { provider, label, hint, status } | null }   (never the key itself)
//   POST { action: 'save', provider: 'anthropic' | 'openai', key }   validated with the provider, then stored encrypted
//        { action: 'model', model }   'auto' or a model this account offers that's compatible and priced
//        { action: 'budget', cents }  monthly limit for AI website work on this key
//        { action: 'refresh' }        re-read the account's model list now
//        { action: 'remove' }
import { json } from '../../../server/google-oauth.js'
import { requireSession } from '../../../server/auth.js'
import { hit, tooManyJson } from '../../../server/ratelimit.js'
import { recordEvent } from '../../../server/auditlog.js'
import { credentialFor, credentialView, removeCredential, saveCredential, setBudget, setModel } from '../../../server/ai-credentials.js'
import { refreshCatalog } from '../../../server/ai-models.js'
import { studioAccess } from '../../../server/website-studio.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  // Website Studio (server/website-studio.js): only eligible businesses have this route.
  if (!(await studioAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const id = session.customer.id
  // New models appear without a deployment: a catalog older than a day is re-read from the provider.
  const cred = await credentialFor(env, id).catch(() => null)
  if (cred) await refreshCatalog(env, id, cred).catch(() => null)
  return json(200, { key: await credentialView(env, id).catch(() => null) })
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  // Website Studio (server/website-studio.js): only eligible businesses have this route.
  if (!(await studioAccess(env, session.customer))) return json(404, { error: 'not_found' })
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
    if (body?.action === 'budget') {
      const r = await setBudget(env, id, body.cents)
      if (!r.ok) return json(r.httpStatus, { error: r.error })
      return json(200, { key: await credentialView(env, id) })
    }
    if (body?.action === 'refresh') {
      const cred = await credentialFor(env, id)
      if (!cred) return json(404, { error: 'not_found' })
      await refreshCatalog(env, id, cred, { force: true })
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
