// The synthetic records of the test business, put back to their starting state. Fixed ids (acc-…), fictional people,
// addresses that cannot receive mail (.invalid), no calendar events, no messages scheduled. Dated hours back, so the owner
// notices (last two hours only) never see them; call backs are marked held for the same reason.
import { json } from './google-oauth.js'
import { stillAllowed } from './acceptance-env.js'

const H = 3_600_000
const D = 24 * H
export async function resetFixture({ env, grant }, now = Date.now()) {
  if (!(await stillAllowed(env))) return json(403, { error: 'not_allowed' })
  const db = env.ONBOARDING_DB
  const c = grant.customer
  const at = (days) => Math.floor((now + days * D) / D) * D + 15 * H + 7 * 60_000 // a minute nobody can book
  const lead = (id, name, need, ago, status, zip = '29401') =>
    db.prepare("INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'x', ?9, ?9) ON CONFLICT(id) DO UPDATE SET status = ?8, need = ?6, created_at = ?9 WHERE leads.customer = ?2").bind(`acc-${id}`, c, name, `acc-${id}@acceptance.invalid`, '+15555550100', need, zip, status, now - ago)
  const thread = (id, sent, needs = null) =>
    db.prepare("INSERT INTO lead_threads (lead_id, customer, source, stage, needs_owner, last_outbound_at, created_at, updated_at) VALUES (?1, ?2, 'other', 'new', ?3, ?4, ?5, ?5) ON CONFLICT(lead_id) DO UPDATE SET needs_owner = ?3, last_outbound_at = ?4 WHERE lead_threads.customer = ?2").bind(`acc-${id}`, c, needs, sent, now - D)
  const appt = (id, start, status) =>
    db.prepare("INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ON CONFLICT(id) DO UPDATE SET start_at = ?4, end_at = ?5, status = ?6 WHERE appointments.customer = ?2").bind(`acc-a-${id}`, c, `acc-${id}`, start, start + H, status, now - 5 * D)
  const call = (id, kind, name, text, hours, urgent) => [
    db.prepare("INSERT INTO receptionist_conversations (id, customer, channel, turns, created_at, updated_at) VALUES (?1, ?2, 'chat', 2, ?3, ?3) ON CONFLICT(id) DO UPDATE SET updated_at = ?3 WHERE receptionist_conversations.customer = ?2").bind(`acc-c-${id}`, c, now - hours * H),
    db.prepare("INSERT INTO receptionist_requests (id, customer, conversation_id, kind, name, phone, note, urgent, status, held, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, '+15555550101', ?6, ?7, 'open', 1, ?8, ?8) ON CONFLICT(id) DO UPDATE SET status = 'open', held = 1, note = ?6, urgent = ?7, created_at = ?8, resolved_at = NULL WHERE receptionist_requests.customer = ?2").bind(`acc-r-${id}`, c, `acc-c-${id}`, kind, name, text, urgent, now - hours * H),
  ]
  await db.batch([
    ...call('vera', 'callback', 'Vera Synthetic', 'Needs 2 filters for a 15x30 pool, please call after 4pm', 5, 1),
    ...call('walt', 'message', 'Walt Synthetic', 'Gate code changed, see the fence', 9, 0),
    lead('iris', 'Iris Synthetic', 'Weekly care', 3 * D, 'new'),
    thread('iris', null),
    lead('owen', 'Owen Synthetic', 'Wants to know about mulch', 2 * D, 'new'),
    thread('owen', now - D, 'needs_reply'),
    lead('kai', 'Kai Synthetic', 'Filter cleaning', 8 * D, 'booked'),
    appt('kai', at(-2), 'booked'),
    lead('lia', 'Lia Synthetic', 'Heater check', 4 * D, 'booked'),
    appt('lia', at(2), 'booked'),
  ])
  return json(200, { ok: true, people: ['Vera Synthetic', 'Walt Synthetic', 'Iris Synthetic', 'Owen Synthetic', 'Kai Synthetic', 'Lia Synthetic'] })
}
