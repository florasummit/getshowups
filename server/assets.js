// Website images (logo and photos). The browser resizes before upload; the server accepts only real
// JPEG/PNG/WebP files (checked by their bytes, never by the declared type; no SVG), within size and
// count limits. Stored per business; served only when published or to the business's own owner.
import { liveContent } from './website.js'
import { specImages } from './site-spec.js'

// Media policy (Website Studio, 2026-11-16): photos only (no hosted video), resized in the browser to ≤1600 px before
// upload (a phone original up to 10 MB is refused in the browser, never stored), ≤1 MB each after resizing, at most
// MAX_ASSETS photos and MAX_TOTAL_BYTES per website. Stored in D1 (the existing store; no new paid service): its 2 MB
// row limit and 10 GB database cap are why the per-website budget is 50 MB, not the 250 MB proposed for R2. Moving
// photos to R2 (Cloudflare, needs a bucket binding = production change with approval) would allow a larger budget.
export const MAX_BYTES = 1_000_000
export const MAX_ASSETS = 60
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

// Removes one of the business's photos, only if nothing recoverable still shows it: the draft, the live version, any
// saved (published) version, or an AI designer turn that Undo can bring back. Returns { ok } or { error: 'in_use' }.
export async function deleteAsset(db, customerId, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id))) return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const row = await db.prepare('SELECT id FROM website_assets WHERE id = ?1 AND customer = ?2').bind(id, customerId).first()
  if (!row) return { ok: false, httpStatus: 404, error: 'not_found' }
  const w = await db.prepare('SELECT draft FROM websites WHERE customer = ?1').bind(customerId).first()
  if (w && usedBy(JSON.parse(w.draft || '{}')).has(id)) return { ok: false, httpStatus: 409, error: 'in_use' }
  if (usedBy((await liveContent(db, customerId))?.content).has(id)) return { ok: false, httpStatus: 409, error: 'in_use' }
  const versions = await db.prepare('SELECT 1 AS x FROM website_versions WHERE customer = ?1 AND instr(content, ?2) > 0 LIMIT 1').bind(customerId, id).first()
  const turns = await db.prepare("SELECT 1 AS x FROM website_generations WHERE customer = ?1 AND json_extract(content, '$.kind') = 'designer' AND instr(content, ?2) > 0 LIMIT 1").bind(customerId, id).first()
  if (versions || turns) return { ok: false, httpStatus: 409, error: 'in_use' }
  await db.prepare('DELETE FROM website_assets WHERE id = ?1 AND customer = ?2').bind(id, customerId).run()
  return { ok: true }
}

export async function listAssets(db, customerId) {
  const { results } = await db.prepare('SELECT id, size, created_at FROM website_assets WHERE customer = ?1 ORDER BY created_at DESC').bind(customerId).all()
  return results.map((r) => ({ id: r.id, url: `/site-assets/${r.id}`, size: r.size, createdAt: r.created_at }))
}

// D1 may return a BLOB as an ArrayBuffer, a typed array or a plain number array.
export const blobBytes = (v) => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : Uint8Array.from(v || []))

export const usedBy = (content) => new Set([content?.logo, content?.hero, ...(content?.photos || []), ...specImages(content?.site)].filter(Boolean))

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
