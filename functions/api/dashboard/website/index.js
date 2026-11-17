// /api/dashboard/website — the signed-in business's website.
//   GET  → { website, url, hosting, domain, assets, options }
//   POST { action: 'save', content }               save the private draft (autosave)
//        { action: 'publish', content, confirm }   publish a new version (explicit confirmation required)
//        { action: 'unpublish' }                   take the site offline (content kept)
//        { action: 'restore', version }            make an earlier published version live again
//        { action: 'regenerate' }                  a fresh draft from the business details (not saved)
//        { action: 'template' }                    three professional designs from the business details, no AI (stored)
//        { action: 'generate' }                    AI copy + three designs from the business details, stored (draft untouched)
//        { action: 'revise', instruction }         AI revision of the draft ("make it more modern"), stored (draft untouched)
//        { action: 'apply', generationId, option } make a stored design the private draft (owner photos kept)
import { recordEvent } from '../../../../server/auditlog.js'
import { json } from '../../../../server/google-oauth.js'
import { requireSession, siteOrigin } from '../../../../server/auth.js'
import { track } from '../../../../server/events.js'
import { approvedClaimsFor } from '../../../../server/landing.js'
import { displayBrand, assetIdsFor, COLORS, generateContent, hostingStatus, isHosted, loadWebsite, publish, restore, saveDraft, TEMPLATES, unpublish, validateContent } from '../../../../server/website.js'
import { listAssets } from '../../../../server/assets.js'
import { domainFor } from '../../../../server/domains.js'
import { FONTS, PALETTES } from '../../../../server/site-design.js'
import { aiConfigured, generateWebsite, getGeneration, reviseWebsite } from '../../../../server/website-ai.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { aiUsage, recordAiUse } from '../../../../server/ai-usage.js'
import { credentialView } from '../../../../server/ai-credentials.js'
import { hasStudioOutput, studioAccess, studioPublishAllowed } from '../../../../server/website-studio.js'
import { listCheckpoints, maybeCheckpoint, restoreCheckpoint, saveCheckpoint } from '../../../../server/website-history.js'
import { renderSite } from '../../../../server/site-render.js'
import { starterSite } from '../../../../server/site-starter.js'
import { getProfile } from '../../../../server/onboarding.js'
import { receptionistOn } from '../../../../server/receptionist/engine.js'
import { siteBusinessInfo } from '../../../../server/site-serve.js'

// A business without Website Studio access (server/website-studio.js) can't introduce an AI-designed site or old-address
// redirects by hand-crafting a save: those two fields keep what the stored draft already has (nothing is lost).
async function guardStudioFields(env, customer, content) {
  if (!content || typeof content !== 'object' || (await studioAccess(env, customer))) return content
  const { site: _s, redirects: _r, ...rest } = content
  const current = (await loadWebsite(env.ONBOARDING_DB, customer)).draft
  return { ...rest, ...(current.site ? { site: current.site } : {}), ...(current.redirects ? { redirects: current.redirects } : {}) }
}

// Legal pages (exempt from the claims filter) are created only by the server (import word for word, or the starter).
// A save from the page may keep a page legal that already was, never mark a new one: otherwise any text could be
// published unfiltered by calling it a policy. A page whose flag is dropped goes through the normal filters.
function guardLegalPages(content, saved) {
  if (!content?.site?.pages) return content
  const legal = new Set((saved?.site?.pages || []).filter((p) => p.legal).map((p) => p.slug))
  return { ...content, site: { ...content.site, pages: content.site.pages.map((p) => (p?.legal && !legal.has(p.slug) ? (({ legal: _l, source: _s, ...rest }) => rest)(p) : p)) } }
}

// Pre-publish check: every page of the content renders (no exception) with this business's details. A content that
// can't render is never made live, so visitors keep seeing the previous version.
async function rendersCleanly(db, customer, content) {
  try {
    const biz = await siteBusinessInfo(db, customer)
    for (const page of content?.site?.pages?.map((p) => p.slug) || ['']) {
      const html = renderSite(biz, content, { page, pageBase: '', bookUrl: '/book', canonical: null })
      if (typeof html !== 'string' || !html.includes('</html>')) return false
    }
    return true
  } catch (err) {
    console.error('pre-publish render failed:', err?.name)
    return false
  }
}

async function state(env, customer, email) {
  const db = env.ONBOARDING_DB
  const studio = await studioAccess(env, customer)
  const [website, hosting, domain, assets, usage, aiKey] = await Promise.all([
    loadWebsite(db, customer),
    hostingStatus(db, customer.id),
    domainFor(env, customer.id),
    listAssets(db, customer.id),
    aiUsage(env, customer, email),
    studio ? credentialView(env, customer.id).catch(() => null) : null, // Website Studio only
  ])
  return {
    studio, // Website Studio for this business (server/website-studio.js): designer, own AI key, import
    brand: displayBrand(customer.name, website.draft), // the public name the editor's templates use
    visit: customer.appointmentMode === 'at_customer',
    studioPublish: studioPublishAllowed(env), // whether AI-designed sites / Studio redirects may go live (on unless switched off)
    website,
    url: `${siteOrigin(env)}/p/${customer.id}`,
    hosting,
    domain,
    assets,
    // Bookable = calendar connected and hours saved; a site without booking isn't published.
    ready: customer.hoursConfirmed && Boolean(await env.GOOGLE_TOKENS.get(`google:${customer.id}`)),
    writer: aiConfigured(env) || aiKey?.status === 'ok', // AI copy available (otherwise the template is used)
    checkpoints: studio ? await listCheckpoints(db, customer.id).catch(() => []) : [], // recoverable draft copies
    aiKey, // the business's own Claude/OpenAI key (provider + last 4 only), if any
    aiUsage: usage, // today's AI allowance (server/ai-usage.js); manual edits are never limited
    options: {
      templates: TEMPLATES,
      colors: COLORS,
      palettes: Object.fromEntries(Object.entries(PALETTES).map(([k, p]) => [k, { label: p.label, bg: p.bg, accent: p.accent, dark: Boolean(p.dark) }])),
      fonts: Object.fromEntries(Object.entries(FONTS).map(([k, f]) => [k, f.label])),
    },
  }
}

export async function onRequestGet({ request, env }) {
  const { session, response } = await requireSession(request, env)
  if (response) return response
  try {
    return json(200, await state(env, session.customer, session.email))
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
    // Start from a design: the three professional layouts filled with the business details. No AI, no allowance used.
    if (action === 'template') {
      const draft = (await loadWebsite(db, customer)).draft
      const r = await generateWebsite(env, customer, { draftPhotos: [draft.hero, ...(draft.photos || [])].filter(Boolean), logo: draft.logo || null, allowAi: false, useAi: false })
      await track(env, 'website_template', { customer: customer.id })
      return json(200, { generation: r.generation, aiUsage: await aiUsage(env, customer, session.email) })
    }
    if (action === 'generate' || action === 'revise') {
      const kind = action === 'generate' ? 'generation' : 'revision'
      const rl = await hit(env, 'websiteAi', customer.id)
      if (rl.limited) return tooManyJson(rl.retryAfter)
      const usage = await aiUsage(env, customer, session.email)
      if (usage[kind].remaining <= 0) return json(429, { error: 'daily_limit', kind, limit: usage[kind].limit, resetsAt: usage.resetsAt, aiUsage: usage })
      const own = (await credentialView(env, customer.id).catch(() => null))?.status === 'ok'
      // The monthly ceiling protects OUR spend; a business using its own key isn't limited by it (daily limits still apply).
      if (kind === 'revision' && usage.monthlyCapReached && !own) return json(429, { error: 'monthly_limit', aiUsage: usage })
      const loaded = await loadWebsite(db, customer)
      const draft = loaded.draft
      const r =
        kind === 'generation'
          ? await generateWebsite(env, customer, {
              draftPhotos: [draft.hero, ...(draft.photos || [])].filter(Boolean),
              logo: draft.logo || null,
              allowAi: !usage.monthlyCapReached,
              // The owner's own (imported or edited) text informs a new design.
              draftText: loaded.generated ? null : [draft.headline, draft.intro, draft.about, ...(draft.services || []).map((x) => `${x.name} ${x.price} ${x.description}`)].join('\n'),
            })
          : await reviseWebsite(env, customer, draft, body.instruction)
      if (!r.ok) return json(r.httpStatus, { error: r.error, aiUsage: usage })
      // Only successful AI results count against the allowance (template fallbacks are free).
      if (r.generation.source === 'ai') await recordAiUse(db, customer.id, kind)
      await track(env, kind === 'generation' ? 'website_generated' : 'website_revised', { customer: customer.id, props: kind === 'generation' ? { source: r.generation.source } : {} })
      return json(200, { generation: r.generation, aiUsage: await aiUsage(env, customer, session.email) })
    }
    if (action === 'apply') {
      const g = await getGeneration(db, customer.id, body.generationId)
      if (!g) return json(404, { error: 'not_found' })
      const current = (await loadWebsite(db, customer)).draft
      // A template/AI-writer result carries no AI-designed site; applying it would silently drop the owner's AI design
      // (e.g. from a tab opened before the design). The AI designer's Undo and earlier versions remain the way back.
      if (current.site) return json(409, { error: 'designed_site' })
      const option = Number.isInteger(body.option) ? body.option : 0
      if (g.designs.length && !g.designs[option]) return json(400, { error: 'invalid_request' })
      // The owner's logo, photos and confirmed facts stay; the chosen design is applied. Only the private draft changes.
      const [errors, content] = validateContent(
        { ...g.content, highlights: current.highlights?.length ? current.highlights : g.content.highlights, template: body.template ?? g.content.template, design: g.designs[option] ?? g.content.design ?? null, logo: current.logo, hero: current.hero, photos: current.photos, redirects: current.redirects || [] },
        await approvedClaimsFor(db, customer.id),
        await assetIdsFor(db, customer.id),
      )
      if (errors.length) return json(400, { error: 'invalid_content', fields: errors })
      await saveDraft(db, customer.id, content)
      return json(200, await state(env, customer, session.email))
    }
    // "I'm starting fresh": a multi-page website from what GetShowUps already knows about the business (records only; no AI,
    // no key, no cost) → PRIVATE draft. Never replaces a designed site.
    if (action === 'starter') {
      if (!(await studioAccess(env, customer))) return json(404, { error: 'not_found' })
      const loaded = await loadWebsite(db, customer)
      if (loaded.draft.site) return json(409, { error: 'designed_site' })
      const profile = await getProfile(db, customer.id).catch(() => null)
      const biz = { name: customer.name, industry: profile?.industry || '', description: profile?.description || '', phone: profile?.phone || '', chat: await receptionistOn(env, customer).catch(() => false), visit: customer.appointmentMode === 'at_customer' }
      const { site } = starterSite(loaded.draft, biz, { kinds: ['contact', 'privacy'], now: Date.now() })
      const [errors, content] = validateContent({ ...loaded.draft, site }, await approvedClaimsFor(db, customer.id), await assetIdsFor(db, customer.id), { prior: loaded.draft.services })
      if (errors.length) return json(400, { error: 'invalid_content', fields: errors })
      await saveDraft(db, customer.id, content)
      await track(env, 'website_starter', { customer: customer.id })
      return json(200, await state(env, customer, session.email))
    }
    if (action === 'save' || action === 'publish') {
      // `prior`: the saved services, so an AI-designed site keeps each service's id (and its description) whatever the
      // page sends back (server/website.js assignServiceIds).
      const savedDraft = (await loadWebsite(db, customer)).draft
      const prior = savedDraft.services
      const [errors, content] = validateContent(guardLegalPages(await guardStudioFields(env, customer, body.content), savedDraft), await approvedClaimsFor(db, customer.id), await assetIdsFor(db, customer.id), { prior })
      if (errors.length) return json(400, { error: 'invalid_content', fields: errors })
      if (action === 'save') {
        // baseUpdatedAt: the draft version the page is editing; a newer draft (another tab, the AI designer) → 409
        // with the latest state, never a silent overwrite. `force: true` (the owner chose "keep mine") skips the check.
        const expect = body.force === true ? undefined : Number.isFinite(body.baseUpdatedAt) ? body.baseUpdatedAt : undefined
        const saved = await saveDraft(db, customer.id, content, Date.now(), { expect })
        if (saved.conflict) return json(409, { error: 'conflict', ...(await state(env, customer, session.email)) })
        // A recoverable server copy at most every 10 minutes of editing (best effort: never fails the save).
        if (await studioAccess(env, customer)) await maybeCheckpoint(db, customer.id, content).catch((e) => console.error('checkpoint failed:', e?.name))
        return json(200, await state(env, customer, session.email))
      }
      if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
      // Legal pages (privacy policy, terms; imported word for word or a starter draft) go public only after the owner
      // confirms they reviewed them, every time they publish.
      if (content.site?.pages?.some((p) => p.legal) && body.legalReviewed !== true) return json(400, { error: 'legal_review_required' })
      const s = await state(env, customer, session.email)
      if (!s.ready) return json(409, { error: 'not_ready' })
      if (!isHosted(s.hosting)) return json(402, { error: 'plan_required' })
      // Emergency off switch only (WEBSITE_STUDIO_PUBLISH=false); publishing is otherwise standard for every business.
      if (hasStudioOutput(content) && !studioPublishAllowed(env)) return json(409, { error: 'studio_publish_off' })
      // Every page must render before anything goes live; otherwise the current live version keeps serving.
      if (!(await rendersCleanly(db, customer, content))) return json(422, { error: 'render_failed' })
      const version = await publish(db, customer.id, content)
      if (await studioAccess(env, customer)) await saveCheckpoint(db, customer.id, content, 'published').catch((e) => console.error('checkpoint failed:', e?.name))
      await track(env, 'website_published', { customer: customer.id, props: { version } })
      await recordEvent(db, { type: 'website.publish', actor: `owner:${session.email}`, customer: customer.id, capability: 'website', resource: { type: 'website', id: customer.id }, outcome: 'success', details: { version } })
      return json(200, await state(env, customer, session.email))
    }
    // Draft checkpoints (server/website-history.js): bring back an earlier server copy of the draft (the current draft is
    // checkpointed first, so a restore can itself be undone). The live website is not touched.
    if (action === 'restoreCheckpoint') {
      if (!(await studioAccess(env, customer))) return json(404, { error: 'not_found' })
      const current = (await loadWebsite(db, customer)).draft
      const r = await restoreCheckpoint(db, customer.id, body.id, { claims: await approvedClaimsFor(db, customer.id), assetIds: await assetIdsFor(db, customer.id), current })
      if (!r.ok) return json(r.httpStatus, { error: r.error })
      await saveDraft(db, customer.id, r.content)
      return json(200, await state(env, customer, session.email))
    }
    if (action === 'unpublish') {
      await unpublish(db, customer)
      await track(env, 'website_unpublished', { customer: customer.id })
      await recordEvent(db, { type: 'website.unpublish', actor: `owner:${session.email}`, customer: customer.id, capability: 'website', resource: { type: 'website', id: customer.id }, outcome: 'success' })
      return json(200, await state(env, customer, session.email))
    }
    if (action === 'restore') {
      // Restoring replaces the live website: the owner confirms it, like a publish.
      if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
      const s = await state(env, customer, session.email)
      if (!isHosted(s.hosting)) return json(402, { error: 'plan_required' })
      const v = await db.prepare('SELECT content FROM website_versions WHERE customer = ?1 AND version = ?2').bind(customer.id, Number(body.version) || 0).first()
      if (v && hasStudioOutput(JSON.parse(v.content)) && !studioPublishAllowed(env)) return json(409, { error: 'studio_publish_off' })
      if (v && !(await rendersCleanly(db, customer, JSON.parse(v.content)))) return json(422, { error: 'render_failed' })
      if (!(await restore(db, customer.id, body.version))) return json(404, { error: 'not_found' })
      await track(env, 'website_restored', { customer: customer.id, props: { version: body.version } })
      await recordEvent(db, { type: 'website.restore', actor: `owner:${session.email}`, customer: customer.id, capability: 'website', resource: { type: 'website', id: customer.id }, outcome: 'success', details: { version: Number(body.version) || null } })
      return json(200, await state(env, customer, session.email))
    }
    return json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('website save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
