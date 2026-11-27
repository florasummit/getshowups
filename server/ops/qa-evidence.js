// QA evidence (migration 0051 qa_evidence): what supports a result or an item. Everything is redacted on write: tokens,
// keys, emails, phone numbers, bearer headers, secret-looking query parameters. Text ≤ 8 KB; screenshots ≤ 1 MB, byte-
// sniffed PNG/JPEG/WebP (the declared type is ignored); links https only. Screenshots expire after the QA setting
// evidence_days (default 90): the cron clears the bytes and keeps the row (purged_at), so the record stays.
// AI assessments are evidence of kind 'ai_assessment', always labelled, never a result.
import { randomToken, sha256Hex } from '../google-oauth.js'
import { redact } from './qa.js'
import { qaSettings } from './qa-spend.js'

const DAY = 86_400_000
export const MAX_TEXT = 8192
export const MAX_IMAGE = 1_000_000
export const KINDS = ['screenshot', 'log', 'transcript', 'link', 'record', 'ai_assessment']

const SECRETS = [
  [/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\n]+/gi, '$1: [redacted]'],
  [/\b(sk|rk|pk|whsec|ghp|gho|ghs|github_pat|xox[abprs]|sk-ant|sk-proj)[-_][A-Za-z0-9_-]{6,}/g, '[secret]'],
  [/([?&](?:token|key|secret|code|sig|signature|password|access_token|api_key)=)[^&\s"']+/gi, '$1[redacted]'],
  [/\b(password|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"',;]{4,}/gi, '$1=[redacted]'],
  [/__Host-[A-Za-z_]+=[^;\s]+/g, '[cookie]'],
]
export function redactEvidence(s, max = MAX_TEXT) {
  let t = String(s ?? '')
  for (const [re, to] of SECRETS) t = t.replace(re, to)
  return redact(t, max)
}

export function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}
const fromBase64 = (b64) => {
  const bin = atob(String(b64).replace(/^data:[^,]*,/, '').replace(/\s/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// → { evidence } | { error }
export async function addEvidence(db, { ownerKind, ownerId, kind, text = null, url = null, dataBase64 = null, by }, now = Date.now()) {
  if (!['result', 'item'].includes(ownerKind) || !/^q[ri]_[A-Za-z0-9_-]{6,40}$/.test(String(ownerId || ''))) return { error: 'invalid_owner' }
  if (!KINDS.includes(kind)) return { error: 'invalid_kind' }
  const table = ownerKind === 'result' ? 'qa_test_results' : 'qa_items'
  if (!(await db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?1`).bind(ownerId).first())) return { error: 'not_found' }
  let mime = null
  let body = null
  let data = null
  let bytes = 0
  let expires = null
  if (kind === 'screenshot') {
    let raw
    try {
      raw = fromBase64(dataBase64 || '')
    } catch {
      return { error: 'invalid_image' }
    }
    if (!raw.length) return { error: 'invalid_image' }
    if (raw.length > MAX_IMAGE) return { error: 'too_large' }
    mime = sniffImage(raw)
    if (!mime) return { error: 'invalid_image' }
    bytes = raw.length
    let s = ''
    for (let i = 0; i < raw.length; i += 0x8000) s += String.fromCharCode(...raw.subarray(i, i + 0x8000))
    data = btoa(s)
    expires = now + (await qaSettings(db)).values.evidence_days * DAY
  } else if (kind === 'link') {
    const u = String(url || text || '').trim()
    if (!/^https:\/\/[^\s<>"']{3,500}$/.test(u)) return { error: 'invalid_url' }
    body = redactEvidence(u, 600)
    mime = 'text/uri-list'
    bytes = body.length
  } else {
    body = redactEvidence(text, MAX_TEXT).trim()
    if (!body) return { error: 'text_required' }
    mime = 'text/plain'
    bytes = body.length
  }
  const id = `qe_${randomToken(9)}`
  const hash = data ? await sha256Hex(data) : await sha256Hex(body)
  await db
    .prepare('INSERT INTO qa_evidence (id, owner_kind, owner_id, kind, mime, text, data, bytes, sha256, created_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)')
    .bind(id, ownerKind, ownerId, kind, mime, body, data, bytes, hash, by, now, expires)
    .run()
  return { evidence: present({ id, owner_kind: ownerKind, owner_id: ownerId, kind, mime, text: body, bytes, created_at: now, expires_at: expires, purged_at: null }) }
}

export const present = (r) => ({
  id: r.id,
  ownerKind: r.owner_kind,
  ownerId: r.owner_id,
  kind: r.kind,
  mime: r.mime,
  text: r.kind === 'screenshot' ? null : r.text,
  bytes: r.bytes,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  purged: Boolean(r.purged_at),
  ...(r.kind === 'screenshot' ? { url: `/api/platform/qa/evidence/${r.id}` } : {}),
  ...(r.kind === 'ai_assessment' ? { label: 'AI assessment (not a verified result)' } : {}),
})

export async function evidenceFor(db, ownerKind, ids) {
  const list = [...new Set(ids)].filter(Boolean).slice(0, 200)
  if (!list.length) return []
  const { results } = await db.prepare(`SELECT id, owner_kind, owner_id, kind, mime, text, bytes, created_at, expires_at, purged_at FROM qa_evidence WHERE owner_kind = ?1 AND owner_id IN (${list.map((_, i) => `?${i + 2}`).join(', ')}) ORDER BY created_at`).bind(ownerKind, ...list).all()
  return results.map(present)
}

export async function getEvidence(db, id) {
  if (!/^qe_[A-Za-z0-9_-]{6,40}$/.test(String(id || ''))) return null
  return db.prepare('SELECT * FROM qa_evidence WHERE id = ?1').bind(id).first()
}

// Retention: clear expired screenshot bytes (bounded per run); the row and its hash stay.
export async function purgeEvidence(db, now = Date.now(), limit = 200) {
  const r = await db.prepare('UPDATE qa_evidence SET data = NULL, purged_at = ?1 WHERE id IN (SELECT id FROM qa_evidence WHERE expires_at IS NOT NULL AND expires_at < ?1 AND purged_at IS NULL LIMIT ?2)').bind(now, limit).run()
  return { purged: r?.meta?.changes ?? 0 }
}
