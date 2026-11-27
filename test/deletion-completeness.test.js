// Every table that holds a business's data is either erased or deliberately kept: a new table can't be forgotten.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ERASED_TABLES } from '../server/deletion.js'

// Kept on purpose (docs/DATA_RETENTION.md): billing, costs, flags, the logs and the deletion record itself; events are
// erased apart from financial ones. No names or contact details in any of them.
const KEPT = ['subscriptions', 'subscription_modes', 'ai_usage', 'test_businesses', 'audit_log', 'admin_audit', 'account_deletions', 'events', 'commission_ledger']
test('no table with a business id is left out of the deletion', () => {
  const db = new DatabaseSync(':memory:')
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  const left = []
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name)
    if (cols.includes('customer') && !ERASED_TABLES.includes(name) && !KEPT.includes(name)) left.push(name)
  }
  assert.deepEqual(left, [])
})
