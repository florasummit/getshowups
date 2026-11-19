# Launch checklist: remaining external requirements (2026-11-18)

One page, in dependency order. Every item is an **owner action or approval**; engineering never does these alone.
Detailed runbooks are linked; this page is the order and the gates. Status as of main `a9a334e` (production
deployment `96cd945a`, code `dcdcb56`). Nothing below has been switched on.

Legend: ☐ to do · ⛔ blocked by an earlier item · ✅ done

## A. Legal (blocks paid launch)

| # | Item | Who | Depends on | Output |
| --- | --- | --- | --- | --- |
| A1 | ☐ Fill every **[DECISION]** in docs/legal/TERMS_DRAFT.md: legal entity + state; keep "no free trial"; tax wording (from B); price-change notice (30 days?); refund policy (option A/B/C); retention after the 90-day recovery; DPA offered or not; terms-change notice; governing law, venue/arbitration, class-action waiver; support address | Owner | B1 for the tax line | Completed draft |
| A2 | ☐ Fill **[DECISION]**/**[VERIFY]** in docs/legal/PRIVACY_DRAFT.md: entity; privacy/support address (not a personal one); billing-record retention (7 years?); backup expiry (30 days?); Meta/GHL enabled at publication?; provider no-training/retention terms cited | Owner (+ provider terms) | — | Completed draft |
| A3 | ☐ Attorney review of both (CCPA/CPRA and state law, liability, arbitration) | Attorney | A1, A2 | Final wording |
| A4 | ☐ Approve publication; then engineering adds `/terms` and updates `/privacy` (one PR, owner-approved text only) | Owner → engineering | A3 | Live pages |
| A5 | ☐ Add the terms URL to the live Stripe customer portal (C4) | Owner | A4 | — |

## B. Sales tax (blocks the live $499 price — owner decision 2026-11-18)

**Do not create or activate the live $499 price until B1–B3 are confirmed.** A Stripe price's tax behaviour cannot be
changed after creation, so a price made too early would have to be replaced.

| # | Item | Who | Output |
| --- | --- | --- | --- |
| B1 | ☐ Accountant: does GetShowUps owe sales tax on the $499/month service, and where (home state + states of customers; how each treats SaaS / marketing services)? | Accountant | Written answer |
| B2 | ☐ Decide the jurisdictions to register in now, and whether to use Stripe Tax monitoring for thresholds | Owner + accountant | List of registrations |
| B3 | ☐ Confirm **tax-exclusive** pricing ($499 + tax where due) | Owner | Decision |
| B4 | ☐ If tax is collected: Stripe Tax head office + registrations (live), and an engineering PR: `automatic_tax[enabled]=true` + billing-address collection in Checkout, tests, docs (no deploy before C-activation approval) | Owner (Stripe) + engineering | PR ready |
| B5 | ☐ Then create the live price: $499.00 USD monthly, lookup `getshowups_monthly_499`, tax behaviour **exclusive** | Owner | live `price_…` |

## C. Stripe live mode (runbook: docs/PAID_LAUNCH.md §1–3)

| # | Item | Depends on |
| --- | --- | --- |
| C1 | ☐ Activate live payments: business details, identity, payout bank; statement descriptor `GETSHOWUPS`; support email | A2 (support address) |
| C2 | ⛔ Live price (= B5) | B1–B4 |
| C3 | ☐ Live webhook `https://getshowups.com/api/stripe/webhook`, exactly 6 events (list in PAID_LAUNCH §1.3); keep the sandbox webhook | — |
| C4 | ☐ Live customer portal: cancel at period end, no proration, reasons on; privacy URL; terms URL only after A4 | A4 for terms |
| C5 | ☐ Customer emails: successful-payment receipts, failed-payment and expiring-card emails | — |
| C6 | ☐ Revenue recovery: Smart Retries; after the final retry → **cancel the subscription** (reconciliation #72 applies it even if a webhook is lost) | — |
| C7 | ☐ Restricted live key, exactly: Checkout Sessions W, Customers W, Subscriptions W, Customer portal W, Invoices R, everything else None | — |
| C8 | ⛔ Approval: activation (backup → 3 secrets + `STRIPE_LIVE_ENABLED=true` → one deploy → smoke checks; rollback ≈5 min) | A4, B, C1–C7 |
| C9 | ⛔ Approval: controlled $499 charge-and-refund test (PAID_LAUNCH §3; fees ≈$14.77, possibly $0 if reversed) | C8 |

## D. Messaging (runbooks: docs/PAID_LAUNCH.md §4, docs/TEXTING_ACTIVATION.md, docs/A2P_REGISTRATION.md)

| # | Item | Approval |
| --- | --- | --- |
| D1 | ☐ Email test on the test business with a `MESSAGE_TEST_RECIPIENTS` address (no switch needed, $0) | none (test only) |
| D2 | ☐ `MESSAGES_LIVE=true`: real customers get confirmations, reminders, follow-ups; nothing skipped earlier is sent later | **yes** |
| D3 | ☐ Texting: Twilio parent account upgrade (paid) + Primary Customer Profile "ISV Reseller or Partner" (Console) | **yes** (paid, legal attestation) |
| D4 | ☐ Twilio secrets in Cloudflare (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PRIMARY_PROFILE_SID`, `TWILIO_PROFILE_EMAIL`) | **yes** (secrets) |
| D5 | ☐ Per business: owner approves submission → admin runs registration steps; `TWILIO_REGISTRATION_SUBMIT=true` for paid steps | **yes** (fees) |
| D6 | ☐ `SMS_LIVE=true` only after a campaign is VERIFIED by Twilio; `FOLLOWUP_AI` separately | **yes** |
| D7 | Booking-page and website copy keep promising no messages until D2/D6 are on (Phase 1 starter already complies) | — |

## E. AI receptionist voice (runbook: docs/RECEPTIONIST.md "Activation")

| # | Item | Approval |
| --- | --- | --- |
| E1 | ☐ Retell account + Custom LLM agent (`scripts/retell-setup.mjs`), `RETELL_WS_SECRET`, API key in Keychain | **yes** (paid usage ≈$0.07–0.15/min) |
| E2 | ☐ Personal live voice test on a test business (browser voice), transcript reviewed | **yes** |
| E3 | Phone numbers / forwarding / transfers are NOT provisioned; no claims of them anywhere | — |

## F. Google Ads (runbook: docs/GOOGLE_ADS_COMPLIANCE.md)

Today the Cloud project is at **Test** level (production calls return `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`).

| # | Item | Approval |
| --- | --- | --- |
| F1 | ☐ Apply for **Explorer** access (Google Ads API overview in Cloud Console) | **yes** (external) |
| F2 | ☐ Policy confirmation of the multi-tenant model (open item 1 in the doc) | recommended before spend |
| F3 | ☐ OAuth verification for the `adwords` scope if not already verified | **yes** |
| F4 | ☐ The pilot business sets up its own Google Ads billing (Google collects; we never handle it) | owner of that business |
| F5 | ☐ `ADS_LIVE_LAUNCH=true` and an owner budget approval per business | **yes** (spend) |
| F6 | Conversion upload (Data Manager API, sensitive scope) stays off until separately approved | **yes** |

## G. Real-person onboarding run (not done yet)

Goal: one person who has never seen GetShowUps goes from sign-up to a published site and a test booking, timed.

| # | Item | Notes |
| --- | --- | --- |
| G1 | ☐ Pick the tester and a business they can describe honestly (or a clearly fictional one, marked test afterwards) | Never a real customer's business |
| G2 | ☐ Allow their sign-up while billing is sandbox: add their email to `MESSAGE_TEST_RECIPIENTS` (config change, **approval**) — without it the plan step correctly says sign-up isn't open | — |
| G3 | ☐ Session: sign up → (sandbox checkout with a test card) → onboarding → "I'm starting fresh" website → publish → book a time on their own page. Observer notes time per step and every hesitation; no help unless stuck >2 min | Screen recording with consent |
| G4 | ☐ Admin marks the business as test; Ads/messaging stay test-only | audited |
| G5 | ☐ Write up: total time, drop-off points, copy that confused them → fixes as small PRs | — |

## H. Engineering items that need approval to release

- ☑ PR #76 Website Studio Phase 1 — merged and deployed 2026-11-19 (126dcba, deployment c5258264); existing sites
  byte-identical. Includes "Online booking hours" and text-led HVAC starters.
- ☑ PR #77 photo candidates (docs) — approved 2026-11-19; the import itself is a later phase (needs approval).
- ☑ This checklist (docs, #78) — approved 2026-11-19.
- ☐ Sales-tax decision (section B) — decision-ready analysis in a separate docs PR (docs/SALES_TAX_ANALYSIS.md); needs the accountant's answers.
