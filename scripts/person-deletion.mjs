// One person's data (docs/DATA_REQUESTS.md): PRINTS the SQL that erases them from one business; runs nothing.
//   node scripts/person-deletion.mjs <business id> <email>      review, back up, then run the printed file with wrangler.
// Test: test/person-deletion.test.js runs it on synthetic data and proves nothing of theirs is left and nobody else is touched.
import { fileURLToPath } from 'node:url'

const q = (v) => `'${String(v).replace(/'/g, "''")}'`

// Children before parents. Kept on purpose: message_optouts and email_suppressions (one-way hashes that stop messages to
// them), audit_log (no personal data), revenue totals of other people.
export function personDeletionSql(customer, email) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(customer) || !/^[^\s'"]+@[^\s'"]+$/.test(email)) throw new Error('business id and email needed')
  const C = q(customer)
  const E = q(email.trim().toLowerCase())
  const L = `(SELECT id FROM leads WHERE customer = ${C} AND lower(email) = ${E})`
  const A = `(SELECT id FROM appointments WHERE customer = ${C} AND lead_id IN ${L})`
  const V = `(SELECT id FROM receptionist_conversations WHERE customer = ${C} AND (lead_id IN ${L} OR appointment_id IN ${A} OR id IN (SELECT conversation_id FROM receptionist_requests WHERE customer = ${C} AND lower(email) = ${E})))`
  const del = (t, where) => `DELETE FROM ${t} WHERE customer = ${C} AND ${where};`
  return [
    del('receptionist_events', `conversation_id IN ${V}`),
    del('receptionist_calls', `conversation_id IN ${V}`),
    del('receptionist_conversations', `id IN ${V}`),
    del('receptionist_requests', `(lower(email) = ${E} OR conversation_id NOT IN (SELECT id FROM receptionist_conversations WHERE customer = ${C}))`),
    del('revenue_entries', `appointment_id IN ${A}`),
    del('appointment_confirmations', `appointment_id IN ${A}`),
    del('appointment_outcomes', `appointment_id IN ${A}`),
    del('appointment_changes', `appointment_id IN ${A}`),
    ...['messages', 'thread_messages', 'sms_consents', 'lead_addresses', 'lead_attribution', 'coverage_requests', 'test_marks', 'meta_lead_events', 'lead_threads'].map((t) => del(t, `lead_id IN ${L}`)),
    del('conversation_control', `conversation_id IN ${L}`),
    `UPDATE lsa_leads SET lead_id = NULL WHERE customer = ${C} AND lead_id IN ${L};`,
    `DELETE FROM email_outbox WHERE customer = ${C} AND (lower(to_email) = ${E} OR instr(lower(body), ${E}) > 0);`,
    `DELETE FROM events WHERE customer = ${C} AND id IN (SELECT 'lead:' || id FROM leads WHERE customer = ${C} AND lower(email) = ${E});`,
    del('appointments', `lead_id IN ${L}`),
    del('leads', `lower(email) = ${E}`),
  ]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('-- Back up first. Remove their Google Calendar events by hand BEFORE running this. Run with: wrangler d1 execute <db> --remote --file <this>')
  console.log(personDeletionSql(process.argv[2] || '', process.argv[3] || '').join('\n'))
}
