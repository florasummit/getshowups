// How fast inquiries were handled (the Results scorecard): first of a message sent to them or a booking. Same cohort rule
// as the funnel (inquiries created in the period, test records excluded). Phone calls aren't recorded, so "unanswered"
// means nothing recorded. The median needs MIN cases; null otherwise.
import { isTestLead } from './testdata.js'
export const MIN = 5
export async function responseTime(db, customerId, { days = 30, internal = '[]', now = Date.now() } = {}) {
  const { results } = await db
    .prepare(
      `SELECT l.created_at AS at, l.id AS id,
              (SELECT min(m.created_at) FROM thread_messages m WHERE m.customer = l.customer AND m.lead_id = l.id AND m.direction = 'out' AND m.channel <> 'note' AND m.status IN ('sent','delivered')) AS sent,
              (SELECT min(a.created_at) FROM appointments a WHERE a.customer = l.customer AND a.lead_id = l.id AND a.status <> 'pending') AS booked
         FROM leads l WHERE l.customer = ?1 AND l.created_at >= ?2 AND l.created_at <= ?4 AND NOT ${isTestLead('l', '?3')} ORDER BY l.created_at DESC LIMIT 2000`,
    )
    .bind(customerId, now - days * 86_400_000, internal, now)
    .all()
  // A caller the owner added themselves (server/ads/calls.js) was spoken to; how fast isn't recorded.
  const rows = results.filter((r) => !r.id.startsWith('gcall_'))
  const took = rows.map((r) => Math.min(r.sent ?? Infinity, r.booked ?? Infinity) - r.at).filter(Number.isFinite).map((ms) => Math.max(0, Math.round(ms / 60_000))).sort((a, b) => a - b)
  const half = Math.floor(took.length / 2)
  return { inquiries: rows.length, handled: took.length, noneRecorded: rows.length - took.length, medianMinutes: took.length < MIN ? null : took.length % 2 ? took[half] : Math.round((took[half - 1] + took[half]) / 2), slowestMinutes: took.length < MIN ? null : took.at(-1), min: MIN }
}

// Recorded AI cost of the dashboard assistant and receptionist for this business (estimates from token counts, USD micros).
export async function aiCost(db, customerId, { days = 30, now = Date.now() } = {}) {
  const since = now - days * 86_400_000
  const [a, r] = await Promise.all([
    db.prepare("SELECT count(*) AS n, coalesce(sum(json_extract(props, '$.costMicros')), 0) AS c FROM events WHERE type = 'ai_ask' AND customer = ?1 AND at >= ?2").bind(customerId, since).first(),
    db.prepare('SELECT count(*) AS n, coalesce(sum(cost_micros), 0) AS c FROM receptionist_conversations WHERE customer = ?1 AND created_at >= ?2').bind(customerId, since).first(),
  ])
  return { assistantQuestions: Number(a.n), assistantMicros: Number(a.c), conversations: Number(r.n), receptionistMicros: Number(r.c) }
}
