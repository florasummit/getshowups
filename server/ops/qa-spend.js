// QA settings + QA spending (paid evaluations only; everything else QA runs is free). Reuses the one spending guard
// (server/ai-budget.js): a paid evaluation reserves its WORST-CASE cost before dispatch through reserveAi with entry
// 'qa_eval' (booked on the 'getshowups' platform record, so the platform-wide daily ceiling and the AI off switches
// apply too), whose daily ceiling is qa_settings.eval_daily_micros (default 0 = refused). A monthly ceiling
// (eval_monthly_micros, default 0) is checked against what QA results recorded this month plus open reservations.
// Paid runs also need QA_PAID_EVALS === 'true' (Cloudflare variable) AND the paid_evals setting = 1. Default: all off.
import { reserveAi, settleReservation } from '../ai-budget.js'

export const QA_BUSINESS = 'getshowups'
export const SETTINGS = {
  eval_daily_micros: { def: 0, max: 5_000_000 }, //   QA evaluations per UTC day (≤ $5)
  eval_monthly_micros: { def: 0, max: 10_000_000 }, // QA evaluations per calendar month (UTC, ≤ $10)
  paid_evals: { def: 0, max: 1 }, //                  1 = paid evaluations may be requested (still needs QA_PAID_EVALS)
  evidence_days: { def: 90, max: 365 }, //            screenshots kept this many days (records are kept)
  schedule_production: { def: 0, max: 1 }, //         1 = verify production once a day automatically (free)
}
const MIN = { evidence_days: 7 }

export async function qaSettings(db) {
  const values = Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.def]))
  const changed = {}
  try {
    const { results } = await db.prepare('SELECT key, value, updated_by, updated_at FROM qa_settings').all()
    for (const r of results) if (SETTINGS[r.key] && Number.isInteger(r.value) && r.value >= 0 && r.value <= SETTINGS[r.key].max) {
      values[r.key] = r.value
      changed[r.key] = { by: r.updated_by, at: r.updated_at }
    }
  } catch {
    // Before 0051 or unreadable: the defaults (everything paid stays off).
  }
  return { values, changed, max: Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.max])) }
}

export async function setQaSetting(db, key, value, by, now = Date.now()) {
  if (!SETTINGS[key]) return { error: 'invalid_setting' }
  const v = Number(value)
  if (!Number.isInteger(v) || v < (MIN[key] ?? 0) || v > SETTINGS[key].max) return { error: 'invalid_value' }
  const before = (await qaSettings(db)).values[key]
  await db.prepare('INSERT INTO qa_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_by = ?3, updated_at = ?4').bind(key, v, by, now).run()
  return { ok: true, before, after: v }
}

// The entry's daily ceiling for ai-budget (async: read at reservation time).
export const evalDailyMicros = async (env) => (await qaSettings(env.ONBOARDING_DB)).values.eval_daily_micros

const DAY = 86_400_000
const monthKey = (now) => `aib:qamonth:${new Date(now).toISOString().slice(0, 7).replace('-', '')}`
const monthStart = (now) => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
export async function spend(env, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const s = (await qaSettings(db)).values
  const from = monthStart(now)
  const [spent, reserved] = await Promise.all([
    db.prepare('SELECT coalesce(sum(cost_micros), 0) AS m FROM qa_test_results WHERE at >= ?1 AND cost_micros > 0').bind(from).first().catch(() => ({ m: 0 })),
    db.prepare("SELECT coalesce(sum(reserved_micros), 0) AS m FROM qa_executions WHERE reserved_at >= ?1 AND reserved_micros > 0 AND cost_micros IS NULL AND status IN ('queued', 'dispatched', 'running', 'expired')").bind(from).first().catch(() => ({ m: 0 })),
  ])
  const reasons = paidBlockers(env, s)
  const budget = s.eval_monthly_micros
  return { month: new Date(now).toISOString().slice(0, 7), spentMicros: Number(spent?.m || 0), reservedMicros: Number(reserved?.m || 0), budgetMicros: budget, dailyMicros: s.eval_daily_micros, availableMicros: Math.max(0, budget - Number(spent?.m || 0) - Number(reserved?.m || 0)), paidEnabled: reasons.length === 0, paidReasons: reasons }
}
export function paidBlockers(env, s) {
  const r = []
  if (env.QA_PAID_EVALS !== 'true') r.push("QA_PAID_EVALS is not 'true'")
  if (s.paid_evals !== 1) r.push('Paid evaluations are off in QA settings')
  if (!(s.eval_daily_micros > 0)) r.push('The daily QA evaluation budget is $0')
  if (!(s.eval_monthly_micros > 0)) r.push('The monthly QA evaluation budget is $0')
  return r
}

// Reserve a paid execution's worst case. → { ok: true, reserved, at } | { ok: false, reason, text }
export async function reserveQa(env, micros, now = Date.now()) {
  const amount = Math.max(0, Math.ceil(Number(micros) || 0))
  if (!amount) return { ok: true, reserved: 0, at: null }
  const s = (await qaSettings(env.ONBOARDING_DB)).values
  const blockers = paidBlockers(env, s)
  if (blockers.length) return { ok: false, reason: 'paid_off', text: blockers.join('; ') }
  // Month first, atomically (one conditional UPDATE on its counter: concurrent requests can't pass it together).
  const db = env.ONBOARDING_DB
  const key = monthKey(now)
  let ok
  try {
    await db.prepare('INSERT OR IGNORE INTO rate_limits (key, win, count, expires_at) VALUES (?1, ?2, 0, ?3)').bind(key, monthStart(now), now + 40 * DAY).run()
    ok = await db.prepare('UPDATE rate_limits SET count = count + ?2 WHERE key = ?1 AND count + ?2 <= ?3 RETURNING count').bind(key, amount, s.eval_monthly_micros).first()
  } catch {
    return { ok: false, reason: 'budget_unavailable', text: 'The spending guard is unavailable (nothing was reserved).' }
  }
  if (!ok) {
    const m = await spend(env, now)
    return { ok: false, reason: 'budget_month', text: `The monthly QA budget has $${(m.availableMicros / 1e6).toFixed(2)} left; this run may cost up to $${(amount / 1e6).toFixed(2)}.` }
  }
  const r = await reserveAi(env, { entry: 'qa_eval', customerId: QA_BUSINESS, micros: amount, now })
  if (!r.ok) await monthAdjust(db, key, -amount)
  if (!r.ok) return { ok: false, reason: `budget_${r.reason}`, text: r.reason === 'entry' ? 'The daily QA evaluation budget would be exceeded.' : r.reason === 'ai_off' ? 'GetShowUps-paid AI is switched off.' : r.reason === 'platform' ? 'The platform-wide daily AI ceiling would be exceeded.' : 'The spending guard is unavailable (nothing was reserved).' }
  return { ok: true, reserved: r.reserved, at: now }
}
// The provider-reported cost replaces the reservation on the reservation's day and month (never below 0).
export async function settleQa(env, { reserved, at, actual }) {
  if (!(reserved > 0 && at)) return
  const diff = Math.max(0, Math.ceil(Number(actual) || 0)) - reserved
  await settleReservation(env, { entry: 'qa_eval', customerId: QA_BUSINESS, at, reserved, actual })
  if (diff) await monthAdjust(env.ONBOARDING_DB, monthKey(at), diff)
}
const monthAdjust = (db, key, diff) => db.prepare('UPDATE rate_limits SET count = max(0, count + ?2) WHERE key = ?1').bind(key, diff).run().catch(() => null)
