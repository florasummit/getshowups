// /api/dashboard/website/import — bring the business's existing website into its draft.
//   GET  → { import | null }   the latest import (pages found, skipped, flags, suggested content and photos)
//   POST { action: 'start', url, confirm: true }              read the public website (owner confirms it's theirs)
//        { action: 'apply', importId, fields[], photos[], fixes[], pages[] }  chosen content/photos/pages (+ fixes) → PRIVATE draft
// The live website never changes here; publishing stays a separate, explicit step.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { track } from '../../../../server/events.js'
import { applyImport, latestImport, runImport } from '../../../../server/website-import.js'
import { studioAccess } from '../../../../server/website-studio.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  // Website Studio (server/website-studio.js): only eligible businesses have this route.
  if (!(await studioAccess(env, session.customer))) return json(404, { error: 'not_found' })
  try {
    return json(200, { import: await latestImport(env.ONBOARDING_DB, session.customer.id) })
  } catch (err) {
    console.error('website import load failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  // Website Studio (server/website-studio.js): only eligible businesses have this route.
  if (!(await studioAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const body = await request.json().catch(() => null)
  const id = session.customer.id
  try {
    if (body?.action === 'start') {
      if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
      const rl = await hit(env, 'siteImport', id)
      if (rl.limited) return tooManyJson(rl.retryAfter)
      const r = await runImport(env, id, body.url)
      await track(env, 'website_import', { customer: id, props: { ok: r.ok, platform: r.import?.platform ?? null } })
      return json(r.ok ? 200 : 422, r.ok ? { import: r.import } : { error: r.error, import: r.import })
    }
    if (body?.action === 'apply') {
      const r = await applyImport(env, session.customer, body.importId, { fields: body.fields, photos: body.photos, fixes: body.fixes, pages: body.pages, by: session.email })
      if (!r.ok) return json(r.httpStatus, { error: r.error, fields: r.fields })
      return json(200, r)
    }
    return json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('website import failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
