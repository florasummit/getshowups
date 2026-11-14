// One controller per conversation (migration 0017). Before an automation provider (Claude, OpenAI, a voice provider,
// GoHighLevel workflows, …) replies or acts in a conversation, it must hold control; a person taking over always wins.
//   acquireControl  provider: only if nobody holds it, its own lease, or the previous provider's lease expired
//                   human: always (takes it from any provider; held until released)
//   releaseControl  only by the current controller
//   currentController
// Every change is a standard event (capability conversations.control). Tenant-scoped: (customer, conversation) only.
import { recordEvent } from '../auditlog.js'

export const DEFAULT_LEASE_MS = 10 * 60 * 1000
const CONTROLLER_RE = /^(human|provider:[a-z][a-z0-9_-]{1,30})$/
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/

export async function currentController(db, customer, conversationId, now = Date.now()) {
  const r = await db.prepare('SELECT controller, since, lease_until, version FROM conversation_control WHERE customer = ?1 AND conversation_id = ?2').bind(customer, conversationId).first()
  if (!r) return null
  if (r.lease_until !== null && r.lease_until <= now) return null // a provider's lease ran out: nobody controls it
  return { controller: r.controller, since: r.since, leaseUntil: r.lease_until, version: r.version }
}

export async function acquireControl(db, { customer, conversationId, controller, leaseMs = DEFAULT_LEASE_MS, now = Date.now() }) {
  if (!CONTROLLER_RE.test(controller || '') || !ID_RE.test(conversationId || '') || !customer) return { ok: false, error: 'invalid_request' }
  const human = controller === 'human'
  const lease = human ? null : now + Math.min(Math.max(leaseMs, 1000), 60 * 60 * 1000)
  // Atomic: insert, or take over when allowed. A provider can't take control from a human or from another provider
  // whose lease is still running; a human always can.
  const r = await db
    .prepare(
      `INSERT INTO conversation_control (customer, conversation_id, controller, since, lease_until, version) VALUES (?1, ?2, ?3, ?4, ?5, 1)
       ON CONFLICT(customer, conversation_id) DO UPDATE SET
         controller = excluded.controller,
         since = CASE WHEN conversation_control.controller = excluded.controller THEN conversation_control.since ELSE excluded.since END,
         lease_until = excluded.lease_until,
         version = conversation_control.version + 1
       WHERE ?6 = 1
          OR conversation_control.controller = excluded.controller
          OR (conversation_control.lease_until IS NOT NULL AND conversation_control.lease_until <= ?4)
       RETURNING controller, version`,
    )
    .bind(customer, conversationId, controller, now, lease, human ? 1 : 0)
    .first()
  if (!r) {
    const holder = await currentController(db, customer, conversationId, now)
    return { ok: false, error: 'controlled_by_other', controller: holder?.controller ?? null }
  }
  await recordEvent(db, { type: 'conversation.control_acquired', actor: human ? 'system:human_takeover' : `system:${controller}`, customer, capability: 'conversations.control', resource: { type: 'conversation', id: conversationId }, outcome: 'success', details: { controller, lease: lease ? lease - now : null }, at: now })
  return { ok: true, controller, version: r.version, leaseUntil: lease }
}

export async function releaseControl(db, { customer, conversationId, controller, now = Date.now() }) {
  const r = await db.prepare('DELETE FROM conversation_control WHERE customer = ?1 AND conversation_id = ?2 AND controller = ?3 RETURNING controller').bind(customer, conversationId, controller).first()
  if (!r) return { ok: false, error: 'not_controller' }
  await recordEvent(db, { type: 'conversation.control_released', actor: `system:${controller === 'human' ? 'human' : controller}`, customer, capability: 'conversations.control', resource: { type: 'conversation', id: conversationId }, outcome: 'success', details: { controller }, at: now })
  return { ok: true }
}
