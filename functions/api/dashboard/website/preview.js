// GET /api/dashboard/website/preview — the owner's private draft, rendered exactly like the public
// site (links inert, noindex, frameable only by our own dashboard). ?live=1 shows the live version.
import { requireSession } from '../../../../server/auth.js'
import { liveContent, loadWebsite } from '../../../../server/website.js'
import { siteBusinessInfo } from '../../../../server/site-serve.js'
import { htmlResponse, renderNotice, renderSite } from '../../../../server/site-render.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return htmlResponse(response.status, renderNotice('Preview unavailable', 'Sign in to see your website preview.'), { preview: true })
  const db = env.ONBOARDING_DB
  try {
    const live = new URL(request.url).searchParams.get('live') === '1'
    const content = live ? (await liveContent(db, session.customer.id))?.content : (await loadWebsite(db, session.customer)).draft
    if (!content) return htmlResponse(404, renderNotice('Not published yet', 'Publish your website to see it here.'), { preview: true })
    return htmlResponse(200, renderSite(await siteBusinessInfo(db, session.customer), content, { preview: true }), { preview: true })
  } catch (err) {
    console.error('preview failed:', err?.message)
    return htmlResponse(503, renderNotice('Preview unavailable', 'Please try again in a moment.'), { preview: true })
  }
}
