// Website images (logo and photos). The browser resizes before upload; the server accepts only real
// JPEG/PNG/WebP files (checked by their bytes, never by the declared type; no SVG), within size and
// count limits. Stored per business; served only when published or to the business's own owner.
import { liveContent, logoAssetIdsFor } from './website.js'
import { specImages } from './site-spec.js'

// Media policy (Website Studio, 2026-11-16): photos only (no hosted video), resized in the browser to ≤1600 px before
// upload (a phone original up to 10 MB is refused in the browser, never stored), ≤1 MB each after resizing, at most
// MAX_ASSETS photos and MAX_TOTAL_BYTES per website. Stored in D1 (the existing store; no new paid service): its 2 MB
// row limit and 10 GB database cap are why the per-website budget is 50 MB, not the 250 MB proposed for R2. Moving
// photos to R2 (Cloudflare, needs a bucket binding = production change with approval) would allow a larger budget.
export const MAX_BYTES = 1_000_000
// 120 files: each photo may have a phone-sized copy (≤800 px, ~60–120 KB) next to it.
export const MAX_ASSETS = 120
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024

export function sniffImage(bytes) {
  const b = bytes
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

export async function saveAsset(db, customerId, bytes, now = Date.now()) {
  if (!bytes.length) return { ok: false, httpStatus: 400, error: 'empty' }
  if (bytes.length > MAX_BYTES) return { ok: false, httpStatus: 413, error: 'too_large' }
  const type = sniffImage(bytes)
  if (!type) return { ok: false, httpStatus: 415, error: 'unsupported_type' }
  const count = await db.prepare('SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM website_assets WHERE customer = ?1').bind(customerId).first()
  if ((count?.n ?? 0) >= MAX_ASSETS) return { ok: false, httpStatus: 409, error: 'too_many' }
  if ((count?.bytes ?? 0) + bytes.length > MAX_TOTAL_BYTES) return { ok: false, httpStatus: 409, error: 'quota' }
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('')
  await db.prepare('INSERT INTO website_assets (id, customer, content_type, bytes, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, customerId, type, bytes, bytes.length, now).run()
  return { ok: true, asset: { id, url: `/site-assets/${id}`, size: bytes.length } }
}

const parseJson = (v) => {
  try {
    return typeof v === 'string' ? JSON.parse(v) : v
  } catch {
    return null
  }
}

// Where each photo is used, per business: { [id]: { draft, live, versions, history, logo } }.
//   draft     the private draft shows it
//   live      the version visitors see shows it
//   versions  how many saved (published) versions show it (each can be restored)
//   history   an AI-designer turn Undo can bring back, or a draft checkpoint, shows it
//   logo      it is or was the business's logo (current draft or any saved version)
// Each is read as content (usedBy), so a photo merely named in a copy map (content.variants) without being shown
// doesn't count; a phone-sized copy counts wherever its photo does.
export async function photoUsage(db, customerId) {
  const usage = new Map()
  const at = (id) => usage.get(id) || (usage.set(id, { draft: false, live: false, versions: 0, history: false, logo: false }), usage.get(id))
  const w = await db.prepare('SELECT draft, live_version FROM websites WHERE customer = ?1').bind(customerId).first()
  const draft = w ? parseJson(w.draft) : null
  for (const id of usedBy(draft)) at(id).draft = true
  if (typeof draft?.logo === 'string') at(draft.logo).logo = true
  for (const id of usedBy((await liveContent(db, customerId))?.content)) at(id).live = true
  const versions = await db.prepare('SELECT content FROM website_versions WHERE customer = ?1').bind(customerId).all()
  for (const v of versions.results) {
    const c = parseJson(v.content)
    for (const id of usedBy(c)) at(id).versions++
    if (typeof c?.logo === 'string') at(c.logo).logo = true
  }
  const kept = await db
    .prepare("SELECT json_extract(content, '$.site') AS site, json_extract(content, '$.previous') AS previous, json_extract(content, '$.draft') AS draft FROM website_generations WHERE customer = ?1 AND json_extract(content, '$.kind') IN ('designer', 'checkpoint')")
    .bind(customerId)
    .all()
  for (const r of kept.results) for (const c of [{ site: parseJson(r.site) }, { site: parseJson(r.previous) }, parseJson(r.draft)]) for (const id of usedBy(c)) at(id).history = true
  return usage
}

// Every photo something recoverable shows: the draft, the live version, any saved (published) version, an AI designer
// turn Undo can bring back, or a draft checkpoint.
export async function photosInUse(db, customerId) {
  return new Set((await photoUsage(db, customerId)).keys())
}

// Hidden photos (migration 0030): kept (something recoverable may still show them) but out of the photo list and every
// picker. Fails soft: before 0030 is applied nothing is hidden.
async function hiddenIds(db, customerId) {
  try {
    const { results } = await db.prepare('SELECT asset FROM website_asset_hidden WHERE customer = ?1').bind(customerId).all()
    return new Set(results.map((r) => r.asset))
  } catch {
    return new Set()
  }
}
const ownRow = (db, customerId, id) => db.prepare('SELECT id FROM website_assets WHERE id = ?1 AND customer = ?2').bind(id, customerId).first()
const forget = async (db, customerId, id) => {
  await db.prepare('DELETE FROM website_assets WHERE id = ?1 AND customer = ?2').bind(id, customerId).run()
  await db.prepare('DELETE FROM website_asset_hidden WHERE asset = ?1 AND customer = ?2').bind(id, customerId).run().catch(() => {})
}

// Removes one of the business's photos, only if nothing recoverable still shows it. Its phone-sized copy (named in the
// draft's content.variants) goes with it when nothing else shows that copy. Returns { ok, removed } or
// { error: 'in_use', usage } (where it is used, so the owner can be told).
export async function deleteAsset(db, customerId, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id))) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  if (!(await ownRow(db, customerId, id))) return { ok: false, httpStatus: 404, error: 'not_found' }
  const usage = await photoUsage(db, customerId)
  if (usage.has(id)) return { ok: false, httpStatus: 409, error: 'in_use', usage: usage.get(id) }
  const removed = [id]
  await forget(db, customerId, id)
  const w = await db.prepare('SELECT draft FROM websites WHERE customer = ?1').bind(customerId).first()
  const copy = parseJson(w?.draft)?.variants?.[id]
  if (typeof copy === 'string' && /^[a-f0-9]{32}$/.test(copy) && !usage.has(copy) && (await ownRow(db, customerId, copy))) {
    await forget(db, customerId, copy)
    removed.push(copy)
  }
  return { ok: true, removed }
}

// Hide / show again. Hiding is for a photo the draft and the live website don't show (only saved versions, AI undo or
// draft checkpoints do): its bytes stay, so a restore still shows it. { error: 'in_draft' | 'live' } otherwise.
export async function hideAsset(db, customerId, id, hidden = true, now = Date.now()) {
  if (!/^[a-f0-9]{32}$/.test(String(id))) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  if (!(await ownRow(db, customerId, id))) return { ok: false, httpStatus: 404, error: 'not_found' }
  try {
    if (!hidden) {
      await db.prepare('DELETE FROM website_asset_hidden WHERE asset = ?1 AND customer = ?2').bind(id, customerId).run()
      return { ok: true }
    }
    const u = (await photoUsage(db, customerId)).get(id)
    if (u?.live) return { ok: false, httpStatus: 409, error: 'live', usage: u }
    if (u?.draft) return { ok: false, httpStatus: 409, error: 'in_draft', usage: u }
    await db.prepare('INSERT INTO website_asset_hidden (asset, customer, hidden_at) VALUES (?1, ?2, ?3) ON CONFLICT (asset) DO NOTHING').bind(id, customerId, now).run()
    return { ok: true }
  } catch (err) {
    if (/no such table/i.test(String(err?.message))) return { ok: false, httpStatus: 503, error: 'not_available' }
    throw err
  }
}

// Removes every photo of this business that nothing recoverable uses. Returns { removed, kept, bytesFreed }.
export async function cleanupAssets(db, customerId) {
  const inUse = await photosInUse(db, customerId)
  const { results } = await db.prepare('SELECT id, size FROM website_assets WHERE customer = ?1').bind(customerId).all()
  let removed = 0
  let bytesFreed = 0
  for (const a of results) {
    if (inUse.has(a.id)) continue
    await forget(db, customerId, a.id)
    removed++
    bytesFreed += a.size || 0
  }
  return { removed, kept: results.length - removed, bytesFreed }
}

// logo: true for an image that is or was the business's logo (photo pickers leave it out; server/website.js).
// Hidden photos are left out unless { hidden: true } (then marked hidden: true). { usage: true } adds where each is used.
export async function listAssets(db, customerId, { hidden: withHidden = false, usage: withUsage = false } = {}) {
  const [{ results }, logos, hidden, usage] = await Promise.all([
    db.prepare('SELECT id, size, created_at FROM website_assets WHERE customer = ?1 ORDER BY created_at DESC').bind(customerId).all(),
    logoAssetIdsFor(db, customerId),
    hiddenIds(db, customerId),
    withUsage ? photoUsage(db, customerId) : null,
  ])
  return results
    .filter((r) => withHidden || !hidden.has(r.id))
    .map((r) => ({
      id: r.id,
      url: `/site-assets/${r.id}`,
      size: r.size,
      createdAt: r.created_at,
      ...(logos.has(r.id) ? { logo: true } : {}),
      ...(hidden.has(r.id) ? { hidden: true } : {}),
      ...(usage ? { usage: usage.get(r.id) || null } : {}),
    }))
}

// D1 may return a BLOB as an ArrayBuffer, a typed array or a plain number array.
export const blobBytes = (v) => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : Uint8Array.from(v || []))

// Photos a piece of content shows, including the phone-sized copies of the ones it uses (content.variants).
// content.design (older AI design format) may place an owner photo as its hero/About image (asset:<id>): it counts too
// (it used to be missed, so such a photo could be removed while a version still showed it).
const designImages = (d) => [d?.heroImage, d?.aboutImage].filter((r) => typeof r === 'string' && r.startsWith('asset:')).map((r) => r.slice(6))
export const usedBy = (content) => {
  const used = new Set([content?.logo, content?.hero, ...(content?.photos || []), ...designImages(content?.design), ...specImages(content?.site)].filter((v) => typeof v === 'string' && v))
  for (const [id, small] of Object.entries(content?.variants || {})) if (used.has(id)) used.add(small)
  return used
}

// Returns the asset row if `viewerCustomer` owns it, or if its business's live site uses it.
export async function readAsset(db, id, viewerCustomer = null) {
  if (!/^[a-f0-9]{32}$/.test(id)) return null
  const a = await db.prepare('SELECT * FROM website_assets WHERE id = ?1').bind(id).first()
  if (!a) return null
  a.bytes = blobBytes(a.bytes)
  if (viewerCustomer && viewerCustomer === a.customer) return { asset: a, published: false }
  const live = await liveContent(db, a.customer)
  return live && usedBy(live.content).has(id) ? { asset: a, published: true } : null
}

const toBase64 = (bytes) => {
  let s = ''
  const u = blobBytes(bytes)
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}

// Customer-owned content export (portability): website text, business details and uploaded images.
export async function exportAssets(db, customerId) {
  const { results } = await db.prepare('SELECT id, content_type, bytes FROM website_assets WHERE customer = ?1').bind(customerId).all()
  return results.map((r) => ({ id: r.id, contentType: r.content_type, base64: toBase64(r.bytes) }))
}
