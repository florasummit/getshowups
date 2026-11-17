// Stored website imports (migration 0021) and applying one to the PRIVATE draft. The crawl itself is
// server/site-import.js. Nothing here touches the live site: publishing stays an explicit owner action.
import { applyFixes, compactResult, contentFixes, crawlSite, fetchImage, planAddresses, reviewFlags, setImportMock, suggestContent } from './site-import.js'
import { assetIdsFor, LIMITS, loadWebsite, saveDraft, validateContent } from './website.js'
import { approvedClaimsFor } from './landing.js'
import { MAX_ASSETS, saveAsset } from './assets.js'
import { recordEvent } from './auditlog.js'
import { ensureServices, legalSections, PAGE_KINDS, starterSite, withPages } from './site-starter.js'
import { getProfile } from './onboarding.js'
import { receptionistOn } from './receptionist/engine.js'

export const IMPORT_FIELDS = ['headline', 'intro', 'about', 'services', 'area', 'seoTitle', 'seoDescription', 'redirects']
const ID_RE = /^[a-f0-9]{32}$/
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')

// What the owner sees: pages found, what was skipped and why, flags, and the suggested content + photos.
// plan: { site, fresh } of the business's current draft (see draftSite).
export function importView(row, plan = {}) {
  if (!row) return null
  if (row.status !== 'done') return { id: row.id, sourceUrl: row.source_url, status: row.status, error: row.error, createdAt: row.created_at }
  const r = JSON.parse(row.result)
  const suggestion = suggestContent(r, LIMITS, { site: plan?.site || null, fresh: Boolean(plan?.fresh) })
  suggestion.fixes = contentFixes(suggestion.content, r)
  return {
    id: row.id,
    sourceUrl: row.source_url,
    platform: row.platform,
    status: row.status,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
    pages: r.pages.map((p) => ({ path: p.path, title: p.title, headings: p.headings.length, words: p.text.reduce((n, b) => n + b.text.split(/\s+/).length, 0), images: p.images.length })),
    skipped: r.skipped,
    flags: r.flags || [],
    suggestion,
  }
}

// The current draft's AI-designed site (pages by slug), so old addresses are planned against what exists now.
// fresh: no multi-page site, nothing published and no design chosen → an import builds the site (see applyImport).
async function draftSite(db, customerId) {
  const w = await db.prepare('SELECT draft, live_version FROM websites WHERE customer = ?1').bind(customerId).first()
  try {
    const d = JSON.parse(w?.draft || '{}')
    return { site: d.site || null, fresh: !d.site && w?.live_version == null && !d.design }
  } catch {
    return { site: null, fresh: false }
  }
}

export async function latestImport(db, customerId) {
  const row = await db.prepare('SELECT * FROM website_imports WHERE customer = ?1 ORDER BY created_at DESC LIMIT 1').bind(customerId).first()
  return importView(row, row ? await draftSite(db, customerId) : null)
}

export async function runImport(env, customerId, url, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const id = newId()
  setImportMock(env.SITE_IMPORT_MOCK_ORIGIN)
  const r = await crawlSite(url)
  if (!r.ok) {
    await db.prepare("INSERT INTO website_imports (id, customer, source_url, status, error, created_at) VALUES (?1, ?2, ?3, 'failed', ?4, ?5)").bind(id, customerId, String(url).slice(0, 300), r.error, now).run()
    return { ok: false, error: r.error, import: importView(await db.prepare('SELECT * FROM website_imports WHERE id = ?1').bind(id).first()) }
  }
  const stored = compactResult({ ...r, flags: reviewFlags(r) })
  await db
    .prepare("INSERT INTO website_imports (id, customer, source_url, platform, status, result, created_at) VALUES (?1, ?2, ?3, ?4, 'done', ?5, ?6)")
    .bind(id, customerId, r.source, r.platform, JSON.stringify(stored), now)
    .run()
  return { ok: true, import: importView(await db.prepare('SELECT * FROM website_imports WHERE id = ?1').bind(id).first(), await draftSite(db, customerId)) }
}

// Applies chosen fields and photos to the private draft. Photos: only URLs found in THIS import (never arbitrary URLs
// from the client), downloaded and byte-checked by saveAsset, within the asset limit. Fields that fail the claims filter
// or limits are left as they were and reported.
export async function applyImport(env, customer, importId, { fields = [], photos = [], fixes = [], pages = [], by } = {}, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!ID_RE.test(String(importId))) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const row = await db.prepare("SELECT * FROM website_imports WHERE id = ?1 AND customer = ?2 AND status = 'done'").bind(importId, customer.id).first()
  if (!row) return { ok: false, httpStatus: 404, error: 'not_found' }
  const website = await loadWebsite(db, customer)
  const view = importView(row, { site: website.draft?.site || null, fresh: !website.draft?.site && !website.published && !website.draft?.design })
  view.result = JSON.parse(row.result)
  view.sourceOrigin = new URL(row.source_url.startsWith('http') ? row.source_url : `https://${row.source_url}`).origin
  // Fixes the owner ticked (typos corrected from their own site's spelling; unrelated template text left out).
  const fixIds = (Array.isArray(fixes) ? fixes : []).filter((i) => Number.isInteger(i))
  view.suggestion.content = applyFixes(view.suggestion.content, view.suggestion.fixes, fixIds)
  const chosen = (Array.isArray(fields) ? fields : []).filter((f) => IMPORT_FIELDS.includes(f) && view.suggestion.content[f] !== undefined)
  const offered = new Set(view.suggestion.photos.map((p) => p.url))
  const wanted = [...new Set((Array.isArray(photos) ? photos : []).filter((u) => offered.has(u)))].slice(0, LIMITS.photos)
  setImportMock(env.SITE_IMPORT_MOCK_ORIGIN)
  const draft = (await loadWebsite(db, customer)).draft
  const claims = await approvedClaimsFor(db, customer.id)

  // Fields one at a time, so one rejected field doesn't block the rest.
  let content = { ...draft }
  const rejected = []
  for (const f of chosen) {
    // `prior`: on an AI-designed draft, imported services keep the id (and description) of the same-named service.
    const [errors, next] = validateContent({ ...content, [f]: view.suggestion.content[f] }, claims, null, { prior: draft.services })
    if (errors.length) rejected.push({ field: f, reason: errors.some((e) => e.endsWith(':unapproved_claim')) ? 'claim' : 'limit' })
    else content = { ...content, [f]: next[f] }
  }

  // Photos: download, check, store. Failures are reported, never fatal.
  const added = []
  const failed = []
  const count = (await db.prepare('SELECT count(*) AS n FROM website_assets WHERE customer = ?1').bind(customer.id).first())?.n ?? 0
  for (const url of wanted.slice(0, Math.max(0, MAX_ASSETS - count))) {
    const img = await fetchImage(url)
    const saved = img.ok ? await saveAsset(db, customer.id, img.bytes, now) : img
    if (saved.ok) added.push(saved.asset.id)
    else failed.push({ url, reason: saved.error })
  }
  if (added.length) {
    // The first imported photo becomes the main photo only if there isn't one; the owner's existing choices stay.
    const hero = content.hero || added[0]
    content = { ...content, hero, photos: [...new Set([...added, ...(content.photos || [])])].filter((p) => p !== hero).slice(0, LIMITS.photos) }
  }
  // One content system: approved content becomes website content on the multi-page site the editor and publishing use.
  //  - No site yet (and nothing published): a starter site from the business's records + this approved content.
  //  - A site already: only the chosen pages it doesn't have are added, and approved services always get a place.
  //  - An older single-page website that is live keeps its look: fields only (pages need the new editor).
  const site = await siteFromImport(env, customer, { draft, content, published: website.published, view, kinds: pages, now })
  if (site.site) {
    content = { ...content, site: site.site }
    // Old addresses re-planned against the site actually saved (pages just added keep their addresses; no redirect to
    // a page or section that doesn't exist).
    if (chosen.includes('redirects')) content.redirects = planAddresses(view.result, site.site).filter((a) => !a.kept).map((a) => ({ from: a.from, to: a.to }))
  }
  const [errors, final] = validateContent(content, claims, await assetIdsFor(db, customer.id), { prior: draft.services })
  if (errors.length) return { ok: false, httpStatus: 400, error: 'invalid_content', fields: errors }
  await saveDraft(db, customer.id, final, now)
  await db.prepare('UPDATE website_imports SET applied_at = ?2 WHERE id = ?1').bind(importId, now).run()
  await recordEvent(db, { type: 'website.import_applied', actor: by ? `owner:${by}` : 'system', customer: customer.id, capability: 'website', resource: { type: 'website_import', id: importId }, outcome: 'success', details: { fields: chosen.length - rejected.length, photos: added.length, rejected: rejected.length, failedPhotos: failed.length, fixes: fixIds.length, pages: site.added.length, created: Boolean(site.created), servicesSection: Boolean(site.servicesAdded) } })
  return { ok: true, applied: chosen.filter((f) => !rejected.some((r) => r.field === f)), rejected, photosAdded: added.length, photosFailed: failed.map((f) => f.reason), pagesAdded: site.added, siteCreated: Boolean(site.created), servicesSection: Boolean(site.servicesAdded), pagesSkipped: site.skipped || null }
}

// The business facts pages are built from (records, never the client): name, industry, phone, chat on/off, visits.
async function bizFacts(env, customer) {
  const profile = await getProfile(env.ONBOARDING_DB, customer.id).catch(() => null)
  return { name: customer.name, industry: profile?.industry || '', description: profile?.description || '', phone: profile?.phone || '', chat: await receptionistOn(env, customer).catch(() => false), visit: customer.appointmentMode === 'at_customer' }
}

async function siteFromImport(env, customer, { draft, content, published, view, kinds, now }) {
  const wanted = (Array.isArray(kinds) ? kinds : []).filter((k) => PAGE_KINDS.includes(k) && view.suggestion.pages.some((o) => o.kind === k && !o.exists))
  const offer = (k) => view.suggestion.pages.find((o) => o.kind === k)
  // The policy page's text, word for word, from THIS import only (never client-supplied text).
  const policy = offer('privacy')?.source === 'imported' ? legalSections(view.result.pages.find((p) => p.path === offer('privacy').path)) : null
  const privacy = policy?.ok ? { sections: policy.sections, url: `${view.sourceOrigin}${offer('privacy').path}` } : null
  const biz = await bizFacts(env, customer)
  if (!draft.site) {
    if (published || draft.design) return { added: [], skipped: wanted.length ? 'single_page_site' : null } // keep a look the owner chose
    const made = starterSite(content, biz, { kinds: wanted, privacy, now })
    return { site: made.site, added: made.added, created: true }
  }
  let site = draft.site
  let servicesAdded = false
  if (content.services?.length) ({ site, added: servicesAdded } = ensureServices(site, content))
  const made = withPages(site, content, biz, wanted, { privacy, now })
  return { site: made.site, added: made.added, servicesAdded }
}
