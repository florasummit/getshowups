// /api/dashboard/landing — the signed-in business's landing page.
//   GET  → { page (saved, or a generated draft with generated: true), url }
//   POST { headline, intro, services[], area, highlights[], publish: boolean } → validates, saves, (un)publishes
import { json } from '../../../server/google-oauth.js'
import { requireSession, siteOrigin } from '../../../server/auth.js'
import { track } from '../../../server/events.js'
import { approvedClaimsFor, generateDraft, getPage, savePage, validatePage } from '../../../server/landing.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const db = env.ONBOARDING_DB
  try {
    const saved = await getPage(db, session.customer.id)
    const page = saved || { ...(await generateDraft(db, session.customer)), generated: true }
    return json(200, { page, url: `${siteOrigin(env)}/p/${session.customer.id}` })
  } catch (err) {
    console.error('landing load failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  if (typeof body?.publish !== 'boolean') return json(400, { error: 'invalid_request' })
  const db = env.ONBOARDING_DB
  const [errors, page] = validatePage(body, await approvedClaimsFor(db, session.customer.id))
  if (errors.length) return json(400, { error: 'invalid_page', fields: errors })
  try {
    const saved = await savePage(db, session.customer.id, page, { publish: body.publish })
    await track(env, body.publish ? 'landing_published' : 'landing_saved', { customer: session.customer.id })
    return json(200, { page: saved })
  } catch (err) {
    console.error('landing save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
