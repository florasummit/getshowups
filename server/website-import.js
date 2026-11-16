// Stored website imports (migration 0021) and applying one to the PRIVATE draft. The crawl itself is
// server/site-import.js. Nothing here touches the live site: publishing stays an explicit owner action.
import { applyFixes, compactResult, contentFixes, crawlSite, fetchImage, reviewFlags, setImportMock, suggestContent } from './site-import.js'
import { assetIdsFor, LIMITS, loadWebsite, saveDraft, validateContent } from './website.js'
import { approvedClaimsFor } from './landing.js'
import { MAX_ASSETS, saveAsset } from './assets.js'
import { recordEvent } from './auditlog.js'

export const IMPORT_FIELDS = ['headline', 'intro', 'about', 'services', 'area', 'seoTitle', 'seoDescription', 'redirects']
const ID_RE = /^[a-f0-9]{32}$/
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')

// What the owner sees: pages found, what was skipped and why, flags, and the suggested content + photos.
export function importView(row) {
  if (!row) return null
  if (row.status !== 'done') return { id: row.id, sourceUrl: row.source_url, status: row.status, error: row.error, createdAt: row.created_at }
  const r = JSON.parse(row.result)
  const suggestion = suggestContent(r, LIMITS)
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

export async function latestImport(db, customerId) {
  const row = await db.prepare('SELECT * FROM website_imports WHERE customer = ?1 ORDER BY created_at DESC LIMIT 1').bind(customerId).first()
  return importView(row)
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
  return { ok: true, import: importView(await db.prepare('SELECT * FROM website_imports WHERE id = ?1').bind(id).first()) }
}

// Applies chosen fields and photos to the private draft. Photos: only URLs found in THIS import (never arbitrary URLs
// from the client), downloaded and byte-checked by saveAsset, within the asset limit. Fields that fail the claims filter
// or limits are left as they were and reported.
export async function applyImport(env, customer, importId, { fields = [], photos = [], fixes = [], by } = {}, now = Date.now()) {
  const db = env.ONBOARDING_DB
  if (!ID_RE.test(String(importId))) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const row = await db.prepare("SELECT * FROM website_imports WHERE id = ?1 AND customer = ?2 AND status = 'done'").bind(importId, customer.id).first()
  if (!row) return { ok: false, httpStatus: 404, error: 'not_found' }
  const view = importView(row)
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
  const [errors, final] = validateContent(content, claims, await assetIdsFor(db, customer.id), { prior: draft.services })
  if (errors.length) return { ok: false, httpStatus: 400, error: 'invalid_content', fields: errors }
  await saveDraft(db, customer.id, final, now)
  await db.prepare('UPDATE website_imports SET applied_at = ?2 WHERE id = ?1').bind(importId, now).run()
  await recordEvent(db, { type: 'website.import_applied', actor: by ? `owner:${by}` : 'system', customer: customer.id, capability: 'website', resource: { type: 'website_import', id: importId }, outcome: 'success', details: { fields: chosen.length - rejected.length, photos: added.length, rejected: rejected.length, failedPhotos: failed.length, fixes: fixIds.length } })
  return { ok: true, applied: chosen.filter((f) => !rejected.some((r) => r.field === f)), rejected, photosAdded: added.length, photosFailed: failed.map((f) => f.reason) }
}
