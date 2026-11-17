# Paid launch runbook: first paying customer

Smallest safe paid launch: live Stripe billing for the existing founding plan, real emails, monitoring. Texting and Ads
stay off (not needed for launch). Every step marked (approval) needs the founder's explicit yes. Verified 2026-11-17.

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

1. Activate the live account (business details, bank account for payouts).
2. Product catalog → add product "GetShowUps Founding" → price **$499.00 USD, recurring, monthly**, lookup key
   `getshowups_monthly_499`. Copy the live price id (`price_…`).
3. Developers → Webhooks → add endpoint `https://getshowups.com/api/stripe/webhook`, select exactly the 6 events above.
   Copy its signing secret (`whsec_…`).
4. Settings → Billing → Customer portal (live): same settings as sandbox (cancel at period end, no proration, no plan
   switching, payment method + invoices on); set privacy policy `https://getshowups.com/privacy` and terms
   `https://getshowups.com/terms`.
5. Developers → API keys: the live secret key (`sk_live_…`), or a restricted key with Checkout Sessions, Customers,
   Subscriptions, Customer portal, Invoices (read) and Prices (read) access.

## 2. Activation (approval: live billing + production deploy), in this order

1. Store the live secrets the same way as Twilio (Keychain → pipe; never shown):
   ```
   security add-generic-password -a getshowups -s getshowups-stripe-live-secret-key -w
   security add-generic-password -a getshowups -s getshowups-stripe-live-webhook-secret -w
   security find-generic-password -a getshowups -s getshowups-stripe-live-secret-key -w | npx wrangler pages secret put STRIPE_SECRET_KEY --project-name getshowups
   security find-generic-password -a getshowups -s getshowups-stripe-live-webhook-secret -w | npx wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name getshowups
   printf 'true' | npx wrangler pages secret put STRIPE_LIVE_ENABLED --project-name getshowups
   ```
   Keep the sandbox key in Keychain to roll back.
2. Deploy production (secrets apply only to a new deployment).
3. Right after the deploy is live: /admin → Plans → `founding` → set the **live** price id (audited). Prices are saved by
   id only, so between steps 2 and 3 a checkout would fail (no customer is lost: they can retry).
4. /admin → Reconciliation → Run now: expect `ours_only` for the old sandbox subscriptions (see decision below), no
   other issues.

Rollback: put the sandbox key + sandbox webhook secret back, `STRIPE_LIVE_ENABLED` unset, plan back to the sandbox price,
redeploy. Live subscriptions created meanwhile stay in Stripe (refund/cancel there).

**Decision needed — toys-for-us:** a self-serve business (one member, not the founder) whose "active" subscription is a
SANDBOX subscription. Access does not depend on Stripe mode, so after live billing it keeps full access without paying,
and its billing portal will fail (its Stripe customer exists only in the sandbox). Options: (a) leave it as a free
founding pilot, (b) contact the owner to subscribe for real (the admin can then resync from Stripe), (c) if it was a
test, mark it as a test business. No code change until decided.

## 3. Controlled real-payment test (approval: a real charge)

- Business: a NEW, non-test business created by the founder through "Get started" (test businesses are refused live
  checkout by design), e.g. "GetShowUps Launch Check".
- Steps: Get started → pay $499 with the founder's own card → verify the webhook moved it to paid (onboarding unlocks;
  /admin shows a live subscription; audit `billing.payment_succeeded`) → connect Google Calendar → publish → book one
  appointment as a customer (founder's second email) → confirmation email arrives (needs §4) → Billing → portal →
  cancel → in Stripe Dashboard refund the $499 payment and cancel the subscription immediately → verify `canceled`
  recorded and access follows the rules → mark the business as a test business (keeps it out of metrics).
- Cost: $499 charged, refunded in full; **Stripe keeps its processing fee (~2.9% + $0.30 ≈ $14.77)**. Refund reaches the
  card in ~5–10 business days.
- Risks: forgetting to cancel → a second $499 next month (mitigated: cancel immediately in the Dashboard); the test
  business counts in metrics until marked as test.

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
