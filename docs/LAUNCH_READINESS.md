# Launch readiness after the live audit (2026-11-14)

Evidence is labelled **[prod]** (observed in production: deployment 1db27fd7, main abbbbfa, migrations 0001–0017)
or **[local]** (unit/Playwright tests, synthetic data, mocked Google/Stripe). Nothing here enabled a live service.

## 1. GSU Journey Test cleanup (approved: unpublish site, cancel test subscription, cancel test appointment)

Every target was checked to belong only to `gsu-journey-test` (test-marked business; sole member is the separate
journey Google account; Stripe customer/subscription referenced only by that business; appointment and event created by
its own booking).

| Target | Result | Evidence |
| --- | --- | --- |
| Website | **Done.** Unpublished. Draft and versions kept. | [prod] `/p/gsu-journey-test` → 404; audit `website.unpublish` |
| Stripe test subscription | **Partly done.** `cancel_at_period_end` set, ends 2026-12-14. The customer portal only offers end-of-period cancellation. | [prod] webhook recorded; audit entries for cancel/reactivate/cancel; `livemode: false` |
| Nov 16 appointment + Calendar event | **Not done.** There was no product path for it. A manual database edit was refused (it would leave reminders and the Calendar out of sync). | Needs PR #31 deployed, then **Appointments → Cancel… → Confirm** as the owner |

Kept, as instructed: business record, billing history, audit log, recordings. Deletion not enabled. No Google grant revoked.

**Owner options for the subscription:** cancel immediately in the Stripe *test* dashboard, or let it end on Dec 14.
Either way the webhook records it.

## 2. PR #30 (Business Review accuracy): review result

- **Security/isolation:** read-only checks. No customer parameter from clients. The KV listing returns key names
  only, and business ids are shown without contact details. Founder evidence compares session emails to
  `PLATFORM_ADMIN_EMAILS` server-side and never displays them.
- **Correctness:** test businesses and test-marked leads never count as evidence. "Never triggered" is not success.
  Reconciliation differences and orphaned credentials become open incidents (health "failing").
  - **Defect found and fixed in this review (60e7959):** after a business was *unmarked*, its sandbox-era rows counted
    as real evidence. Rows up to `unmarked_at` are now excluded, consistent with server/testbusiness.js. The test fails
    without the fix.
- **Performance [local]:** platform view 94 queries, flat from 10 to 1,000 businesses. Orphan detection pages KV (1 list op per 1,000 keys).
- **Regression:** 377/377 unit, `verify` green, CI green. **Stays draft.**

## 3. PR #31: launch blockers (draft, CI green, 377 unit + 72 Playwright)

| Sev | Defect [prod] | Fix [local] |
| --- | --- | --- |
| P1 | Owners can't cancel an appointment; deleting it in Google leaves reminders scheduled | Owner cancel: Google event removed first (attendee notified), then booking cancelled, slot reopened, audited. Google down → nothing changes |
| P1 | Test-business websites indexable | `noindex` meta + `X-Robots-Tag`, fails closed |
| P2 | Deep links held on "You're all set" | Finishes and opens the requested page |

No migration, no new secrets.

## 4. Stripe and messaging readiness

### Findings
- **Stripe [prod, sandbox account only; the live account is not visible to this session]:**
  - display/business name "Flora Summit LLC sandbox" (shown to customers at checkout);
  - business URL `florasummit.com`;
  - no support email, phone or URL;
  - no branding (logo, icon, colours);
  - statement descriptor `FLORASUMMIT.COM`;
  - Link opt-in ticked by default at checkout.
- **Sender DNS [prod, public DNS]:**
  - DKIM `resend._domainkey.getshowups.com` present;
  - `send.getshowups.com` has SPF and a feedback MX;
  - root SPF covers Google only (fine: Resend sends from the `send.` subdomain);
  - DMARC `p=none` with reports.
  - Resend's own domain status must be confirmed in the Resend dashboard.
- **Code [local]:**
  - launch gate fails closed (`MESSAGES_LIVE`);
  - test businesses are always test-only;
  - every follow-up has a signed unsubscribe link plus RFC 8058 headers; opt-outs fail closed;
  - Twilio STOP is recorded;
  - sends are claimed atomically, never resent after an unknown outcome, retried with backoff, max attempts;
  - throughput 20 messages per 5-minute cron run (≈240/h).
- **Gaps:**
  - P2: no Resend bounce/complaint webhook, so our records don't learn about hard bounces (Resend suppresses on its side).
  - P2: we send no failed-payment email ourselves. This relies on Stripe's customer emails and retries plus the
    dashboard notice and the ads hold.
- **[prod] journey:** confirmation `skipped/test_mode` (correct for a test business); follow-up `skipped/not_needed`.

### Activation checklist (each step needs owner approval)
1. **Stripe live account:**
   - complete verification;
   - set the public business name to **GetShowUps**, add support email/URL and branding;
   - set the statement descriptor (e.g. `GETSHOWUPS`);
   - decide on Link (Settings → Payment methods; recommended: off by default, or accept);
   - turn on Billing → *Customer emails: failed payments*, *Smart Retries* and *Send emails about expiring cards*.
2. Create the live $499/month Price and the live webhook endpoint (same events as test). Put the live `STRIPE_SECRET_KEY`
   and `STRIPE_WEBHOOK_SECRET` in Cloudflare secrets, and record the plan by Price id in /admin → Plans.
3. Confirm migration 0013 is applied (it is: 0001–0017), then set `STRIPE_LIVE_ENABLED=true`.
4. **Live test:**
   - one real $499 checkout on a founder-owned *non-test* business;
   - webhook recorded with `livemode: true`;
   - /admin MRR shows $499 and reconciliation is clean;
   - portal cancel, then refund in Stripe.
5. **Resend:**
   - confirm the domain is *Verified*;
   - send a test to `MESSAGE_TEST_RECIPIENTS`;
   - check SPF/DKIM pass in the headers;
   - one-click unsubscribe works;
   - then set `MESSAGES_LIVE=true`.
6. Twilio (optional for launch): A2P 10DLC registration before any texts.

**Rollback:**
- unset `STRIPE_LIVE_ENABLED` (revenue metrics go back to null, test keys count again) or restore the test keys;
- unset `MESSAGES_LIVE` (back to test recipients only, effective on the next cron run);
- code rollback target is deployment 1db27fd7.

## 5. Google Ads blockers

**External (Google; approval or waiting):**
- the Cloud project is at Test access. Real accounts need Explorer/production developer-token access
  (`not_approved_for_production`);
- OAuth app verification for the Ads scope (docs/GOOGLE_OAUTH_VERIFICATION.md);
- the Data Manager scope for conversion feedback is a new sensitive scope;
- PoolThru's Google Ads billing setup (owner, in Google Ads);
- Google's own confirmation that a paused campaign stopped serving.

**Engineering/approval switches (built, off):**
- `ADS_ENABLED` + `ADS_BUSINESSES` (pilot list);
- `ADS_LIVE_LAUNCH`;
- `ADS_CONVERSIONS_ENABLED`;
- `ADS_AUTOMATION_ENABLED`.

**Not yet proven [prod]:** the ads safety stop has never triggered in production (no evidence, shown as such).

Ads are **not required for the first paying customer**.

## 6. Remaining P0/P1

- **P0:** none found in code.
- **Launch-gating configuration:** Stripe live account and branding (step 4.1–4.4), and Resend verification plus
  `MESSAGES_LIVE` (without it, customers' leads get no confirmations or reminders).
- **P1:** merge and deploy PR #31 (cancel, noindex), then cancel the journey appointment. PR #30 (review accuracy)
  before relying on Business Review for go/no-go.

## 7. Time to first paying customer (estimate)

Engineering is about 1 day (approve, merge and deploy #30 and #31, live test). The critical path is external:
- Stripe live verification, typically 1–3 business days;
- Resend domain confirmation, same day.

**Realistic: 3–7 days after approvals**, plus sales time to close the first business.

## 8. Go / no-go

**Go when all hold:**
- #30 and #31 deployed, CI green;
- live $499 checkout recorded with `livemode: true`, reconciliation clean, refund done;
- customer-facing Stripe name is GetShowUps;
- Resend verified and a real confirmation plus reminder received at a test recipient, unsubscribe works;
- `MESSAGES_LIVE` approved and on;
- Business Review shows no open incidents for billing, calendar or messaging;
- rollback (1db27fd7, switches off) rehearsed.

**No-go if any of these:**
- checkout shows "sandbox" or "Flora Summit LLC sandbox";
- the webhook doesn't record a live event;
- confirmations are skipped for a real business;
- any open billing or calendar incident.
