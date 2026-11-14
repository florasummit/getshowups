# Audit log and standard events

Code: `server/auditlog.js` · table `audit_log` (migration 0015) · admin: `/admin` → Audit log, `GET /api/platform/audit`.

## Recording an event (any feature)

```js
import { recordEvent } from '../server/auditlog.js'
await recordEvent(env.ONBOARDING_DB, {
  type: 'sms.send',                  // '<area>.<verb>'
  actor: 'system:messages',          // 'owner:<email>' | 'admin:<email>' | 'system:<job>' | 'stripe'
  customer: 'poolthru-llc',          // business id, or null for platform-wide
  capability: 'messaging.sms',       // capability id from the registry (server/ops/capabilities/)
  resource: { type: 'message', id },  // stable id of the thing acted on
  outcome: 'failure',                // success | failure | info (an observation, e.g. a Stripe event)
  correlationId,                     // ties related entries: a webhook and what it caused, one deletion, a retry
  details: { error: 'twilio_21610' } // codes, ids, numbers, booleans
})
```

`recordEvent` never throws; if the table is missing or the store fails it logs an error code and the action proceeds.
Failures and the retry that later succeeded share a correlation id and resource, so the Business Review can tell an
open problem from a resolved one. Nothing else is needed for an event to show up in Business Review.

## What is (and isn't) stored

- Email addresses anywhere → `ref:<sha256 prefix>` (one-way; the same address always gives the same ref).
- Free text (anything not a short identifier/code) → `text:<sha256 prefix>`. Names, notes and reasons stay only in the
  deletable tables (`admin_audit`, `ad_actions`), which account deletion erases or scrubs.
- Staff (platform admin) emails are kept: they are the accountable actors.
- Business ids are kept. They can contain a business name (e.g. `poolthru-llc`); they are retained as the link to billing
  and audit records (docs/DATA_RETENTION.md).

## Tamper evidence: guarantees and limits

- **Append-only in the database:** triggers make SQLite refuse `UPDATE`/`DELETE` on `audit_log`.
- **Hash chain:** each entry's SHA-256 covers all its fields and the previous entry's hash. `verifyAuditChain` finds an
  altered, missing or reordered entry. The cron verifies the full chain daily and records a checkpoint (head hash).
- **Limits (be honest about these):**
  - Anyone with full write access to the D1 database (Cloudflare account, `wrangler d1 execute --remote`) can drop the
    triggers and rewrite the *whole* chain consistently. The chain proves integrity only relative to a head hash kept
    somewhere they can't change. Today that is: the JSON exports the founder downloads, and the checkpoint entries
    themselves. Stronger: send the daily head hash outside Cloudflare (e.g. email to the founder, or an object store
    with object lock). Not built; needs a decision.
  - D1 Time Travel can restore the database to an earlier point; entries after that point would disappear. Compare with
    the last exported head hash after any restore.
  - Events are written after the action they describe; if the write fails (logged as `audit log not written`), the
    action still happened. This is deliberate: an audit hiccup must not undo a payment pause or a deletion.
  - Clock: `at` is the Worker's clock; the sequence number, not the time, defines order.
