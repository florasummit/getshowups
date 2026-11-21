// GET /site-assets/:id — a website image. Public only while the business's live website uses it;
// otherwise only the signed-in owner can load it (for the private preview).
import { missingConfig } from '../../server/google-oauth.js'
import { getSession } from '../../server/auth.js'
import { PUBLIC_MAX_AGE, readAsset } from '../../server/assets.js'
import { hostingStatus, isHosted } from '../../server/website.js'

const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })

export async function onRequestGet({ request, env, params }) {
  if (missingConfig(env).length) return notFound()
  const db = env.ONBOARDING_DB
  try {
    const session = await getSession(request, env).catch(() => null)
    const found = await readAsset(db, String(params.id || ''), session?.customer?.id || null)
    if (!found) return notFound()
    if (found.published && !isHosted(await hostingStatus(db, found.asset.customer, Date.now(), env))) return notFound()
    return new Response(found.asset.bytes, {
      headers: {
        'Content-Type': found.asset.content_type,
        // Ids are random and content never changes, so published images cache for a long time (PUBLIC_MAX_AGE: a
        // permanently deleted file may still be served from caches for that long; the delete response says so).
        'Cache-Control': found.published ? `public, max-age=${PUBLIC_MAX_AGE}` : 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        'Cross-Origin-Resource-Policy': 'same-site',
      },
    })
  } catch (err) {
    console.error('asset load failed:', err?.message)
    return notFound()
  }
}
