// Permanent audit log and standard operational events (migration 0015). One mechanism for both:
//   recordEvent()       the standard way any feature records something consequential (or a failure / retry outcome)
//   appendAudit()       same, older call style (actorType/actor/action) — kept for existing callers
//   verifyAuditChain()  recomputes every hash; reports the first entry that doesn't match
//   auditCheckpoint()   cron, once a day: verifies the chain and records the result as an entry
//
// Every entry: sequence, time, actor (type + id), action, business, capability, resource (type + id), outcome
// (success | failure | info), correlation id, details. Append-only (SQLite triggers) and hash-chained.
//
// Minimal personal data, by construction:
//   - email addresses anywhere become ref:<sha256 prefix> (one-way; the same address gives the same ref);
//   - free text (anything that isn't a short identifier, code, number or boolean) becomes text:<sha256 prefix>,
//     so names, notes and reasons never enter the permanent log (the readable text stays in the deletable tables);
//   - staff (platform admin) emails stay readable: they are the accountable actors.
// Limitations of the tamper evidence: see docs/AUDIT.md (someone with full database write access could rewrite the
// whole chain; the daily checkpoint + exports are the defence).
import { sha256Hex, randomToken } from './google-oauth.js'

export const GENESIS = '0'.repeat(64)
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const ID_RE = /^[A-Za-z0-9_.:/+@-]{1,80}$/ // identifiers and codes: kept as is
const ACTOR_TYPES = ['admin', 'owner', 'system', 'stripe', 'customer']
const OUTCOMES = ['success', 'failure', 'info']

export const emailRef = async (email) => `ref:${(await sha256Hex(`audit:${String(email).trim().toLowerCase()}`)).slice(0, 20)}`
const textRef = async (text) => `text:${(await sha256Hex(`audit-text:${text}`)).slice(0, 16)}`
export const newCorrelationId = (prefix = 'op') => `${prefix}_${randomToken(9)}`

async function scrubString(value) {
  let out = value
  for (const m of new Set(value.match(EMAIL_RE) || [])) out = out.split(m).join(await emailRef(m))
  return ID_RE.test(out) ? out : textRef(value)
}
async function scrub(value) {
  if (typeof value === 'string') return scrubString(value)
  if (Array.isArray(value)) return Promise.all(value.slice(0, 50).map(scrub))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = await scrub(v)
    return out
  }
  return value ?? null
}
const clip = (v, n = 80) => (v === null || v === undefined ? null : String(v).slice(0, n))

// Stable JSON (sorted keys) so the hash doesn't depend on property order.
const canonical = (v) =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v)

const FIELDS = ['seq', 'at', 'actor_type', 'actor', 'action', 'customer', 'capability', 'resource_type', 'resource_id', 'outcome', 'correlation_id', 'details']
const entryHash = (prev, e) => sha256Hex(`${prev}\n${canonical(FIELDS.map((f) => e[f] ?? null))}`)

// The standard event. type: '<area>.<verb>' (e.g. ads.pause, billing.payment_failed). Never throws.
export async function recordEvent(db, { type, actor = 'system', actorType = null, customer = null, capability = null, resource = null, outcome = 'info', correlationId = null, details = {}, at = Date.now() }) {
  try {
    const kind = actorType ?? (/^owner:/.test(actor) ? 'owner' : /^admin:/.test(actor) ? 'admin' : actor === 'stripe' ? 'stripe' : 'system')
    if (!ACTOR_TYPES.includes(kind)) throw new Error('bad actor type')
    if (!OUTCOMES.includes(outcome)) throw new Error('bad outcome')
    const raw = kind === 'admin' ? String(actor).replace(/^admin:/, '').toLowerCase().slice(0, 200) : String(actor || kind)
    const who = kind === 'admin' ? raw : await scrubString(raw).then((s) => (s.startsWith('text:') ? kind : s))
    const body = JSON.stringify(await scrub(details || {}))
    for (let attempt = 0; attempt < 25; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5 * attempt)))
      const head = await db.prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1').first()
      const e = {
        seq: (head?.seq ?? 0) + 1,
        at,
        actor_type: kind,
        actor: who,
        action: clip(type),
        customer: clip(customer, 64),
        capability: clip(capability, 64),
        resource_type: clip(resource?.type, 40),
        resource_id: resource?.id ? await scrubString(String(resource.id)) : null,
        outcome,
        correlation_id: clip(correlationId),
        details: body,
      }
      const prev = head?.hash ?? GENESIS
      const hash = await entryHash(prev, e)
      try {
        await db
          .prepare(
            'INSERT INTO audit_log (seq, at, actor_type, actor, action, customer, capability, resource_type, resource_id, outcome, correlation_id, details, prev_hash, hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)',
          )
          .bind(e.seq, e.at, e.actor_type, e.actor, e.action, e.customer, e.capability, e.resource_type, e.resource_id, e.outcome, e.correlation_id, e.details, prev, hash)
          .run()
        return { ok: true, seq: e.seq }
      } catch (err) {
        if (!/UNIQUE|PRIMARY KEY|constraint/i.test(err?.message || '')) throw err // another writer took this seq: retry
      }
    }
    throw new Error('contention')
  } catch (err) {
    const code = err?.message?.includes('no such table') ? 'table_missing' : err?.message === 'contention' ? 'contention' : 'storage_error'
    console.error('audit log not written:', type, code)
    return { ok: false, error: code }
  }
}

// Older call style; maps onto recordEvent.
export const appendAudit = (db, { actorType, actor, action, customer = null, details = {}, at = Date.now(), ...rest }) =>
  recordEvent(db, { type: action, actorType, actor, customer, details, at, ...rest })

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
    await recordEvent(db, {
      type: 'audit.checkpoint',
      actor: 'system:audit',
      capability: 'platform.audit',
      outcome: v.ok ? 'success' : 'failure',
      details: v.ok ? { ok: true, headSeq: v.headSeq, headHash: v.headHash } : { ok: false, brokenAt: v.brokenAt, reason: v.reason },
      at: now,
    })
    return v
  } catch (err) {
    console.error('audit checkpoint failed:', err?.message?.includes('no such table') ? 'table_missing' : 'storage_error')
    return { ok: false, error: 'storage_error' }
  }
}

const toEntry = (r) => ({
  seq: r.seq,
  at: r.at,
  actorType: r.actor_type,
  actor: r.actor,
  action: r.action,
  customer: r.customer,
  capability: r.capability,
  resource: r.resource_type ? { type: r.resource_type, id: r.resource_id } : null,
  outcome: r.outcome,
  correlationId: r.correlation_id,
  details: JSON.parse(r.details),
  hash: r.hash,
})

export async function listAudit(db, { customer = null, capability = null, correlationId = null, outcome = null, beforeSeq = null, limit = 100 } = {}) {
  const lim = Math.min(Math.max(1, limit | 0), 500)
  const { results } = await db
    .prepare(
      `SELECT * FROM audit_log WHERE (?1 IS NULL OR customer = ?1) AND (?2 IS NULL OR seq < ?2) AND (?3 IS NULL OR capability = ?3)
         AND (?4 IS NULL OR correlation_id = ?4) AND (?5 IS NULL OR outcome = ?5) ORDER BY seq DESC LIMIT ?6`,
    )
    .bind(customer, beforeSeq, capability, correlationId, outcome, lim)
    .all()
  return results.map(toEntry)
}
