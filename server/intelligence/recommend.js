// Improvement suggestions from this business's OWN recent conversations (last 30 days), counts only: outcomes and the
// receptionist's coded events (receptionist_events / receptionist_conversations). Nothing is read across businesses,
// no transcript text is used, and nothing is applied: each suggestion carries a ready-made "Teach a Change" request the
// owner can review like any other change. A minimum sample (MIN) avoids reacting to one odd conversation.
const MIN = 3
const WINDOW_MS = 30 * 86_400_000

export async function recommendations(db, customerId, config, records, now = Date.now()) {
  const since = now - WINDOW_MS
  const out = []
  let outcomes = []
  let events = []
  try {
    outcomes = (await db.prepare('SELECT outcome, count(*) AS n FROM receptionist_conversations WHERE customer = ?1 AND updated_at >= ?2 AND turns > 0 GROUP BY outcome').bind(customerId, since).all()).results
    events = (await db.prepare("SELECT kind, detail, count(*) AS n FROM receptionist_events WHERE customer = ?1 AND at >= ?2 AND kind IN ('rules', 'blocked_price', 'check_service_area', 'request_coverage', 'find_available_times', 'save_customer_details') GROUP BY kind, detail").bind(customerId, since).all()).results
  } catch {
    return []
  }
  const n = (o) => Number(outcomes.find((r) => r.outcome === o)?.n || 0)
  const ev = (kind, detail) => events.filter((e) => e.kind === kind && (detail === undefined || String(e.detail || '').startsWith(detail))).reduce((s, e) => s + Number(e.n), 0)
  const total = outcomes.reduce((s, r) => s + Number(r.n), 0)

  const urgent = n('callback_urgent') + n('handoff_urgent')
  if (urgent >= MIN && !config.emergency.triggers.length)
    out.push({ id: 'emergency', text: `${urgent} customers needed something urgently in the last 30 days, and you haven’t listed urgent situations yet.`, teach: 'Treat no heat, no cooling and water leaking as urgent.', count: urgent })
  const outside = n('out_of_area') + n('coverage_request')
  if (outside >= MIN && (records.zips || []).length && !config.coverage.cityWide.length && (records.towns || []).length)
    out.push({ id: 'coverage', text: `${outside} customers were outside your ZIP code list. If you serve whole towns, marking them saves those callers a ZIP question.`, teach: `We serve all of ${records.towns[0]}.`, count: outside })
  const prices = ev('blocked_price')
  if (prices >= MIN && config.pricing === 'listed')
    out.push({ id: 'pricing', text: `${prices} times a customer asked about a price that isn’t in your services. Consider how you want price questions answered.`, teach: 'Prices are confirmed after the visit.', count: prices })
  const cityFirst = ev('rules', 'city_first')
  if (cityFirst >= MIN && !config.coverage.cityWide.length)
    out.push({ id: 'city_first', text: `${cityFirst} callers gave their town before being asked. If you serve those towns completely, the AI can skip the ZIP question.`, teach: `We serve all of ${(records.towns || [])[0] || 'our main town'}.`, count: cityFirst })
  const multi = ev('rules', 'multi')
  if (multi >= MIN) out.push({ id: 'multi', text: `${multi} times a customer gave several details at once; your AI used them without asking again.`, teach: null, count: multi, info: true })
  const recheck = events.filter((e) => e.kind === 'save_customer_details' && e.detail === 'recheck').reduce((s, e) => s + Number(e.n), 0)
  if (recheck >= MIN && total) out.push({ id: 'recheck', text: `${recheck} details (a phone number or ZIP) had to be checked again. That’s normal on calls; no change needed unless it keeps growing.`, teach: null, count: recheck, info: true })
  return out
}
