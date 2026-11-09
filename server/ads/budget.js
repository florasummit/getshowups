// Spending guardrails. The owner's latest unrevoked approval is the hard ceiling for the combined
// daily budgets of all approved/launching/active campaigns. Nothing automated can raise it.
import { randomToken } from '../google-oauth.js'
import { dailyCeilingCents } from './spec.js'

export async function currentApproval(db, customer) {
  return db
    .prepare('SELECT * FROM ad_budget_approvals WHERE customer = ?1 AND revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1')
    .bind(customer)
    .first()
}

// Owner action only (requires a signed-in owner session at the route).
export async function approveBudget(db, customer, monthlyCents, ownerEmail, now = Date.now()) {
  if (!Number.isInteger(monthlyCents) || monthlyCents < 15000 || monthlyCents > 5000000) return { ok: false, error: 'invalid_budget' } // $150–$50,000/mo
  const id = randomToken(12)
  await db.batch([
    db.prepare('UPDATE ad_budget_approvals SET revoked_at = ?2 WHERE customer = ?1 AND revoked_at IS NULL').bind(customer, now),
    db.prepare('INSERT INTO ad_budget_approvals (id, customer, monthly_cents, approved_by, approved_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, customer, monthlyCents, ownerEmail, now),
  ])
  return { ok: true, id, monthlyCents, dailyCeilingCents: dailyCeilingCents(monthlyCents) }
}

// Sum of daily budgets already committed (approved, launching, active) except `excludeId`.
export async function committedDailyCents(db, customer, excludeId = '') {
  const row = await db
    .prepare("SELECT coalesce(sum(daily_budget_cents), 0) AS n FROM ad_campaigns WHERE customer = ?1 AND status IN ('approved', 'launching', 'active') AND id <> ?2")
    .bind(customer, excludeId)
    .first()
  return row?.n ?? 0
}

// How much daily budget a campaign may still use under the current approval (0 when none).
export async function remainingDailyCents(db, customer, excludeId = '') {
  const approval = await currentApproval(db, customer)
  if (!approval) return 0
  return Math.max(0, dailyCeilingCents(approval.monthly_cents) - (await committedDailyCents(db, customer, excludeId)))
}
