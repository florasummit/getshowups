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

// Every photo something recoverable shows: the draft, the live version, any saved (published) version, an AI designer
// turn Undo can bring back, or a draft checkpoint. Each is read as content (usedBy), so a photo merely named in a copy
// map (content.variants) without being shown doesn't count.
export async function photosInUse(db, customerId) {
  const used = new Set()
  const add = (content) => {
    for (const id of usedBy(content)) used.add(id)
  }
  const parse = (v) => {
    try {
      return typeof v === 'string' ? JSON.parse(v) : v
    } catch {
      return null
    }
  }
  const w = await db.prepare('SELECT draft FROM websites WHERE customer = ?1').bind(customerId).first()
  if (w) add(parse(w.draft))
  add((await liveContent(db, customerId))?.content)
  const versions = await db.prepare('SELECT content FROM website_versions WHERE customer = ?1').bind(customerId).all()
  for (const v of versions.results) add(parse(v.content))
  const kept = await db
    .prepare("SELECT json_extract(content, '$.site') AS site, json_extract(content, '$.previous') AS previous, json_extract(content, '$.draft') AS draft FROM website_generations WHERE customer = ?1 AND json_extract(content, '$.kind') IN ('designer', 'checkpoint')")
    .bind(customerId)
    .all()
  for (const r of kept.results) {
    add({ site: parse(r.site) })
    add({ site: parse(r.previous) })
    add(parse(r.draft))
  }
  return used
}

// Removes one of the business's photos, only if nothing recoverable still shows it. Returns { ok } or { error: 'in_use' }.
export async function deleteAsset(db, customerId, id, inUse = null) {
  if (!/^[a-f0-9]{32}$/.test(String(id))) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const row = await db.prepare('SELECT id FROM website_assets WHERE id = ?1 AND customer = ?2').bind(id, customerId).first()
  if (!row) return { ok: false, httpStatus: 404, error: 'not_found' }
  if ((inUse || (await photosInUse(db, customerId))).has(id)) return { ok: false, httpStatus: 409, error: 'in_use' }
  await db.prepare('DELETE FROM website_assets WHERE id = ?1 AND customer = ?2').bind(id, customerId).run()
  return { ok: true }
}

// Removes every photo of this business that nothing recoverable uses. Returns { removed, kept, bytesFreed }.
export async function cleanupAssets(db, customerId) {
  const inUse = await photosInUse(db, customerId)
  const { results } = await db.prepare('SELECT id, size FROM website_assets WHERE customer = ?1').bind(customerId).all()
  let removed = 0
  let bytesFreed = 0
  for (const a of results) {
    if (inUse.has(a.id)) continue
    await db.prepare('DELETE FROM website_assets WHERE id = ?1 AND customer = ?2').bind(a.id, customerId).run()
    removed++
    bytesFreed += a.size || 0
  }
  return { removed, kept: results.length - removed, bytesFreed }
}

// logo: true for an image that is or was the business's logo (photo pickers leave it out; server/website.js).
export async function listAssets(db, customerId) {
  const [{ results }, logos] = await Promise.all([
    db.prepare('SELECT id, size, created_at FROM website_assets WHERE customer = ?1 ORDER BY created_at DESC').bind(customerId).all(),
    logoAssetIdsFor(db, customerId),
  ])
  return results.map((r) => ({ id: r.id, url: `/site-assets/${r.id}`, size: r.size, createdAt: r.created_at, ...(logos.has(r.id) ? { logo: true } : {}) }))
}

// D1 may return a BLOB as an ArrayBuffer, a typed array or a plain number array.
export const blobBytes = (v) => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : Uint8Array.from(v || []))

// Photos a piece of content shows, including the phone-sized copies of the ones it uses (content.variants).
export const usedBy = (content) => {
  const used = new Set([content?.logo, content?.hero, ...(content?.photos || []), ...specImages(content?.site)].filter(Boolean))
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
