# Data retention and account deletion

Status: **DRAFT, needs the owner's approval** (and ideally a lawyer's review) before `ACCOUNT_DELETION_ENABLED=true` is
set in production. The retention periods below are proposals, not legal advice. Code: `server/deletion.js`
(workflow), migration `0016_account_deletions.sql`; owner decision of 2026-11-14.

## Policy (owner decision 2026-11-14)

- **Deleting an account is permanent.** No undo window and no founder approval for routine deletions. Services stop at
  once; data is erased promptly by a durable, audited, retried workflow. A returning customer starts a new account
  (the old business id is never reused).
- **Canceling a subscription is not deletion.** After cancellation the account and its data stay recoverable for
  **90 days**; resubscribing brings everything back. (The website itself stays online for 14 days after the paid
  period, as the FAQ says.) Today canceled accounts are kept indefinitely; the 90-day rule is the next change.
- Only records with a documented legal, financial, dispute or security reason are kept after a deletion.

## What happens when an account is deleted

| Step | What | Verified by |
| --- | --- | --- |
| 1. Lockout (immediately) | Business suspended: website, booking page and own domain stop serving. All members lose access (memberships removed). Scheduled reminders/follow-ups cancelled; pending invitations revoked; unsent emails dropped. | Booking API 404; `/api/dashboard/me` has no business |
| 2. Ads | Every running campaign paused on Google/Meta, read back from Google. New launches/starts refused (ads hold `account_deleted`). A campaign that can't be paused blocks the deletion and is retried; it is never skipped. | Read-back `PAUSED`; no active campaign rows |
| 3. Billing | Every Stripe subscription of the business canceled **now** (no further charges, no proration credit), confirmed by asking Stripe again; the Stripe customer object is deleted. | Stripe reports `canceled` |
| 4. Integrations | Google Calendar token (and archived tokens from older OAuth clients) deleted; the Google grant is revoked unless another stored connection still uses the same grant. Google Ads / Meta tokens deleted (campaigns stay paused in the advertiser's own account). GoHighLevel key deleted. Own domain detached from Cloudflare. Ad creative files deleted. | KV keys absent |
| 5. Data | All records below under "Erased" deleted; the business row is reduced to a tombstone; emails in the staff log replaced by one-way references. | Row counts 0 |
| 6. Verify | Re-checks every erased table, KV key and the Stripe status; only then marked completed, with a report. | `account_deletions.report.verify.clean` |

Each step is idempotent. A failed step is retried by the cron with backoff (5 min, doubling, max 6 h) and recorded in
the permanent audit log; `/admin` shows the status and offers "Retry now".

## Erased (per business)

Leads (names, emails, phones, needs, ZIPs), service addresses, appointments, outcomes, confirmations, attendance
changes, messages, SMS consents, message opt-outs, test marks, attribution, Meta lead events, GoHighLevel links;
website drafts, versions, AI generations, images, domains, landing pages; business profile (phone, description,
services), booking/service settings, automation settings, onboarding marks, self-serve signup; Ads profile, budget
approvals, campaigns, creatives, metrics, Ads action history; memberships, invitations, onboarding invites; queued
emails; analytics events that are not billing events.

## Retained after deletion, and why

| Record | Contents | Why | Proposed period |
| --- | --- | --- | --- |
| `customers` tombstone | Business id, "Deleted business", status suspended, created date | Links the retained billing and audit records; prevents the id from being reused | As long as any record below |
| `subscriptions`, `subscription_modes` | Stripe customer/subscription ids, plan, status, monthly amount, period end | Tax/accounting, chargebacks and disputes, revenue reconciliation | 7 years, then delete |
| Billing events (`revenue`, `payment_*`, `subscription_*`) | Amounts, currency, dates (no personal data) | Same | 7 years, then delete |
| `ai_usage` | GetShowUps' own AI cost records (no personal data) | Our cost accounting | 7 years |
| `test_businesses` | Test flag, staff who set it | Keeps test data out of metrics | With the tombstone |
| `audit_log` | Hash-chained actions; emails only as one-way refs | Security and accountability; tamper evidence | Permanent (no personal data) |
| `admin_audit` | Staff actions; emails in details replaced by refs | Security and accountability | Permanent |
| `account_deletions` | When, who (one-way ref or staff email), per-step results, counts | Proof that the deletion happened; replay list after a backup restore | Permanent |
| `stripe_events`, `rate_limits`, `sessions` | Event ids / hashed keys / sign-in sessions (not tied to the business) | Idempotency, abuse protection | Expire on their own schedule |

The owner's Google Calendar events and Google Ads campaigns live in the owner's own Google accounts and are theirs; we
stop accessing them but do not delete them.

## External processors and backups

| Where | What remains | Schedule |
| --- | --- | --- |
| Cloudflare D1 (Time Travel backups) | Point-in-time copies of the database | Erased data leaves backups after the Time Travel window (30 days on paid plans). **Never restore a backup over production without re-running every completed deletion in `account_deletions`** (the table is the replay list). |
| Cloudflare KV / R2 | Tokens, creative files | Deleted in step 4 (no versioning). |
| Stripe | Transaction records (charges, invoices) | Kept by Stripe under its own legal obligations; the customer object is deleted in step 3. |
| Google | OAuth grant | Revoked in step 4 unless shared with another stored connection. |
| Resend (email) | Delivery logs of emails already sent | Per Resend's log retention; to confirm. |
| Cloudflare logs | Status codes/error codes only (we never log payloads) | Per Cloudflare's retention. |

## To approve before enabling in production

1. The retention table (periods, and keeping billing records 7 years).
2. Deleting the Stripe customer object at deletion time.
3. Apply migrations 0015 (audit log) and 0016 (account deletions), then set `ACCOUNT_DELETION_ENABLED=true`.
4. Privacy policy wording for deletion and retention (`src/legal/Privacy.jsx`), currently not changed.
