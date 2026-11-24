// What is waiting for the owner, from the records. ONE definition: the Overview card ("Needs your attention") and the
// dashboard assistant (server/app-state.js) both read it, so they can't disagree. Test records are left out. A part that
// can't be read is null and the card says so: unreadable never means "nobody is waiting".
import { internalEmails, isTestLead } from './testdata.js'

const DAY = 86_400_000
export const NEEDS_OWNER = { human_requested: 'asked for a person', ai_unsure: 'the automatic assistant was not sure how to answer', ai_fallback: 'got a standard reply only', ai_limit: 'asked many questions in one day', needs_reply: 'wrote and waits for a written reply', cancel_request: 'wants to cancel' }

const REQUEST = `SELECT r.id, r.kind, r.name, r.phone, r.email, r.note, r.urgent, r.status, r.created_at, r.resolved_at, c.lead_id
  FROM receptionist_requests r LEFT JOIN receptionist_conversations c ON c.id = r.conversation_id AND c.customer = r.customer`
export const openRequests = async (db, customerId) => (await db.prepare(`${REQUEST} WHERE r.customer = ?1 AND r.status = 'open' ORDER BY r.urgent DESC, r.created_at LIMIT 100`).bind(customerId).all()).results
export const requestById = (db, customerId, id) => db.prepare(`${REQUEST} WHERE r.customer = ?1 AND r.id = ?2`).bind(customerId, id).first()
export const findRequests = async (db, customerId, like) => (await db.prepare(`${REQUEST} WHERE r.customer = ?1 AND r.name LIKE ?2 ORDER BY r.created_at DESC LIMIT 200`).bind(customerId, like).all()).results

// The owner dealt with a call-back request or message (Receptionist page and an approved assistant proposal).
export async function resolveRequest(db, customerId, id, now = Date.now()) {
  const r = await db.prepare("UPDATE receptionist_requests SET status = 'resolved', resolved_at = ?3, updated_at = ?3 WHERE id = ?1 AND customer = ?2 AND status = 'open'").bind(id, customerId, now).run()
  return r?.meta?.changes > 0
}

// An inquiry nothing was ever sent to and that never booked (leads l, lead_threads t). Every use of "unanswered" is this one.
export const UNANSWERED = "l.status = 'new' AND t.last_outbound_at IS NULL AND NOT EXISTS (SELECT 1 FROM appointments x WHERE x.lead_id = l.id AND x.customer = l.customer AND x.status IN ('booked','showed','no_show'))"

const n = (x) => Number(x) || 0
// → { callbacks, messages, replies, unbooked, coverage, outcomes } each { total, urgent? } | null
export async function attention(env, customerId, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const internal = internalEmails(env)
  const one = (sql, ...a) => db.prepare(sql).bind(customerId, ...a).first().catch(() => null)
  const [req, replies, unbooked, coverage, outcomes] = await Promise.all([
    one("SELECT coalesce(sum(kind = 'callback'), 0) AS c, coalesce(sum(kind = 'callback' AND urgent), 0) AS cu, coalesce(sum(kind = 'message'), 0) AS m, coalesce(sum(kind = 'message' AND urgent), 0) AS mu FROM receptionist_requests WHERE customer = ?1 AND status = 'open'"),
    one(`SELECT count(*) AS n FROM lead_threads t JOIN leads l ON l.id = t.lead_id AND l.customer = t.customer WHERE t.customer = ?1 AND t.needs_owner IS NOT NULL AND NOT ${isTestLead('l', '?2')}`, internal),
    one(`SELECT count(*) AS n FROM leads l WHERE l.customer = ?1 AND l.status = 'new' AND l.created_at >= ?2 AND NOT ${isTestLead('l', '?3')}`, now - 30 * DAY, internal),
    one(`SELECT count(*) AS n FROM coverage_requests r JOIN leads l ON l.id = r.lead_id AND l.customer = r.customer WHERE r.customer = ?1 AND r.status = 'pending' AND NOT ${isTestLead('l', '?2')}`, internal),
    one(`SELECT count(*) AS n FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE a.customer = ?1 AND a.status = 'booked' AND a.start_at <= ?2 AND NOT ${isTestLead('l', '?3')}`, now, internal),
  ])
  return {
    readAt: now,
    callbacks: req && { total: n(req.c), urgent: n(req.cu) },
    messages: req && { total: n(req.m), urgent: n(req.mu) },
    replies: replies && { total: n(replies.n) },
    unbooked: unbooked && { total: n(unbooked.n) },
    coverage: coverage && { total: n(coverage.n) },
    outcomes: outcomes && { total: n(outcomes.n) },
  }
}

const CARDS = [
  ['callbacks', 'Callback', (k) => `${k} ${k === 1 ? 'customer is' : 'customers are'} waiting for a call back`, 'Open receptionist', 'receptionist'],
  ['messages', 'Message', (k) => `${k} ${k === 1 ? 'customer left' : 'customers left'} you a message`, 'Open receptionist', 'receptionist'],
  ['replies', 'Reply', (k) => `${k} ${k === 1 ? 'conversation needs' : 'conversations need'} you`, 'Open follow-ups', 'followups'],
  ['unbooked', 'Follow up', (k) => `${k} ${k === 1 ? 'person asked but hasn’t' : 'people asked but haven’t'} booked yet`, 'Review', 'appointments'],
  ['coverage', 'Your area', (k) => `${k} ${k === 1 ? 'request' : 'requests'} from outside your area ${k === 1 ? 'waits' : 'wait'} for your answer`, 'Review', 'appointments'],
]
// The card's lines, most urgent first, exactly as shown. unread: parts that couldn't be read.
export function attentionCard(a) {
  const items = CARDS.filter(([id]) => a[id]?.total).map(([id, tag, text, label, page]) => ({ id, total: a[id].total, urgent: !!a[id].urgent, tag: a[id].urgent ? 'Urgent' : tag, text: text(a[id].total), label, page }))
  return { items: items.sort((x, y) => y.urgent - x.urgent), unread: CARDS.filter(([id]) => a[id] === null).map(([id]) => id) }
}
