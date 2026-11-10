// Test records vs real customer data. A lead (and its appointments) is a test when an owner or admin
// marked it as one, or (unless marked "not a test") when its email belongs to GetShowUps, to one of
// the business's own users, or to a platform admin. Test records are never
// deleted or changed; they are shown with a "Test" tag and left out of every result and metric.
import { adminEmails } from './platform.js'

export const INTERNAL_EMAIL_DOMAINS = ['getshowups.com']

export const internalEmails = (env) => JSON.stringify(adminEmails(env))

// SQL boolean: is lead `alias` a test? `param` is the placeholder bound to internalEmails(env).
export const isTestLead = (alias, param) => `(
  EXISTS (SELECT 1 FROM test_marks tm WHERE tm.lead_id = ${alias}.id AND tm.is_test = 1)
  OR (NOT EXISTS (SELECT 1 FROM test_marks tm WHERE tm.lead_id = ${alias}.id AND tm.is_test = 0)
      AND (${INTERNAL_EMAIL_DOMAINS.map((d) => `lower(${alias}.email) LIKE '%@${d}'`).join(' OR ')}
           OR lower(${alias}.email) IN (SELECT lower(u.email) FROM customer_users u WHERE u.customer = ${alias}.customer)
           OR lower(${alias}.email) IN (SELECT value FROM json_each(${param})))))`

// Owner (or admin) marks a lead as test / not a test. Only for this business's own leads.
export async function markTest(db, customerId, leadId, isTest, by, now = Date.now()) {
  if (typeof leadId !== 'string' || typeof isTest !== 'boolean') return { ok: false, httpStatus: 400, error: 'invalid_request' }
  const lead = await db.prepare('SELECT id FROM leads WHERE id = ?1 AND customer = ?2').bind(leadId, customerId).first()
  if (!lead) return { ok: false, httpStatus: 404, error: 'not_found' }
  await db
    .prepare(
      `INSERT INTO test_marks (lead_id, customer, is_test, marked_by, marked_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(lead_id) DO UPDATE SET is_test = ?3, marked_by = ?4, marked_at = ?5 WHERE test_marks.customer = ?2`,
    )
    .bind(leadId, customerId, isTest ? 1 : 0, String(by).slice(0, 200), now)
    .run()
  return { ok: true }
}
