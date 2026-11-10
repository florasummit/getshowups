// GET /api/dashboard/website/export — everything the business owns about its website, as one JSON file:
// website text (draft and published versions), business details, services, and uploaded images.
// Portability: the owner can take it to any other provider. Application code is not included.
import { json } from '../../../../server/google-oauth.js'
import { requireSession } from '../../../../server/auth.js'
import { getProfile } from '../../../../server/onboarding.js'
import { loadWebsite } from '../../../../server/website.js'
import { exportAssets } from '../../../../server/assets.js'
import { domainFor } from '../../../../server/domains.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  const db = env.ONBOARDING_DB
  const c = session.customer
  try {
    const [website, profile, images, domain, versions] = await Promise.all([
      loadWebsite(db, c),
      getProfile(db, c.id),
      exportAssets(db, c.id),
      domainFor(env, c.id),
      db.prepare('SELECT version, content, created_at FROM website_versions WHERE customer = ?1 ORDER BY version').bind(c.id).all(),
    ])
    const body = {
      exportedAt: new Date().toISOString(),
      business: { name: c.name, timezone: c.timezone, appointmentMode: c.appointmentMode, serviceZips: c.serviceZips, ...(profile || {}) },
      website: { draft: website.draft, liveVersion: website.liveVersion, versions: versions.results.map((v) => ({ version: v.version, createdAt: new Date(v.created_at).toISOString(), content: JSON.parse(v.content) })) },
      domain: domain ? { hostname: domain.hostname, status: domain.status } : null,
      images,
    }
    const res = json(200, body)
    res.headers.set('Content-Disposition', `attachment; filename="${c.id}-website-export.json"`)
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (err) {
    console.error('export failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
