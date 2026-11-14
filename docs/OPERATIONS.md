# Operations: Business Review, release plan, rollback and incident recovery

Status as of 2026-11-14. Production: deployment `0020f305` (main `d426fef`). Everything below the "Release plan" is
built on draft PRs #24–#28 and is **not deployed**.

## 1. The founder's weekly 20 minutes (`/admin/review`)

1. **Platform → Needs attention** (top): open failures (a failed action with no later success), capabilities that were
   working and went quiet, pending migrations, a broken audit chain, and business flags (payment failed, ads still
   running on hold, deletion stuck, recovery ending…). Empty = nothing to do.
2. **Waiting on a decision**: every capability that is built but switched off, with the exact switch/approval.
3. **Customer journey**: each capability with its status (Live-verified / Built + tested / Sandbox only / Off · needs
   approval / Not built / Unknown). Tap a row for evidence, dependencies, blockers and events.
4. **Business**: search a business → lifecycle, billing, website, calendar, ads (campaigns, budget, hold), funnel
   counts, attribution, its events and open problems. Counts only; no lead contact details.
5. **Releases, migrations and switches**: deployed commit, migrations applied/pending, which switches are on.

The Overview tab keeps the existing metrics, customer list, audit log, reconciliation and plans.

## 2. Architecture of the review (one foundation, features plug in)

```
feature module ──registerCapability()──▶ server/ops/registry.js ◀── server/ops/catalog.js (imports every module)
feature code ────recordEvent()─────────▶ audit_log (hash-chained; capability, resource, outcome, correlation)
cron ────────────recordChanges()───────▶ audit_log (platform.release / platform.config)
build ───────────scripts/build-info.mjs▶ dist/build.json (commit, tables per migration)
                       │
server/ops/review.js (generic engine) ──▶ /api/platform/review ──▶ src/admin/Review.jsx (generic UI)
```

Adding a feature (e.g. SMS, an AI responder, a new ad platform):

1. `registerCapability({ id, name, journey, dependsOn, external, state, verify?, business?, blockers? })`
   (contract at the top of `server/ops/registry.js`), imported once from `server/ops/catalog.js`.
2. Record consequential actions and failures with `recordEvent({ type, capability: id, customer, resource, outcome,
   correlationId, details })` (docs/AUDIT.md).
3. Nothing else: status, dependencies, evidence, incidents, per-business status and events appear automatically
   (proved by `test/review.test.js` "PHASE 4" and `test/e2e/review.spec.js`). Management controls (buttons) still
   need their own UI.

AI and conversation providers: `server/conversations/` — providers register as capabilities, only *propose* actions
(`validateAction`), GetShowUps executes them; one controller per conversation (`control.js`, migration 0017).
Claude, OpenAI, a voice provider and GoHighLevel are registered as "Not built" (no adapters, accounts or costs).

## 3. Release plan (needs approval for every production step)

Order is fixed by dependencies. Each PR's CI must be green at its final commit; apply each migration **before** the
merge that needs it (all are additive, `CREATE … IF NOT EXISTS`, safe for the code already running).

| Step | Action | Notes |
| --- | --- | --- |
| 1 | Merge #24 (ads safety stop) | No migration. Effective at once: holds pause running campaigns on payment failure/end/suspension. |
| 2 | Apply `0015_audit_log.sql`, merge #25 | Before merging; without it events log `table_missing` and actions proceed. |
| 3 | Apply `0016_account_deletions.sql`, merge #26 | Deletion stays OFF (`ACCOUNT_DELETION_ENABLED` unset). |
| 4 | Merge #27 (lifecycle, recovery, reconciliation) | No migration. Daily reconciliation starts reading Stripe (test mode, read-only). Day-90 only records expiry. |
| 5 | Apply `0017_conversation_control.sql`, merge #28 (Business Review) | Build now writes `dist/build.json`. |
| 6 | Verify (read-only): `/admin/review` loads, "Migrations: 17 of 17 applied", audit log intact, reconciliation result, PoolThru/booking smoke as in the last release. |
| Later | `ACCOUNT_DELETION_ENABLED`, `RETENTION_SCHEDULE_ENABLED`, live billing/messaging/ads | Separate decisions (docs/DATA_RETENTION.md). |

Command per migration (from a checkout containing the file):
`npx wrangler d1 execute getshowups-onboarding --remote --file migrations/<file>.sql`, then check the table exists.

## 4. Rollback

- **Code:** Cloudflare Pages → Deployments → the previous deployment → Rollback (instant), or `git revert -m 1 <merge>`.
  Current safe target before this release: `0020f305`.
- **Migrations:** never drop the new tables. Older code ignores them. `audit_log` must never be edited or emptied.
- **Switches:** turning a switch off (`ACCOUNT_DELETION_ENABLED`, `RETENTION_SCHEDULE_ENABLED`) stops new work at the next
  request/cron run; an in-progress deletion pauses (steps already done are not undone — deletion has no undo).

## 5. Incident recovery

| Symptom (Business Review) | Meaning | What to do |
| --- | --- | --- |
| "Ads still running while on hold" | A held business has a campaign we couldn't pause | If "unreachable": ask the owner to pause it in Google Ads, then record it (`/api/platform/campaign-pause` or the owner's button). Otherwise it retries every 5 min; pause it in Google Ads to stop spend now. |
| "Deletion stuck" | A deletion step failed 3+ times | Business → see the step and error. Stripe/Google down: wait or "Retry now". Unreachable campaign: record the confirmation. Never mark complete by hand. |
| Reconciliation differences | Stripe and our records disagree | Status/amount/cancel: "Resync from Stripe" (audited). Billing after deletion: cancel in Stripe immediately. Missing payments: check the webhook endpoint. |
| "Audit log integrity check failed" | An entry was changed or removed | Stop and investigate access; compare with the last exported log; do not "fix" entries. |
| Migration pending | Code expects a table production lacks | Apply the migration (approval) or roll back the code. |
| "<capability>: not seen working recently" | It worked before and nothing has happened since | Check whether usage simply stopped or the integration broke (e.g. no bookings reaching Google Calendar). |
| Cron silent (no daily checkpoint) | The scheduler Worker isn't running | Check `workers/scheduler` in Cloudflare; run `/api/cron/run` with the secret. |

Restoring a database backup: re-run every completed deletion in `account_deletions` afterwards, and compare the audit
head hash with the last export (docs/DATA_RETENTION.md, docs/AUDIT.md).
