// One person's deletion on synthetic data: nothing of theirs left anywhere in the business, everyone else untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { personDeletionSql } from '../scripts/person-deletion.mjs'

test('erases one person completely, and only them', () => {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  db.exec('PRAGMA foreign_keys = OFF')
  const add = (t, v) => db.prepare(`INSERT INTO ${t} (${Object.keys(v).join(',')}) VALUES (${Object.keys(v).map(() => '?').join(',')})`).run(...Object.values(v))
  for (const [c, who, email] of [['alpha', 'p1', 'Pat@Person.example'], ['alpha', 'p2', 'other@x.example'], ['beta', 'p3', 'pat@person.example']]) {
    add('leads', { id: who, customer: c, name: `N ${who}`, email, phone: `555${who}`, need: 'x', zip: '', status: 'booked', token_hash: 'x', created_at: 1, updated_at: 1 })
    add('appointments', { id: `a-${who}`, customer: c, lead_id: who, start_at: Number(who.slice(1)), end_at: 9, status: 'showed', google_event_id: 'e', created_at: 1, updated_at: 1 })
    add('lead_addresses', { lead_id: who, customer: c, street: `S ${who}`, unit: '', city: 'C', state: 'SC', zip: '1', created_at: 1 })
    add('lead_threads', { lead_id: who, customer: c, source: 'website_form', created_at: 1, updated_at: 1 })
    add('thread_messages', { id: `t-${who}`, customer: c, lead_id: who, direction: 'in', channel: 'sms', author: 'lead', body: `B ${who}`, status: 'received', created_at: 1, updated_at: 1 })
    add('messages', { id: `m-${who}`, customer: c, lead_id: who, kind: 'confirmation', channel: 'email', send_at: 1, status: 'sent', created_at: 1, updated_at: 1 })
    add('sms_consents', { lead_id: who, customer: c, wording: 'w', consented_at: 1 })
    add('lead_attribution', { lead_id: who, customer: c, source: 'google_ads', created_at: 1 })
    add('coverage_requests', { lead_id: who, customer: c, zip: '1', zip_check: 'outside', status: 'pending', created_at: 1 })
    add('revenue_entries', { customer: c, appointment_id: `a-${who}`, kind: 'paid', amount_cents: 1, recorded_by: 'r', recorded_at: 1 })
    add('appointment_outcomes', { appointment_id: `a-${who}`, customer: c, work: 'completed', reported_at: 1 })
    add('appointment_confirmations', { appointment_id: `a-${who}`, customer: c, confirmed_at: 1 })
    add('receptionist_conversations', { id: `v-${who}`, customer: c, channel: 'chat', lead_id: who, transcript: `T ${who}`, created_at: 1, updated_at: 1 })
    add('receptionist_events', { customer: c, conversation_id: `v-${who}`, kind: 'x', ok: 1, at: 1 })
    add('email_outbox', { id: `o-${who}`, to_email: 'owner@x.example', customer: c, template: 'owner_lead', subject: 's', body: `From ${email}`, status: 'sent', created_at: 1 })
  }
  db.exec('PRAGMA foreign_keys = ON')
  for (const s of personDeletionSql('alpha', 'pat@person.example')) db.exec(s)
  const left = (needle) => {
    let n = 0
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) for (const r of db.prepare(`SELECT * FROM ${name}`).all()) if (JSON.stringify(r).includes(needle)) n++
    return n
  }
  assert.equal(left('p1'), 0)
  assert.equal(left('Pat@Person'), 0)
  assert.equal(left('p2'), 15)
  assert.equal(left('p3'), 15)
  assert.throws(() => personDeletionSql("x' OR 1", 'a@b.example'))
  assert.throws(() => personDeletionSql('alpha', "a'@b.example"))
})
