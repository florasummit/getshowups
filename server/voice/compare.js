// Provider comparison and budgets for the Voice Lab (docs/RECEPTIONIST.md "Cost controls"): the three providers side
// by side from SESSION RECORDS of the last 30 days (customer sessions, admin tests on the customer path and Lab calls
// alike), never from a click: connection reliability, how far the booking tools got, response latency as the
// adapters measured it, minutes, estimated cost (labelled) and VERIFIED charges (the provider's own numbers, when
// fetched; server/voice/charges.js). Counts, numbers and codes only: no transcript, no customer detail.
import { PROVIDERS, COST_ESTIMATES, labDailyMinutes } from './providers.js'
import { businessMinutesToday, providerMinutesToday, voiceDailyMinutes } from './customer.js'
import { labMinutesToday } from './sessions.js'
import { budgetState, providerDailyLimit, testDailyMinutes, testMinutesToday } from './budgets.js'
import { isTestBusinessSql } from '../testbusiness.js'

const DAY = 864e5
const FAIL_OUTCOMES = new Set(['connect_failed', 'reconnect_failed', 'connection_lost', 'disconnected', 'microphone', 'no_microphone', 'connect_timeout', 'provider_refused', 'closed_before_start', 'socket_closed', 'socket_error', 'payload_too_large', 'provider_error', 'provider_closed', 'page_closed', 'rate_limited', 'sdp_failed'])
const failed = (v) => FAIL_OUTCOMES.has(v.outcome) || Boolean(v.disconnect)
const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null
}
const per = (micros, n) => (micros == null || !n ? null : Math.round(micros / n))

// → { days, providers: [{ id, sessions, finished, connectionFailures, failureRate, audioBothWays, availability,
//      bookings, bookingRate, firstResponseMs, medianResponseMs, minutes, estimatedMicros, estimate, verified: { sessions,
//      micros, credits }, costPerSession: { estimatedMicros, verifiedMicros }, costPerBooking: { estimatedMicros,
//      verifiedMicros } }], incomplete: [{ id, customer, provider, kind, endedAt, reason }], counts: { connectionFailures, incompleteBookings } }
export async function providerComparison(env, { now = Date.now(), days = 30, incompleteLimit = 12 } = {}) {
  let rows = []
  try {
    const r = await env.ONBOARDING_DB.prepare("SELECT id, customer, state FROM receptionist_conversations WHERE created_at > ?1 AND (json_extract(state, '$.voice.provider') IS NOT NULL OR json_extract(state, '$.lab.provider') IS NOT NULL) ORDER BY created_at DESC LIMIT 2000").bind(now - days * DAY).all()
    rows = r.results || []
  } catch {
    return { days, providers: PROVIDERS.map((id) => ({ id, unavailable: true })), incomplete: [], counts: { connectionFailures: null, incompleteBookings: null }, unavailable: true }
  }
  const acc = Object.fromEntries(PROVIDERS.map((id) => [id, { id, sessions: 0, finished: 0, connectionFailures: 0, audioBothWays: 0, availability: 0, bookings: 0, first: [], med: [], minutes: 0, estimatedMicros: 0, estimated: 0, verifiedSessions: 0, verifiedMicros: 0, verifiedCredits: 0, verifiedUsdSessions: 0 }]))
  const incomplete = []
  const counts = { connectionFailures: 0, incompleteBookings: 0 }
  for (const row of rows) {
    let s
    try {
      s = JSON.parse(row.state || '{}')
    } catch {
      continue
    }
    const v = s.voice?.provider ? s.voice : s.lab?.provider ? s.lab : null
    if (!v || !acc[v.provider]) continue
    const a = acc[v.provider]
    const kind = s.lab?.provider ? 'lab' : v.test ? 'test' : 'customer'
    a.sessions += 1
    if (!v.endedAt) continue
    a.finished += 1
    const m = v.metrics || {}
    const tools = s.tools || []
    const availability = tools.some((t) => t.name === 'find_available_times' && t.ok)
    const booked = tools.some((t) => t.name === 'book_appointment' && t.ok)
    const conn = failed(v)
    if (conn) a.connectionFailures += 1
    if (m.micLive === 1 && m.audioReceived === 1) a.audioBothWays += 1
    if (availability) a.availability += 1
    if (booked) a.bookings += 1
    if (Number.isFinite(m.firstResponseMs)) a.first.push(m.firstResponseMs)
    if (Number.isFinite(m.medianResponseMs)) a.med.push(m.medianResponseMs)
    a.minutes += (Number(m.durationSeconds) || 0) / 60
    if (Number.isFinite(v.estimatedMicros)) {
      a.estimatedMicros += v.estimatedMicros
      a.estimated += 1
    }
    const c = v.charge
    if (c && (c.micros != null || c.credits != null)) {
      a.verifiedSessions += 1
      if (c.micros != null) {
        a.verifiedMicros += c.micros
        a.verifiedUsdSessions += 1
      }
      if (c.credits != null) a.verifiedCredits += c.credits
    }
    // Visible without clutter: what did not get to a booking, with the reason as a code.
    const reason = conn ? `connection:${v.disconnect?.code || v.outcome || 'failed'}` : !tools.length ? 'no_tools' : !availability ? 'no_availability' : !booked ? 'no_booking' : null
    if (reason) {
      if (conn) counts.connectionFailures += 1
      else counts.incompleteBookings += 1
      if (incomplete.length < incompleteLimit) incomplete.push({ id: row.id, customer: row.customer, provider: v.provider, kind, endedAt: v.endedAt, durationSeconds: m.durationSeconds ?? null, reason, closeCode: v.disconnect?.closeCode ?? null })
    }
  }
  const providers = PROVIDERS.map((id) => {
    const a = acc[id]
    const est = COST_ESTIMATES[id]?.perMinuteMicros ? a.estimatedMicros : null
    const ver = a.verifiedUsdSessions ? a.verifiedMicros : null
    return {
      id,
      sessions: a.sessions,
      finished: a.finished,
      connectionFailures: a.connectionFailures,
      failureRate: a.finished ? Math.round((a.connectionFailures / a.finished) * 100) / 100 : null,
      audioBothWays: a.audioBothWays,
      availability: a.availability,
      bookings: a.bookings,
      bookingRate: a.availability ? Math.round((a.bookings / a.availability) * 100) / 100 : null,
      firstResponseMs: median(a.first),
      medianResponseMs: median(a.med),
      latencySessions: a.med.length,
      minutes: Math.round(a.minutes * 10) / 10,
      estimatedMicros: est,
      estimate: COST_ESTIMATES[id]?.perMinuteMicros ? { perMinuteMicros: COST_ESTIMATES[id].perMinuteMicros, source: COST_ESTIMATES[id].source, asOf: COST_ESTIMATES[id].asOf } : null,
      verified: { sessions: a.verifiedSessions, micros: ver, usdSessions: a.verifiedUsdSessions, credits: a.verifiedCredits || null },
      costPerSession: { estimatedMicros: per(est, a.finished), verifiedMicros: per(ver, a.verifiedUsdSessions) },
      costPerBooking: { estimatedMicros: per(est, a.bookings), verifiedMicros: a.verifiedUsdSessions && a.verifiedUsdSessions === a.finished ? per(ver, a.bookings) : null },
    }
  })
  return { days, providers, incomplete, counts }
}

// Today's budgets, every one of them a limit that refuses a start at its ceiling: per provider (platform-wide), the Lab,
// and per test business (admin tests + Lab calls). → { providers: [...], lab, testBusinesses: [...], warnings: [codes] }
export async function budgetOverview(env, now = Date.now()) {
  const providers = []
  for (const id of PROVIDERS) {
    const limit = providerDailyLimit(env, id)
    const used = await providerMinutesToday(env, id, now)
    providers.push({ id, ...budgetState(used, limit), switch: `VOICE_PROVIDER_DAILY_MINUTES_${id.toUpperCase()}` })
  }
  const lab = { ...budgetState(await labMinutesToday(env, now), labDailyMinutes(env)), switch: 'VOICE_LAB_DAILY_MINUTES' }
  let rows = []
  try {
    const r = await env.ONBOARDING_DB.prepare(`SELECT id, name FROM customers WHERE ${isTestBusinessSql('id')} AND status = 'active' ORDER BY name LIMIT 20`).all()
    rows = r.results || []
  } catch {
    rows = []
  }
  const testLimit = testDailyMinutes(env)
  const testBusinesses = []
  for (const r of rows) testBusinesses.push({ id: r.id, name: r.name, ...budgetState(await testMinutesToday(env, r.id, now), testLimit), business: budgetState(await businessMinutesToday(env, r.id, now), voiceDailyMinutes(env)), switch: 'VOICE_TEST_DAILY_MINUTES' })
  const warnings = [...providers.filter((p) => p.state === 'warn' || p.state === 'exhausted').map((p) => `provider:${p.id}:${p.state}`), ...(lab.state === 'warn' || lab.state === 'exhausted' ? [`lab:${lab.state}`] : []), ...testBusinesses.filter((b) => b.state === 'warn' || b.state === 'exhausted').map((b) => `test:${b.id}:${b.state}`)]
  return { providers, lab, testBusinesses, warnings }
}
