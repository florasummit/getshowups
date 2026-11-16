// GET /api/dashboard/website/preview — the owner's private draft, rendered exactly like the public
// site (links inert, noindex, frameable only by our own dashboard). ?live=1 shows the live version;
// ?generation=<id>&option=<n> shows a stored generation's design; ?template= previews a classic style (no AI call).
import { requireSession } from '../../../../server/auth.js'
import { assetIdsFor, liveContent, loadWebsite, TEMPLATES, validateContent } from '../../../../server/website.js'
import { json } from '../../../../server/google-oauth.js'
import { approvedClaimsFor } from '../../../../server/landing.js'
import { validateSpec } from '../../../../server/site-spec.js'
import { studioAccess } from '../../../../server/website-studio.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { getGeneration } from '../../../../server/website-ai.js'
import { siteBusinessInfo } from '../../../../server/site-serve.js'
import { htmlResponse, renderNotice, renderSite } from '../../../../server/site-render.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return htmlResponse(response.status, renderNotice('Preview unavailable', 'Sign in to see your website preview.'), { preview: true })
  const db = env.ONBOARDING_DB
  try {
    const q = new URL(request.url).searchParams
    const live = q.get('live') === '1'
    const generation = q.get('generation')
    let content = generation
      ? (await getGeneration(db, session.customer.id, generation))?.content
      : live
        ? (await liveContent(db, session.customer.id))?.content
        : (await loadWebsite(db, session.customer)).draft
    if (content && generation) {
      const g = await getGeneration(db, session.customer.id, generation)
      const draft = (await loadWebsite(db, session.customer)).draft
      const option = Number.parseInt(q.get('option') || '0', 10)
      content = { ...content, design: g.designs[option] ?? content.design ?? null, logo: draft.logo, hero: draft.hero, photos: draft.photos }
    }
    if (content && TEMPLATES.includes(q.get('template'))) content = { ...content, template: q.get('template') }
    if (!content) return htmlResponse(404, renderNotice('Not published yet', 'Publish your website to see it here.'), { preview: true })
    const page = /^[a-z0-9-]{0,32}$/.test(q.get('page') || '') ? q.get('page') || '' : ''
    // Multi-page designs: nav links stay inside the private preview.
    const pageBase = `/api/dashboard/website/preview?${live ? 'live=1&' : ''}page=`
    return htmlResponse(200, renderSite(await siteBusinessInfo(db, session.customer), content, { preview: true, page, pageBase }), { preview: true })
  } catch (err) {
    console.error('preview failed:', err?.message)
    return htmlResponse(503, renderNotice('Preview unavailable', 'Please try again in a moment.'), { preview: true })
  }
}

// POST { content, page } → { html, removed[] }: the Website Studio editor's live preview of UNSAVED changes, validated
// exactly like a save (the same repairs and claims filter), rendered for the editor (hidden sections shown dimmed, page
// links kept inside the editor as "#page=<slug>"). Nothing is stored. Website Studio only; owner session, same-origin.
const EDITOR_NOTICE_REASONS = ['claim', 'too_long', 'link', 'image', 'invented_number']
export async function onRequestPost({ request, env }) {
  const { session, response } = await requireSession(request, env, { write: true })
  if (response) return response
  if (!(await studioAccess(env, session.customer))) return json(404, { error: 'not_found' })
  const rl = await hit(env, 'websitePreview', session.customer.id)
  if (rl.limited) return tooManyJson(rl.retryAfter)
  const body = await request.json().catch(() => null)
  if (!body?.content || typeof body.content !== 'object' || !body.content.site) return json(400, { error: 'invalid_request' })
  const db = env.ONBOARDING_DB
  try {
    const [claims, assetIds, saved] = await Promise.all([approvedClaimsFor(db, session.customer.id), assetIdsFor(db, session.customer.id), loadWebsite(db, session.customer)])
    const [, content] = validateContent(body.content, claims, assetIds, { prior: saved.draft.services })
    const { warnings } = validateSpec(body.content.site, { assetIds, services: content.services, legacyServices: saved.draft.services, claims })
    const page = /^[a-z0-9-]{0,32}$/.test(String(body.page || '')) ? String(body.page || '') : ''
    const html = renderSite(await siteBusinessInfo(db, session.customer), content, { preview: true, editing: true, page, pageBase: '#page=', form: { action: '#', token: '', state: null } })
    return json(200, { html, removed: warnings.filter((w) => EDITOR_NOTICE_REASONS.includes(w.reason)).slice(0, 20) })
  } catch (err) {
    console.error('editor preview failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
