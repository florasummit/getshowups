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
- **Customers keep working during a deploy and a rollback.** A code rollback never touches data: drafts, published
  versions, bookings and settings stay as the owners left them. Never restore a database backup to "undo" a release
  (it would erase owner edits made since); restore data only for a confirmed data incident, with approval.
- **Website content written by newer code (rollback limit).** Live sites render per request from the stored live
  version, using whatever renderer is deployed. If a release adds a new website section type, theme option or content
  field and an owner publishes content using it, rolling the code back means the older renderer meets content it
  doesn't know: the renderer's `switch (s.type)` has no case for an unknown section, so that section is left out (the
  rest of the page renders), and an unknown option value becomes a CSS class the older stylesheet doesn't style. The
  next save through the older code would also run validateSpec, which drops or reports unknown choices. Before rolling back past such a
  release: list the businesses whose live version uses the new feature (query `website_versions` for the live
  version's `content.site`), render their live pages with the rollback target in a scratch worktree and diff, and tell
  the owner. Prefer a forward fix over a rollback in that case. Releases that only change validation, the editor or
  APIs (e.g. fix/deploy-safety) have no such limit: everything they store is readable by the previous release.
- **Open dashboards across a deploy.** Old chunk files disappear with a deploy (the server answers with the HTML page);
  lazyPage() reloads the page once. Studio keeps unsaved edits in localStorage and warns before unload; the classic
  editor sends a waiting change on leaving (keepalive). Every draft/settings save carries the version it saw, so a
  page from before the deploy can't overwrite newer work (409; older pages without the field still save).

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

## 6. Scalability (measured, `node --no-warnings scripts/scale-bench.mjs 10 100 1000`)

Synthetic, deterministic data on the real schema (node:sqlite; each first/all/run counted as one D1 request). Times
are local SQLite execution, not production latency; query and KV counts are what production would issue.

| At 1,000 businesses (25,000 audit entries) | D1 queries | KV ops | Note |
| --- | --- | --- | --- |
| Admin customer list (`customerRows`) | 2 | 1 | was 472 queries + 1,000 KV gets (hit the ~1,000 KV ops/request limit) |
| Business Review, Platform (after daily checkpoint) | 92 | 3 | same at 10 and 100; was 918 + 1,001 |
| Business Review, one business | 43 | 2 | independent of size; was 513 + 1,001 |
| Full audit chain verify (daily cron) | 54 | 0 | ~190 ms locally for 25k entries; page loads verify only entries since the checkpoint |
| Ads hold sweep, one cron run | ~195 | 0 | 25 businesses per run, least-recently-tried first (was: the same 25 forever) |
| Recovery expiry, one cron run | ≤ ~125 | 0 | 25 per run, already-recorded ones skipped (was: starved after 50) |
| One full account deletion | 118 | 14 | 2 per cron run (≈ 576/day) |
| 50 concurrent audit writes | 564 | 0 | all written, chain intact; the chain head is a serialization point (see below) |

Limits to watch: D1 allows ~1,000 queries per Worker request (paid plan). Worst-case cron run with every job busy at
1,000 businesses ≈ 200 (holds) + 125 (recovery) + 236 (deletions) + 54 (checkpoint) + existing jobs; split the cron into
separate triggers before that sum approaches the limit. Audit writes serialize on the chain head: fine for today's
volume (a few events per request); for sustained high write rates, batch per request or sequence through a Durable
Object. Stripe reconciliation lists up to 20,000 subscriptions per run and reports "incomplete listing" beyond that
instead of false alarms. Regression tests: `test/scale.test.js`.

## 7. The parallel "business-review.patch" (another agent, based on main d426fef)

Not used to build #28 (built independently on #24–#27). Reviewed in an isolated worktree (its own suite: 338 unit / 73
e2e passing). It re-implements systems the stack already has, so it is not merged. Adopted: health as a separate axis
with a 4 s check timeout; one payment-recovery email per invoice to owners (outbox, launch gate applies); a capability
event drill-down; a note in docs/DATA_REQUESTS.md. Not adopted: `audit_events` (purgeable, not tamper-evident;
duplicates audit_log), `lifecycle_states` (duplicates derived state), `deletion_requests` with a 14-day cancellable grace
period (contradicts the owner's no-undo-window decision; also deletes the business row so ids could be reused),
`ads/shutdown.js` (duplicates holds; no Google read-back, no billing triggers, no unreachable handling), a generic action
route (specific audited routes exist), and its migration `0015_operations_core.sql` (number collides with
`0015_audit_log.sql`; duplicate tables).
