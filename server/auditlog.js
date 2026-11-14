// Permanent audit log (migration 0015): append-only, hash-chained, no personal data.
//   appendAudit()       one entry; never throws (an audit failure must not undo or fail a completed action)
//   verifyAuditChain()  recomputes every hash; reports the first entry that doesn't match
//   auditCheckpoint()   cron, once a day: verifies the chain and records the result as an entry
// Personal data never enters: email addresses anywhere in actor/details become ref:<sha256 prefix>
// (one-way; the same address always gives the same ref, so entries about one person can still be linked).
// Staff (platform admin) emails stay readable: they are the accountable actors.
import { sha256Hex } from './google-oauth.js'

export const GENESIS = '0'.repeat(64)
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const ACTOR_TYPES = ['admin', 'owner', 'system', 'stripe', 'customer']

export const emailRef = async (email) => `ref:${(await sha256Hex(`audit:${String(email).trim().toLowerCase()}`)).slice(0, 20)}`

async function scrub(value) {
  if (typeof value === 'string') {
    let out = value
    for (const m of new Set(value.match(EMAIL_RE) || [])) out = out.split(m).join(await emailRef(m))
    return out.slice(0, 500)
  }
  if (Array.isArray(value)) return Promise.all(value.slice(0, 50).map(scrub))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = await scrub(v)
    return out
  }
  return value ?? null
}

// Stable JSON (sorted keys) so the hash doesn't depend on property order.
const canonical = (v) =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v)

const entryHash = (prev, e) => sha256Hex(`${prev}\n${canonical([e.seq, e.at, e.actor_type, e.actor, e.action, e.customer ?? null, e.details])}`)

// actorType 'admin' keeps the staff email; every other actor is scrubbed (owner:<email> → owner:ref:…).
export async function appendAudit(db, { actorType, actor, action, customer = null, details = {}, at = Date.now() }) {
  try {
    if (!ACTOR_TYPES.includes(actorType)) throw new Error('bad actor type')
    const who = actorType === 'admin' ? String(actor).toLowerCase().slice(0, 200) : await scrub(String(actor || actorType))
    const body = JSON.stringify(await scrub(details || {}))
    for (let attempt = 0; attempt < 25; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5 * attempt)))
      const head = await db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').first()
      const e = { seq: (head?.seq ?? 0) + 1, at, actor_type: actorType, actor: who, action: String(action).slice(0, 80), customer, details: body }
      const prev = head?.hash ?? GENESIS
      const hash = await entryHash(prev, e)
      try {
        await db
          .prepare('INSERT INTO audit_log (seq, at, actor_type, actor, action, customer, details, prev_hash, hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
          .bind(e.seq, e.at, e.actor_type, e.actor, e.action, e.customer, e.details, prev, hash)
          .run()
        return { ok: true, seq: e.seq }
      } catch (err) {
        if (!/UNIQUE|PRIMARY KEY|constraint/i.test(err?.message || '')) throw err // another writer took this seq: retry
      }
    }
    throw new Error('contention')
  } catch (err) {
    const code = err?.message?.includes('no such table') ? 'table_missing' : err?.message === 'contention' ? 'contention' : 'storage_error'
    console.error('audit log not written:', action, code)
    return { ok: false, error: code }
  }
}

// Recomputes the chain from the start (or from fromSeq, trusting the entry before it). Read-only.
export async function verifyAuditChain(db, { fromSeq = 1, pageSize = 500 } = {}) {
  let prev = GENESIS
  if (fromSeq > 1) {
    const before = await db.prepare('SELECT hash FROM audit_log WHERE seq = ?1').bind(fromSeq - 1).first()
    if (!before) return { ok: false, checked: 0, brokenAt: fromSeq - 1, reason: 'missing' }
    prev = before.hash
  }
  let expected = fromSeq
  let checked = 0
  for (;;) {
    const { results } = await db.prepare('SELECT * FROM audit_log WHERE seq >= ?1 ORDER BY seq LIMIT ?2').bind(expected, pageSize).all()
    if (!results.length) break
    for (const e of results) {
      if (e.seq !== expected) return { ok: false, checked, brokenAt: expected, reason: 'missing' }
      if (e.prev_hash !== prev) return { ok: false, checked, brokenAt: e.seq, reason: 'chain' }
      if ((await entryHash(prev, e)) !== e.hash) return { ok: false, checked, brokenAt: e.seq, reason: 'altered' }
      prev = e.hash
      expected++
      checked++
    }
  }
  return { ok: true, checked, headSeq: expected - 1, headHash: prev }
}

// Cron: at most once a day, verify the whole chain and record the result (an alarm if it is broken).
export async function auditCheckpoint(db, now = Date.now()) {
  try {
    const last = await db.prepare("SELECT at FROM audit_log WHERE action = 'audit.checkpoint' ORDER BY seq DESC LIMIT 1").first()
    if (last && now - last.at < 86400000) return { skipped: true }
    const v = await verifyAuditChain(db)
    if (!v.ok) console.error('audit log chain broken at', v.brokenAt, v.reason)
    await appendAudit(db, { actorType: 'system', actor: 'system:audit', action: 'audit.checkpoint', details: v.ok ? { ok: true, headSeq: v.headSeq, headHash: v.headHash } : { ok: false, brokenAt: v.brokenAt, reason: v.reason }, at: now })
    return v
  } catch (err) {
    console.error('audit checkpoint failed:', err?.message?.includes('no such table') ? 'table_missing' : 'storage_error')
    return { ok: false, error: 'storage_error' }
  }
}

export async function listAudit(db, { customer = null, beforeSeq = null, limit = 100 } = {}) {
  const lim = Math.min(Math.max(1, limit | 0), 500)
  const { results } = await db
    .prepare(
      `SELECT seq, at, actor_type, actor, action, customer, details, hash FROM audit_log WHERE (?1 IS NULL OR customer = ?1) AND (?2 IS NULL OR seq < ?2) ORDER BY seq DESC LIMIT ?3`,
    )
    .bind(customer, beforeSeq, lim)
    .all()
  return results.map((r) => ({ seq: r.seq, at: r.at, actorType: r.actor_type, actor: r.actor, action: r.action, customer: r.customer, details: JSON.parse(r.details), hash: r.hash }))
}
