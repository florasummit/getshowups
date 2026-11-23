// Campaign templates for the signed-in business (server/ads/templates.js). Templates only ever become DRAFTS.
//   GET  → { curated: [...suggested first], saved: [...] }
//   POST { action: 'start', templateId | savedId, dailyCents? }     → one Google draft (409 draft_exists while one is open)
//   POST { action: 'save_from_imported', importedId }               → the business's own imported Search campaign as a template
//   POST { action: 'save_from_draft', campaignId, name? }           → one of its drafts as a template
//   POST { action: 'remove', id }
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { adsAccess, adsEnabled } from '../../../../server/ads/access.js'
import { getProfile } from '../../../../server/ads/campaigns.js'
import { websiteSummary } from '../../../../server/website.js'
import { listTemplates, removeTemplate, saveFromDraft, saveFromImported, startFromTemplate, suggestTemplates } from '../../../../server/ads/templates.js'

const STATUS = { profile_required: 409, draft_exists: 409, not_found: 404, not_ready: 503, too_many_templates: 409, too_many_campaigns: 409, unsupported_campaign_type: 409, not_enough_to_copy: 409, invalid_spec: 400 }

export async function onRequestGet({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env)
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  try {
    const db = env.ONBOARDING_DB
    const profile = await getProfile(db, session.customer.id)
    const saved = await listTemplates(db, session.customer.id)
    return json(200, { curated: suggestTemplates(profile), saved: saved.saved, savedReady: saved.ready })
  } catch (err) {
    console.error('ads templates load failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  if (!adsEnabled(env)) return json(404, { error: 'not_found' })
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!(await adsAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const customer = session.customer
  const rl = await hit(env, 'adsWrite', customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  const db = env.ONBOARDING_DB
  let r
  try {
    const profile = await getProfile(db, customer.id)
    switch (body?.action) {
      case 'start': {
        const origin = new URL(env.GOOGLE_REDIRECT_URI).origin
        const bookingUrl = (await websiteSummary(db, customer.id)).published ? `${origin}/p/${customer.id}` : `${origin}/book/${customer.id}`
        const dailyCents = Number.isInteger(body.dailyCents) && body.dailyCents > 0 ? body.dailyCents : undefined
        r = await startFromTemplate(env, customer, profile, { templateId: body.templateId ?? null, savedId: body.savedId ?? null, dailyCents }, { bookingUrl })
        break
      }
      case 'save_from_imported':
        r = await saveFromImported(env, customer, body.importedId, profile)
        break
      case 'save_from_draft':
        r = await saveFromDraft(env, customer, body.campaignId, typeof body.name === 'string' ? body.name : '')
        break
      case 'remove':
        r = await removeTemplate(env, customer, body.id)
        break
      default:
        return json(400, { error: 'invalid_request' })
    }
  } catch (err) {
    console.error('ads templates action failed:', body?.action, err?.name)
    return json(503, { error: 'storage_error' })
  }
  if (!r.ok) return json(STATUS[r.error] || 400, { error: r.error, ...(r.campaignIds ? { campaignIds: r.campaignIds } : {}) })
  const { ok: _ok, ...rest } = r
  return json(200, rest)
}
