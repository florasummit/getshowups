# Data retention, cancellation and account deletion — DRAFT

**Status: draft for the owner's decision. Not legal advice.** The periods below are engineering proposals based on
common practice; tax, consumer-protection and privacy obligations depend on where GetShowUps and its customers operate
(e.g. US federal/state tax rules, CCPA/CPRA, GDPR if EU residents are involved). Have them reviewed by a qualified
professional before relying on them or publishing them. Nothing here is switched on in production:
`ACCOUNT_DELETION_ENABLED` and `RETENTION_SCHEDULE_ENABLED` are unset.

Code: `server/deletion.js` (workflow, migration 0016), `server/lifecycle.js` (recovery, schedule),
`server/auditlog.js` (permanent log, migration 0015). Owner decisions of 2026-11-14.

## 1. Two separate things

| | Cancel the subscription | Delete the account |
| --- | --- | --- |
| Who | Owner, in Stripe's billing portal | Owner (Settings, typed business name) or platform admin (verified request, typed id) |
| Billing | Stops at the end of the paid period | Canceled immediately, no further charges |
| Website | Online until the paid period ends + 14 days | Offline immediately |
| Ads (managed by GetShowUps) | Paused when the subscription ends (ads hold) | Paused and confirmed immediately |
| Data | Kept, fully recoverable for **90 days** after the paid period | Erased promptly (section 3) |
| Undo | Reactivate any time in the 90 days: everything comes back | None. A returning customer starts a new account |

## 2. After the 90-day recovery period (cancellation only)

Day 90 does **not** delete anything by itself. Recovery eligibility expires and is recorded; the founder sees
"Recovery period over". What happens next is the **retention schedule**, which must be approved and disclosed (privacy
policy and the owner's Billing card) before `RETENTION_SCHEDULE_ENABLED=true` is set. Proposed schedule: the account
then goes through the same deletion workflow as section 3, keeping only the records in section 4.

Until the schedule is approved, canceled accounts' data is kept indefinitely. That is the conservative default for
now but not a good long-term state (it keeps end customers' personal data with no purpose): **decide this soon.**

## 3. Deletion workflow (what is erased, and how we know)

| Step | What | Verified by |
| --- | --- | --- |
| 1. Lockout (immediately) | Business suspended; website unpublished and own domain stops serving; booking page off; all members lose access; scheduled messages cancelled; invitations revoked; unsent emails dropped | Booking API 404; no membership |
| 2. Ads | Every running GetShowUps-managed campaign paused on Google/Meta and read back. An unreachable campaign (account disconnected/switched) blocks the deletion until a platform admin records the advertiser's confirmation that it is paused. Credentials are not removed before this. | Read-back PAUSED or audited confirmation |
| 3. Billing | All Stripe subscriptions canceled now and re-checked; Stripe customer object deleted | Stripe reports canceled |
| 4. Integrations | Calendar tokens (incl. archived) deleted; Google grant revoked unless another stored connection uses it; Ads/Meta/GoHighLevel tokens deleted; own domain detached; ad creative files deleted | KV keys absent |
| 5. Data | Tables in `ERASED_TABLES` (AI rules and their versions, leads and the service each request was for, booking-page options, Local Services lead records, call records Google reports, conversations and their messages, follow-up preferences, texting registration, addresses, appointments, messages, consents, imported Google Ads campaigns and their metrics, campaign templates, Business Profile link, change requests, opt-outs, websites and versions, images, profiles, settings, Ads records, memberships, invitations, queued email, non-billing analytics) | Row counts 0 |
| 6. Verify | Re-checks every table, key and the Stripe status; only then "completed" | report.verify.clean |

Steps are idempotent; failures retry with backoff (5 min doubling to 6 h), are recorded as failure events, and after 3
failed attempts show as "Deletion stuck" in /admin. A deletion is never reported complete while anything is left.

Added 2026-11-24: members are signed out everywhere (their sign-in sessions are removed); test/deletion-completeness.test.js fails
if a table with a business id is neither erased nor deliberately kept. Google Ads and Business Profile grants are not revoked at Google
(they may be shared with Calendar): the owner is told to remove GetShowUps in their Google Account. Expired sessions of everyone are
removed a day after they expire (server/sessions-purge.js). Still switched off: ACCOUNT_DELETION_ENABLED. Backups: docs/BACKUPS.md.

## 4. Kept after deletion, and why (proposed)

| Record | Contents | Why | Proposed period |
| --- | --- | --- | --- |
| `customers` tombstone | Business id, "Deleted business", status | Links the records below; stops the id being reused | As long as any record below |
| `subscriptions`, `subscription_modes`, billing events | Stripe ids, plan, status, amounts, dates; no end-customer data | Tax/accounting, chargebacks, disputes, revenue reconciliation | 7 years (common US practice for tax records; confirm) |
| `ai_usage` | GetShowUps' own AI costs | Cost accounting | 7 years |
| `audit_log` | Hash-chained events; emails only as one-way refs, no free text | Security, accountability, tamper evidence | Permanent (no personal data by construction); the business id may contain a business name |
| `admin_audit` | Staff actions; emails → refs, free text erased at deletion | Security, accountability | Permanent |
| `account_deletions` | When, who (ref or staff email), per-step results | Proof of deletion; replay list after a backup restore | Permanent |
| `test_businesses` | Test flag | Keeps test data out of metrics | With the tombstone |
| `acceptance_pairings` | Pairing codes (hashes) | Test sessions | Minutes: expired rows removed at the next pairing |
| `receptionist_voice_defaults` | Platform-wide default voice provider history (versions; ids of businesses a version pinned) | Platform configuration, not business data | Permanent (business ids only, no personal data) |
| `stripe_events`, `rate_limits`, `sessions` | Event ids, hashed keys, sign-in sessions (not tied to the business) | Idempotency, abuse prevention | Their own expiry |

## 5. Processors and backups (what we can and can't control)

| Where | What may remain | Our control |
| --- | --- | --- |
| **Cloudflare D1 backups (Time Travel)** | Point-in-time copies of the whole database | Data leaves backups when the Time Travel window passes (30 days on paid plans; verify the plan). **Never restore over production without re-running every completed deletion in `account_deletions`.** |
| Cloudflare KV / R2 | Tokens, creative files | Deleted in step 4 (no versioning used). |
| Cloudflare logs | Status/error codes only (no payloads are logged) | Cloudflare's retention. |
| **Stripe** | Charges, invoices, payment records | Stripe keeps these under its own legal obligations even after the customer object is deleted; we can't erase them. |
| **Google** | The OAuth grant; events we created in the owner's calendar; campaigns in the owner's Ads account | Grant revoked unless shared; calendar events and campaigns belong to the owner's Google account and stay there (paused). |
| **Resend** | Logs of emails already sent (recipient, subject) | Resend's log retention (check the current plan; we can't delete individual logs from here). |
| GoHighLevel | Contacts we synced (if GHL was used) | In the owner's GHL account; the owner controls them. We delete our key. |
| Downloads/exports | Website export, audit exports the founder saved | Outside the system; the founder's responsibility. |

## 6. Security logs

The permanent audit log holds no personal data by construction (emails → one-way refs; free text → fingerprints).
Staff identities are kept for accountability. Limits of its tamper evidence: docs/AUDIT.md.

## 7. Decisions needed before anything is enabled

1. Approve section 4 periods (or set others) and deleting the Stripe customer object.
2. Approve the retention schedule after day 90 (section 2), including how it is disclosed.
3. Approve enabling the deletion workflow (`ACCOUNT_DELETION_ENABLED`) after migrations 0015 and 0016.
4. Privacy policy and FAQ wording (`src/legal/Privacy.jsx`, `src/content/site.js`), not changed yet.
5. Whether to send the daily audit head hash outside Cloudflare (stronger tamper evidence).

## Business account types (migration 0034)

`business_accounts` holds the classification, billing entitlement, environment and provider-spend setting of a
business plus the staff admin who set it (`set_by`, a staff address, readable like other admin actors) and a short
reason. Erased with the business (ERASED_TABLES). The change history lives in the permanent audit log
(`account.classify` / `account.create`), where addresses are refs.

## Follow-up conversations (migration 0024)

- `thread_messages` holds conversation text for the owner's inbox. It is never logged, never shown in admin views, and
  is removed after 365 days (cron, `purgeOldMessages`, 500 per run). Delivery counts stay in the audit log (no text).
- `lead_threads`, `followup_settings`, `sms_registrations`, `sms_registration_extra`, `sms_provider_objects`, `sms_accounts` and `thread_messages` are in `ERASED_TABLES` (account deletion); the business's Twilio subaccount is closed first (integrations step; Twilio releases its numbers).
- Service-area requests (migration 0029): `coverage_requests` (lead id, ZIP as typed, owner decision, decider as a
  reference) is in `ERASED_TABLES`; kept with the lead otherwise.
- Visit money (migration 0028): `revenue_entries` (invoiced / paid amounts per visit, append-only, recorder stored as a
  reference) is in `ERASED_TABLES`; kept with the appointment otherwise. Receptionist conversations started from an ad
  keep only the campaign parameters and whether a click id was present (never the click id).
- AI receptionist (migration 0026): `receptionist_conversations` (transcripts incl. what customers typed or said),
  `receptionist_events`, `receptionist_calls`, `receptionist_settings` and (migration 0027) `receptionist_requests`,
  (migration 0035) `receptionist_voice_settings` and (migration 0036) `receptionist_voice_inherit`
  (callback requests/messages: name, phone/email, note) are in `ERASED_TABLES`; conversations (with their events,
  calls and requests) are purged 365 days after their last update (cron).
- Opt-outs remain hashes (`message_optouts`); texting consent evidence stays in `sms_consents` (wording version + time)
  for as long as the lead exists.

## 8. Added 2026-11-25 (code: server/deletion.js, server/people.js, server/business-export.js)

| Topic | What happens | State |
| --- | --- | --- |
| Recovery window | `ACCOUNT_RECOVERY_DAYS` (0–90; unset = none, the 2026-11-14 decision). Business offline, ads paused, plan set not to renew and confirmed with Stripe (retried every cron run), nothing erased, owner or founder can undo. Afterwards the workflow of section 3 runs. Undo never restarts charges or ads | Built, off. 14 days is proposed, **not approved** |
| While deletion is off | The owner asks in Settings; the founder sees it in /admin; nothing is changed by the request | Live with the release |
| Personal account | Membership, sessions, invitations, account email, notice choices and the sign-up marker are erased; staff-log emails become one-way refs. Never the last member or a platform admin | Built, off with ACCOUNT_DELETION_ENABLED |
| Protected | internal_live businesses and the GetShowUps sales record can't be deleted from the product | Always |
| Restored backups | Completed deletions leave a marker in KV (id, date). Hourly, a deleted business found back in the database is taken offline, its people removed, and (when deletion is on) deleted again. Ids are never reused | Always on |
| Canceled plans after a restore | Daily reconciliation applies subscriptions Stripe says have ended | Always on |
| Also erased | ChatGPT Ads key; closed dates, booking notice, notice choices, restrictions | With the workflow |

**Decisions:** recovery window (0 or 14) · retention after 90 days · billing records 7 years · all in docs/legal/ATTORNEY_REVIEW.md.
