// Test businesses (admin-marked, audited). A marked business:
//   - is left out of platform metrics, customer counts and MRR (still listed in the console, tagged Test);
//   - can only use Google Ads TEST accounts, even when ADS_LIVE_LAUNCH is on;
//   - only messages MESSAGE_TEST_RECIPIENTS, even when MESSAGES_LIVE is on;
//   - cannot use Stripe checkout/portal with a live key.
// Unmarking never silently promotes sandbox data: rows created before unmarked_at stay sandboxed
// (scheduled messages, launched campaigns), and Ads connections must be chosen again.
// Fails closed: if the table can't be read, the business is treated as a test business.

// SQL: true when the business in column `col` is currently marked as a test business.
export const isTestBusinessSql = (col) => `EXISTS (SELECT 1 FROM test_businesses tb WHERE tb.customer = ${col} AND tb.is_test = 1)`

const toStatus = (r) => (r ? { test: r.is_test === 1, markedAt: r.marked_at, unmarkedAt: r.unmarked_at ?? null } : { test: false, markedAt: null, unmarkedAt: null })

export async function testStatus(env, customerId) {
  try {
    const r = await env.ONBOARDING_DB.prepare('SELECT is_test, marked_at, unmarked_at FROM test_businesses WHERE customer = ?1').bind(customerId).first()
    return toStatus(r)
  } catch {
    return { test: true, markedAt: null, unmarkedAt: null, unreadable: true }
  }
}

// All businesses that are or were test businesses: Map id → status (missing id = never a test business).
// Returns null when unreadable; callers then treat every business as sandboxed (fail closed).
export async function testStatuses(env) {
  try {
    const { results } = await env.ONBOARDING_DB.prepare('SELECT customer, is_test, marked_at, unmarked_at FROM test_businesses').all()
    return new Map(results.map((r) => [r.customer, toStatus(r)]))
  } catch {
    return null
  }
}
export const statusIn = (map, customerId) => (map === null ? { test: true, unreadable: true } : map.get(customerId) || toStatus(null))

// Something created at `createdAt` belongs to the sandbox if the business is a test business now, or
// it was created before (or at) the moment the mark was removed. Unknown creation time → sandboxed while/once marked.
export const sandboxed = (status, createdAt) =>
  Boolean(status?.test || (status?.unmarkedAt != null && (createdAt == null || createdAt <= status.unmarkedAt)))

// Admin action (caller checks platform-admin authorization and same-origin, and audits).
export async function setTestBusiness(env, customerId, isTest, by, now = Date.now()) {
  const db = env.ONBOARDING_DB
  const current = await testStatus(env, customerId)
  if (current.unreadable) return { ok: false, httpStatus: 503, error: 'storage_error' }
  if (current.test === isTest) return { ok: true, changed: false, test: isTest }
  if (isTest) {
    await db
      .prepare(
        `INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES (?1, 1, ?2, ?3)
         ON CONFLICT(customer) DO UPDATE SET is_test = 1, marked_by = ?2, marked_at = ?3`,
      )
      .bind(customerId, String(by).slice(0, 200), now)
      .run()
    return { ok: true, changed: true, test: true }
  }
  // Unmark: record when, and make the owner choose ad accounts again (a sandbox connection is never
  // carried into live operation without a fresh, explicit choice).
  await db.batch([
    db.prepare('UPDATE test_businesses SET is_test = 0, unmarked_by = ?2, unmarked_at = ?3 WHERE customer = ?1').bind(customerId, String(by).slice(0, 200), now),
    db.prepare("UPDATE ad_connections SET status = 'needs_account', updated_at = ?2 WHERE customer = ?1 AND status = 'connected'").bind(customerId, now),
  ])
  return { ok: true, changed: true, test: false }
}
