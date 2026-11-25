// Booking page measurement (events table, type 'booking_stage'): one row per page visit and stage, deduplicated by id
// (bk:<visit>:<stage>), so a reload or retry never double counts. Props are codes only: stage, device class, traffic
// source code, service id. No name, email, phone, ZIP, address, IP or user agent is ever stored. The visit id is a
// random per-page-load value that is not kept in the browser.
// Completed bookings in the funnel come from this page's own 'booked' stage; the business's booked appointments of
// record stay in appointments (server/ads/funnel.js). Conversion here = booking-page visits that ended booked.
export const STAGES = ['view', 'service', 'time', 'details', 'booked', 'requested']
const VISIT_RE = /^[a-z0-9]{12,32}$/
const CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/
const SERVICE_RE = /^sv_[a-z0-9]{3,20}$/

// Request body → [error, event]
export function validateStage(body) {
  const stage = body?.stage
  if (!STAGES.includes(stage)) return ['invalid_stage']
  if (!VISIT_RE.test(String(body?.visit || ''))) return ['invalid_visit']
  const device = body?.device === 'mobile' ? 'mobile' : 'desktop'
  const source = CODE_RE.test(String(body?.source || '')) ? String(body.source).toLowerCase() : 'direct'
  const service = SERVICE_RE.test(String(body?.service || '')) ? body.service : null
  return [null, { stage, visit: body.visit, device, source, service }]
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null)

// Counts for one business since `since` (ms). null rates when there were no visits (shown as unavailable, never 0%).
export async function bookingFunnel(db, customerId, since) {
  const { results } = await db
    .prepare("SELECT json_extract(props, '$.stage') AS stage, json_extract(props, '$.device') AS device, json_extract(props, '$.source') AS source, count(*) AS n FROM events WHERE type = 'booking_stage' AND customer = ?1 AND at >= ?2 GROUP BY 1, 2, 3")
    .bind(customerId, since)
    .all()
  const stages = Object.fromEntries(STAGES.map((s) => [s, 0]))
  const device = { mobile: { view: 0, booked: 0 }, desktop: { view: 0, booked: 0 } }
  const sources = new Map()
  for (const r of results) {
    if (!STAGES.includes(r.stage)) continue
    stages[r.stage] += r.n
    const d = device[r.device === 'mobile' ? 'mobile' : 'desktop']
    if (r.stage === 'view' || r.stage === 'booked') d[r.stage] += r.n
    const src = sources.get(r.source) || { source: r.source || 'direct', view: 0, booked: 0, requested: 0 }
    if (r.stage in src) src[r.stage] += r.n
    sources.set(r.source, src)
  }
  const completed = stages.booked + stages.requested
  return {
    stages,
    // Visits that left at each step without going further (by stage counts; a visit counts once per stage).
    abandoned: { beforeService: Math.max(0, stages.view - stages.service), beforeTime: Math.max(0, stages.service - stages.time), beforeDetails: Math.max(0, stages.time - stages.details), atDetails: Math.max(0, stages.details - completed) },
    conversion: pct(completed, stages.view),
    device: Object.fromEntries(Object.entries(device).map(([k, v]) => [k, { ...v, conversion: pct(v.booked, v.view) }])),
    sources: [...sources.values()].sort((a, b) => b.view - a.view).slice(0, 10).map((s) => ({ ...s, conversion: pct(s.booked + s.requested, s.view) })),
  }
}
