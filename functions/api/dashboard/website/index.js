// /api/dashboard/website — the signed-in business's website.
//   GET  → { website, url, hosting, domain, assets, options }
//   POST { action: 'save', content }               save the private draft (autosave)
//        { action: 'publish', content, confirm }   publish a new version (explicit confirmation required)
//        { action: 'unpublish' }                   take the site offline (content kept)
//        { action: 'restore', version }            make an earlier published version live again
//        { action: 'regenerate' }                  a fresh draft from the business details (not saved)
//        { action: 'generate' }                    AI copy + three designs from the business details, stored (draft untouched)
//        { action: 'revise', instruction }         AI revision of the draft ("make it more modern"), stored (draft untouched)
//        { action: 'apply', generationId, option } make a stored design the private draft (owner photos kept)
import { json } from '../../../../server/google-oauth.js'
import { requireSession, siteOrigin } from '../../../../server/auth.js'
import { track } from '../../../../server/events.js'
import { approvedClaimsFor } from '../../../../server/landing.js'
import { assetIdsFor, COLORS, generateContent, hostingStatus, isHosted, loadWebsite, publish, restore, saveDraft, TEMPLATES, unpublish, validateContent } from '../../../../server/website.js'
import { listAssets } from '../../../../server/assets.js'
import { domainFor } from '../../../../server/domains.js'
import { FONTS, PALETTES } from '../../../../server/site-design.js'
import { aiConfigured, generateWebsite, getGeneration, reviseWebsite } from '../../../../server/website-ai.js'
import { hit, tooManyJson } from '../../../../server/ratelimit.js'
import { aiUsage, recordAiUse } from '../../../../server/ai-usage.js'

async function state(env, customer, email) {
  const db = env.ONBOARDING_DB
  const [website, hosting, domain, assets, usage] = await Promise.all([
    loadWebsite(db, customer),
    hostingStatus(db, customer.id),
    domainFor(env, customer.id),
    listAssets(db, customer.id),
    aiUsage(env, customer, email),
  ])
  return {
    website,
    url: `${siteOrigin(env)}/p/${customer.id}`,
    hosting,
    domain,
    assets,
    // Bookable = calendar connected and hours saved; a site without booking isn't published.
    ready: customer.hoursConfirmed && Boolean(await env.GOOGLE_TOKENS.get(`google:${customer.id}`)),
    writer: aiConfigured(env), // AI copy available (otherwise the template is used)
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
    if (action === 'generate' || action === 'revise') {
      const kind = action === 'generate' ? 'generation' : 'revision'
      const rl = await hit(env, 'websiteAi', customer.id)
      if (rl.limited) return tooManyJson(rl.retryAfter)
      const usage = await aiUsage(env, customer, session.email)
      if (usage[kind].remaining <= 0) return json(429, { error: 'daily_limit', kind, limit: usage[kind].limit, resetsAt: usage.resetsAt, aiUsage: usage })
      if (kind === 'revision' && usage.monthlyCapReached) return json(429, { error: 'monthly_limit', aiUsage: usage })
      const draft = (await loadWebsite(db, customer)).draft
      const r =
        kind === 'generation'
          ? await generateWebsite(env, customer, { draftPhotos: [draft.hero, ...(draft.photos || [])].filter(Boolean), allowAi: !usage.monthlyCapReached })
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
      const option = Number.isInteger(body.option) ? body.option : 0
      if (g.designs.length && !g.designs[option]) return json(400, { error: 'invalid_request' })
      // The owner's logo, photos and confirmed facts stay; the chosen design is applied. Only the private draft changes.
      const [errors, content] = validateContent(
        { ...g.content, highlights: current.highlights?.length ? current.highlights : g.content.highlights, template: body.template ?? g.content.template, design: g.designs[option] ?? g.content.design ?? null, logo: current.logo, hero: current.hero, photos: current.photos },
        await approvedClaimsFor(db, customer.id),
        await assetIdsFor(db, customer.id),
      )
      if (errors.length) return json(400, { error: 'invalid_content', fields: errors })
      await saveDraft(db, customer.id, content)
      return json(200, await state(env, customer, session.email))
    }
    if (action === 'save' || action === 'publish') {
      const [errors, content] = validateContent(body.content, await approvedClaimsFor(db, customer.id), await assetIdsFor(db, customer.id))
      if (errors.length) return json(400, { error: 'invalid_content', fields: errors })
      if (action === 'save') {
        await saveDraft(db, customer.id, content)
        return json(200, await state(env, customer, session.email))
      }
      if (body.confirm !== true) return json(400, { error: 'confirmation_required' })
      const s = await state(env, customer, session.email)
      if (!s.ready) return json(409, { error: 'not_ready' })
      if (!isHosted(s.hosting)) return json(402, { error: 'plan_required' })
      const version = await publish(db, customer.id, content)
      await track(env, 'website_published', { customer: customer.id, props: { version } })
      return json(200, await state(env, customer, session.email))
    }
    if (action === 'unpublish') {
      await unpublish(db, customer)
      await track(env, 'website_unpublished', { customer: customer.id })
      return json(200, await state(env, customer, session.email))
    }
    if (action === 'restore') {
      const s = await state(env, customer, session.email)
      if (!isHosted(s.hosting)) return json(402, { error: 'plan_required' })
      if (!(await restore(db, customer.id, body.version))) return json(404, { error: 'not_found' })
      await track(env, 'website_restored', { customer: customer.id, props: { version: body.version } })
      return json(200, await state(env, customer, session.email))
    }
    return json(400, { error: 'invalid_request' })
  } catch (err) {
    console.error('website save failed:', err?.message)
    return json(503, { error: 'storage_error' })
  }
}
