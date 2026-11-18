# Paid launch runbook: first paying customer

Smallest safe paid launch: live Stripe billing for the existing founding plan, real emails, monitoring. Texting and Ads
stay off (not needed for launch). Every step marked (approval) needs the founder's explicit yes. Verified 2026-11-17;
preconditions and effects updated 2026-11-18 after PRs #64–#68 (production 64d9d47, deployment c77c658d).

## 0. Preconditions (verified 2026-11-18)

- [x] Code in production: sandbox checkout gate (#63), "sign-up opens soon" (#64), go-live access rule (#65:
  `billingSubscription`, test-mode subscriptions are not paid once live), outbox closes held mail (#66).
- [x] Migration 0013 (`subscription_modes`) applied; webhook records live/test per subscription.
- [x] Production backup routine verified (latest: `prod-20261118T145816Z-pre-pr64-68.sql`).
- [x] Owner decision (2026-11-18): bob-electrical and toys-for-us are left unchanged (not marked test; ownership and
  intended use not verified). At go-live they see "test payment only, choose a plan" (table below).
- [ ] **#70 merged and deployed** (approval): a half-configured Stripe (live key without `STRIPE_LIVE_ENABLED`, or no
  webhook secret) currently lets new signups in UNBILLED, for good. #70 refuses them instead.
- [ ] **Terms of service page** (founder/legal, BLOCKER): `https://getshowups.com/terms` does not exist (it falls through
  to the marketing home page). Needed for the live portal and for a paid subscription offer: subscription terms,
  monthly renewal, cancellation at period end, refund policy. Claude does not write legal text; provide it and it can
  be published as a page.
- [ ] §1 done in the Stripe Dashboard (live account verified, live price, live webhook, live portal, retries, emails,
  live key). The connector here reaches the SANDBOX only, so none of the live settings are verified by Claude.
- [ ] A rollback window: the founder available for ~1 hour after activation.

## Review findings behind this checklist (read-only, 2026-11-18)

- **Entitlements:** access reads `billingSubscription` (onboarding payment step, readiness, billing card/portal, Ads
  live launch) and `hostingStatus(…, env)` (website, Studio, AI allowance, receptionist, assets). Test-mode
  subscriptions don't count once live; pilots/invited are never billed; test businesses never reach live Stripe.
- **Checkout recovery:** abandoned/expired checkout → still `incomplete`, retry resumes the open session or opens a new
  one on the SAME Stripe customer (idempotency key, Stripe asked first); return page polls "Confirming your payment…"
  until the webhook lands; `?billing=canceled` shows a plain message; other errors say "try again".
- **Webhooks:** signature + 5-minute tolerance; idempotent per event id; older events ignored (`last_event_at`); storage
  errors return 500 so Stripe retries; live events refused (400) until `STRIPE_LIVE_ENABLED=true`.
- **Cancellation:** portal cancels at period end (`cancel_at` recorded as scheduled); `deleted` → `canceled`; site stays
  up until period end + 14 days; 90-day recovery; nothing deleted.
- **Duplicates:** one Stripe customer per business (idempotency key; live replacement uses `-live`), Stripe asked for
  an existing subscription before every checkout (`use_portal`), open sessions resumed.
- **Customer-facing errors:** plan step: specific ("Confirming your payment…", "sign-up isn't open", "try again");
  dashboard billing card: one generic "Billing is unavailable right now" for every error (P2 polish, not a blocker).
- **Gap fixed in #70 (not deployed):** half-configured Stripe → free unbilled signups.
- **Retries gap (Stripe setting, BLOCKER):** our code treats `past_due`/`unpaid` as still hosted (no automatic
  lock-out). If Stripe is set to leave a subscription past-due after all retries fail, an unpaying business stays
  hosted indefinitely. Set Stripe to **cancel the subscription** after the final retry (§1.6): the site then follows
  the 14-day grace and 90-day recovery rules.
- **Activation changes no stored data:** the switch writes no rows. Websites (onboarded businesses stay hosted;
  renderer unchanged), appointments, leads and settings are untouched. Daily reconciliation only reads Stripe (it
  will report the sandbox rows as `ours_only`; it never fixes anything). Ads holds, recovery and deletion read stored
  status or are off. The only writes come later from real events: live webhooks, and an owner choosing the plan
  (sandbox record replaced, audited).

## What changes for existing businesses at go-live (code in production since 2026-11-18)

| Business | Subscription today | After STRIPE_LIVE_ENABLED=true |
| --- | --- | --- |
| poolthru-llc | none (pilot; an old `incomplete` placeholder) | unchanged: never billed, never asked to pay |
| gsu-stripe-test-pools, gsu-journey-test | sandbox, admin-marked TEST | unchanged: keep sandbox access; never reach live Stripe |
| bob-electrical | sandbox `active` (test mode recorded) | shown as "test payment only, choose a plan"; site stays up (onboarded); Ads live launch and billing portal refused until a real subscription |
| toys-for-us | sandbox `active` (mode never recorded → treated as test) | same as bob-electrical |

Nobody is charged by the switch. An owner who chooses the plan gets a NEW live Stripe customer (audited
`billing.sandbox_replaced`); their sandbox data stays in Stripe test mode. Alternatives per business (each an approval):
mark as a test business (keeps sandbox access, out of metrics) or leave as above.

## Current configuration (verified read-only)

- Plan `founding` ("GetShowUps Founding"), active, trial 0 days → Stripe price `price_1Ua3o8…dT6` (SANDBOX):
  **$499.00 USD, recurring monthly (interval 1 month), per unit**, lookup key `getshowups_monthly_499`, product `getshowups`.
- Sandbox webhook `https://getshowups.com/api/stripe/webhook`, events: `checkout.session.completed`,
  `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
  `invoice.payment_failed` (exactly the events server/stripe.js handles).
- Sandbox customer portal: cancel **at period end**, no proration, cancellation reasons on, plan switching off, pause
  off, payment method + invoice history on. No privacy/terms URLs set.
- Production: `STRIPE_SECRET_KEY` is a test key (`stripeMode: test_key`), `STRIPE_LIVE_ENABLED` unset. Live-mode
  webhook events are refused (400) until it is `true`; test businesses can never reach live Stripe.

## 1. Stripe live account (founder, Stripe Dashboard in LIVE mode)

1. **Account:** activate live payments (business details, identity, bank account for payouts). Confirm the Dashboard
   shows payments AND payouts enabled, and set the statement descriptor (e.g. `GETSHOWUPS`) and support email/phone.
2. **Price:** Product catalog → product "GetShowUps Founding" → price **$499.00 USD, recurring, monthly**, lookup key
   `getshowups_monthly_499`. Decide tax behavior (see Tax) before creating it: a price's tax behavior can't be changed
   later. Copy the live price id (`price_…`).
3. **Webhook:** Developers → Webhooks → add endpoint `https://getshowups.com/api/stripe/webhook`, exactly these 6 events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its signing secret (`whsec_…`).
4. **Customer portal (live):** cancel at period end, no proration, cancellation reasons on, plan switching off, pause
   off, payment method + invoice history on (same as sandbox); privacy `https://getshowups.com/privacy`; terms
   `https://getshowups.com/terms` only once that page exists (precondition).
5. **Customer emails:** Settings → Emails: turn on receipts for successful payments and emails for failed payments /
   expiring cards (our own payment-recovery email also goes out once MESSAGES_LIVE is on).
6. **Retries (Revenue recovery):** Smart Retries on; after all retries fail → **cancel the subscription** (see review
   finding). Not "leave past-due".
7. **API key:** a restricted live key with write access to Checkout Sessions, Customers, Subscriptions (cancel is used
   by account deletion), Customer portal sessions; read access to Invoices and Prices. Or the standard `sk_live_…`.
8. **Leave the sandbox webhook enabled** (needed for rollback). After the switch it will get 400s (wrong secret) for
   sandbox renewals of the two sandbox subscriptions; harmless, and Stripe sandbox may email about failing deliveries.

## 2. Activation (approval: live billing + production deploy), in this order

0. #70 is in production (precondition). Take a backup (`wrangler d1 export … --remote`, integrity check).
1. Store the live secrets the same way as Twilio (Keychain → pipe; never shown). Set ALL THREE before deploying (never
   deploy between them):
   ```
   security add-generic-password -a getshowups -s getshowups-stripe-live-secret-key -w
   security add-generic-password -a getshowups -s getshowups-stripe-live-webhook-secret -w
   security find-generic-password -a getshowups -s getshowups-stripe-live-secret-key -w | npx wrangler pages secret put STRIPE_SECRET_KEY --project-name getshowups
   security find-generic-password -a getshowups -s getshowups-stripe-live-webhook-secret -w | npx wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name getshowups
   printf 'true' | npx wrangler pages secret put STRIPE_LIVE_ENABLED --project-name getshowups
   ```
   Keep the sandbox key in Keychain to roll back.
2. /admin → Plans → `founding` → set the **live** price id (audited) immediately BEFORE the deploy. Until the deploy,
   only authorized testers can check out (sandbox) and theirs would fail for those minutes; nobody else can buy.
3. Deploy production (secrets apply only to a new deployment): Cloudflare dashboard → Pages → getshowups → latest
   production deployment → Retry deployment (same commit, new secrets).
4. Smoke checks (below). /admin → Reconciliation → Run now: expect `ours_only` for the sandbox rows only.

**Rollback** (≈5 minutes, no data loss): put the sandbox key + sandbox webhook secret back from Keychain, set
`STRIPE_LIVE_ENABLED` to anything but `true` (or delete it), plan back to the sandbox price id, retry the deployment.
Self-serve sign-up closes again ("opens soon") for non-testers. Live customers/subscriptions created meanwhile stay in
Stripe: refund/cancel them in the live Dashboard; their rows stay recorded as live and are reconciled later.

**Superseded (2026-11-18):** the toys-for-us note that sandbox subscriptions keep full access no longer applies: since
#65 they count as not paid under live billing (table above). The decision left is per business: leave, or mark as test.

### Smoke checks right after activation (read-only unless noted)

1. `https://getshowups.com/build.json` shows the new deployment; `/`, `/dashboard`, `/p/poolthru-llc` → 200.
2. A signed-in non-tester account: the first setup step shows the business-name form (no "Online sign-up opens soon");
   `/api/dashboard/me` → `checkoutOpen: true`.
3. /admin → Plans: `founding` points at the LIVE price id.
4. /admin → Reconciliation → Run now: only the expected sandbox rows differ; no live mismatches.
5. Stripe Dashboard (live) → Webhooks → endpoint shows no failed deliveries after §3's payment.
6. Logs (`wrangler pages deployment tail`): no `livemode_not_enabled`, no 5xx on `/api/stripe/webhook`.

### Stop and roll back if

A live checkout fails for a reason other than the owner abandoning it; a webhook is refused or 5xx; an existing
business loses its website; or any charge happens that nobody started.

## 3. Controlled real-payment test (approval: a real charge)

Run right after activation, inside the rollback window.

- **Account:** a separate Google account of the founder's that is NOT a platform admin (admin accounts are sent to
  /admin) and a NEW business, e.g. "GetShowUps Launch Check". Not a test business (those can't reach live Stripe).
- **Steps and what to verify:**
  1. getshowups.com → Get started → sign in → business name → plan step shows "Start your founding plan".
  2. Pay $499 with the founder's own card. Return page: "Confirming your payment…" then onboarding continues.
  3. Stripe live Dashboard → Webhooks → endpoint: `checkout.session.completed`, `customer.subscription.created`,
     `invoice.paid` delivered with 200 (no retries).
  4. /admin → the business shows Paying / live subscription; audit log has `billing.subscription_status`
     (incomplete → active, `livemode: true`) and `billing.payment_succeeded`. Revenue metrics now count it (live mode).
  5. Dashboard → Settings → Plan: "Active · Renews <date>"; Manage billing opens the live portal.
  6. Portal → cancel → webhook `customer.subscription.updated` → dashboard says it ends at period end (`cancel_at`).
  7. Stripe Dashboard → the payment → Refund $499 (full) → then the subscription → Cancel immediately. Webhook
     `customer.subscription.deleted` → status `canceled`; site stays up 14 days after the period end.
  8. /admin → mark the business as a test business (audited) so it leaves metrics. Do this AFTER step 7 (a test
     business is refused live Stripe actions from our side).
- **Expected cost:** card processing 2.9% + $0.30 = **$14.77** on $499 (US card, standard pricing; +1.5% for an
  international card), not returned on refund (Stripe docs). A refund issued shortly after the charge can be processed
  as a reversal, for which Stripe withholds no fees, so the actual cost may be lower. If the account is on
  pay-as-you-go Stripe Billing pricing, a Billing fee on the invoice may also apply (confirm the rate on the account's
  pricing page; not verified here). No Stripe Tax fee (automatic tax is not enabled). Refund reaches the card in ~5–10
  business days.
- **Rollback / abort:** if any step fails, stop, refund and cancel in the Dashboard, then decide whether to roll back
  activation (§2). Risk: forgetting to cancel → $499 again next month (step 7 cancels immediately).

## Tax (decision before broad paid launch; not a blocker for the controlled test)

- Today: checkout does NOT enable Stripe automatic tax; the sandbox price's tax behavior is `unspecified`; Stripe Tax
  isn't set up (head office missing in the sandbox). So $499 is charged with no sales tax added.
- Whether GetShowUps owes sales tax depends on where Flora Summit LLC and its customers are and how each state treats
  SaaS/marketing services: a question for the accountant, not something the code can decide.
- If tax must be collected: set the head office and registrations in Stripe Tax, choose price tax behavior (exclusive:
  tax added on top; inclusive: inside $499), then a small code change (`automatic_tax[enabled]=true` plus
  address collection in Checkout). Stripe Tax monitors registration thresholds at no charge.

## 4. Email delivery (approvals: none for the controlled test; MESSAGES_LIVE for real customers)

- Controlled test, no global switch: book on the test business `gsu-journey-test` with an address listed in
  `MESSAGE_TEST_RECIPIENTS`; the confirmation arrives within one scheduler run. A test business only ever emails test
  recipients. Cost $0 (Resend). Sending domain records are in place (SPF on send.getshowups.com, DKIM
  resend._domainkey, DMARC p=none).
- `MESSAGES_LIVE=true` (approval): from then on real customers of PoolThru and toys-for-us get confirmations, reminders and
  follow-ups. Messages skipped while it was off are never sent later (no burst). Today 0 real customer messages are
  pending.

## 5. Monitoring (founder, Cloudflare dashboard)

Cloudflare docs (2026-10/11): Alerts → Platform Notifications → Create a Notification; delivery email/webhook.
1. **Pages → "Project updates"** (all plans): project `getshowups`, events **Deployment failed** (and Deployment success
   if wanted) → email.
2. **"Incident Alerts"** and **"Maintenance Notification"** (all plans) → email (Cloudflare-side outages).
3. **Workers → getshowups-scheduler → Observability → Issues → Enable issues** (open beta, free): records uncaught
   exceptions, failed invocations, 5xx and logged errors; add an automation to a webhook/chat if wanted (email is not a
   listed target).
4. Not available on our plan per the docs: Health Checks (Pro+), error-rate alerts (Enterprise), usage-based billing
   alerts (Pro+, pay-as-you-go).

Residual gap: nothing PUSHES an alert if the scheduler silently stops. /admin → Business Review marks the scheduler stale
when the daily audit checkpoint is older than 2 days; check it daily during launch week.
