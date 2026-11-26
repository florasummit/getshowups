// GET /api/dashboard/website/preview — the owner's private draft, rendered exactly like the public
// site (links inert, noindex, frameable only by our own dashboard). ?live=1 shows the live version;
// ?generation=<id>&option=<n> shows a stored generation's design (&studio=1: as the multi-page website it becomes when
// chosen from the Website tab, so the owner picks what they will get); ?checkpoint=<id> shows an earlier copy of the
// draft from History before the owner restores it; ?template= previews a classic style (no AI call).
import { requireSession } from '../../../../server/auth.js'
import { assetIdsFor, liveContent, loadWebsite, TEMPLATES, validateContent, withoutMissingAssets } from '../../../../server/website.js'
import { json } from '../../../../server/google-oauth.js'
import { approvedClaimsFor } from '../../../../server/landing.js'
import { validateSpec } from '../../../../server/site-spec.js'
import { studioAccess } from '../../../../server/website-studio.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { getGeneration } from '../../../../server/website-ai.js'
import { siteBusinessInfo } from '../../../../server/site-serve.js'
import { htmlResponse, renderNotice, renderSite } from '../../../../server/site-render.js'
import { checkpointDraft } from '../../../../server/website-history.js'
import { starterSite } from '../../../../server/site-starter.js'
import { starterFacts } from '../../../../server/website-import.js'
import { applyRevision } from '../../../../server/website-revise.js'

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return htmlResponse(response.status, renderNotice('Preview unavailable', 'Sign in to see your website preview.'), { preview: true })
  const db = env.ONBOARDING_DB
  try {
    const q = new URL(request.url).searchParams
    const live = q.get('live') === '1'
    const generation = q.get('generation')
    const checkpoint = q.get('checkpoint')
    // History (Website Studio): an earlier copy of this business's own draft, validated like a restore would be.
    if (checkpoint) {
      const stored = (await studioAccess(env, session.customer)) ? await checkpointDraft(db, session.customer.id, checkpoint) : null
      if (!stored) return htmlResponse(404, renderNotice('Preview unavailable', 'That earlier version is no longer kept.'), { preview: true })
      const assetIds = await assetIdsFor(db, session.customer.id)
      const [, shown] = validateContent(withoutMissingAssets(stored, assetIds).content, await approvedClaimsFor(db, session.customer.id), assetIds, { prior: stored.services })
      const pg = /^[a-z0-9-]{0,32}$/.test(q.get('page') || '') ? q.get('page') || '' : ''
      return htmlResponse(200, renderSite(await siteBusinessInfo(db, session.customer), shown, { preview: true, page: pg, pageBase: `/api/dashboard/website/preview?checkpoint=${checkpoint}&page=` }), { preview: true })
    }
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
      // A "Describe a change" version of a multi-page website: the draft with exactly what 'apply' would write.
      if (draft.site && g.basis) {
        const ids = await assetIdsFor(db, session.customer.id)
        content = validateContent(applyRevision(draft, g).content, await approvedClaimsFor(db, session.customer.id), ids, { prior: draft.services })[1]
      }
      // The same conversion 'apply' with studio: true performs (functions/api/dashboard/website/index.js); not stored.
      if (q.get('studio') === '1' && !draft.site && (await studioAccess(env, session.customer))) {
        const { site } = starterSite(content, await starterFacts(env, session.customer), { kinds: ['contact', 'privacy'], design: content.design })
        const assetIds = await assetIdsFor(db, session.customer.id)
        content = validateContent({ ...content, site }, await approvedClaimsFor(db, session.customer.id), assetIds, { prior: content.services })[1]
      }
    }
    if (content && TEMPLATES.includes(q.get('template'))) content = { ...content, template: q.get('template') }
    if (!content) return htmlResponse(404, renderNotice('Not published yet', 'Publish your website to see it here.'), { preview: true })
    const page = /^[a-z0-9-]{0,32}$/.test(q.get('page') || '') ? q.get('page') || '' : ''
    // Multi-page designs: nav links stay inside the private preview.
    const pageBase = `/api/dashboard/website/preview?${live ? 'live=1&' : ''}${generation ? `generation=${encodeURIComponent(generation)}&option=${Number.parseInt(q.get('option') || '0', 10) || 0}&${q.get('studio') === '1' ? 'studio=1&' : ''}` : ''}page=`
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
    // The editor says what it is itself (Edit / Preview, draft or live in the status bar): the "Preview. Only you can
    // see this." strip of the private preview page is left out of the frame inside the editor (finding WEB-09).
    // The editor's content already shows the catalog (website/index.js state); its unsaved typing is shown as typed, and a
    // service hidden in Settings → Services stays out, like on the public site (server/website-catalog.js).
    const html = renderSite({ ...(await siteBusinessInfo(db, session.customer)), catalogValues: false }, content, { preview: true, editing: true, page, pageBase: '#page=', form: { action: '#', token: '', state: null } }).replace('<div class="preview-bar">Preview. Only you can see this.</div>', '')
    return json(200, { html, removed: warnings.filter((w) => EDITOR_NOTICE_REASONS.includes(w.reason)).slice(0, 20) })
  } catch (err) {
    console.error('editor preview failed:', err?.name)
    return json(503, { error: 'storage_error' })
  }
}
