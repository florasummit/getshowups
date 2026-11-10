// /api/dashboard/website — the signed-in business's website.
//   GET  → { website, url, hosting, domain, assets, options }
//   POST { action: 'save', content }               save the private draft (autosave)
//        { action: 'publish', content, confirm }   publish a new version (explicit confirmation required)
//        { action: 'unpublish' }                   take the site offline (content kept)
//        { action: 'restore', version }            make an earlier published version live again
//        { action: 'regenerate' }                  a fresh draft from the business details (not saved)
import { json } from '../../../../server/google-oauth.js'
import { requireSession, siteOrigin } from '../../../../server/auth.js'
import { track } from '../../../../server/events.js'
import { approvedClaimsFor } from '../../../../server/landing.js'
import { assetIdsFor, COLORS, generateContent, hostingStatus, isHosted, loadWebsite, publish, restore, saveDraft, TEMPLATES, unpublish, validateContent } from '../../../../server/website.js'
import { listAssets } from '../../../../server/assets.js'
import { domainFor } from '../../../../server/domains.js'

async function state(env, customer) {
  const db = env.ONBOARDING_DB
  const [website, hosting, domain, assets] = await Promise.all([loadWebsite(db, customer), hostingStatus(db, customer.id), domainFor(env, customer.id), listAssets(db, customer.id)])
  return {
    website,
    url: `${siteOrigin(env)}/p/${customer.id}`,
    hosting,
    domain,
    assets,
    // Bookable = calendar connected and hours saved; a site without booking isn't published.
    ready: customer.hoursConfirmed && Boolean(await env.GOOGLE_TOKENS.get(`google:${customer.id}`)),
    options: { templates: TEMPLATES, colors: COLORS },
  }
}

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    return json(200, await state(env, session.customer))
  } catch (err) {
    console.error('website load failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  const body = await request.json().catch(() => null)
  const action = body?.action
  const db = env.ONBOARDING_DB
  const customer = session.customer
  try {
    if (action === 'regenerate') return json(200, { content: await generateContent(db, customer) })
    if (action === 'save' || action === 'publish') {
      const [errors, content] = validateContent(body.content, await approvedClaimsFor(db, customer.id), await assetIdsFor(db, customer.id))
      if (errors.length) return json(400, { error: 'invalid_content', fields: errors })
      if (action === 'save') {
        await saveDraft(db, customer.id, content)
        return json(200, await state(env, customer))
      }
      if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
      const s = await state(env, customer)
      if (!s.ready) return json(409, { error: 'not_ready' })
      if (!isHosted(s.hosting)) return json(402, { error: 'plan_required' })
      const version = await publish(db, customer.id, content)
      await track(env, 'website_published', { customer: customer.id, props: { version } })
      return json(200, await state(env, customer))
    }
    if (action === 'unpublish') {
      await unpublish(db, customer)
      await track(env, 'website_unpublished', { customer: customer.id })
      return json(200, await state(env, customer))
    }
    if (action === 'restore') {
      const s = await state(env, customer)
      if (!isHosted(s.hosting)) return json(402, { error: 'plan_required' })
      if (!(await restore(db, customer.id, body.version))) return json(404, { error: 'not_found' })
      await track(env, 'website_restored', { customer: customer.id, props: { version: body.version } })
      return json(200, await state(env, customer))
    }
    return json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('website save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
