# Business account types: internal live, admin sandbox, paying customer

Migration 0034 (`business_accounts`), server/business-accounts.js, `/api/platform/account`, Admin → customer →
"Account type" and Admin → Platform → "Create an internal or sandbox business". Built 2026-11-22 so GetShowUps can
run its own businesses (PoolThru first) without paying itself a subscription, with the test/sandbox world kept apart.

## Four concepts, kept apart

| Concept | Where | Values |
| --- | --- | --- |
| Classification (who owns it) | `business_accounts.classification` | `internal_live`, `sandbox`, `customer` (no row = customer) |
| Billing entitlement | `business_accounts.billing` | `complimentary` (no checkout, no subscription needed), `stripe` |
| Operating environment | `business_accounts.environment` + the existing `test_businesses` mark | `production`, `sandbox` |
| Customer-facing paid providers | `business_accounts.provider_spend` | `allowed`, `blocked` |
| Feature permissions | unchanged: release switches, plan entitlements, per-business allowlists | |

The classification sets the defaults (internal live = complimentary + production + spend allowed; sandbox =
complimentary + sandbox + spend blocked; customer = stripe + production + allowed). The only per-business choice on
top is `provider_spend` (e.g. an approved paid test on a sandbox). No hardcoded names or emails: PoolThru is internal
live because its row says so.

## What the entitlement changes (all server-side)

| Decision | Complimentary account |
| --- | --- |
| Hosting (`hostingStatus`) | `active`, whatever Stripe says |
| Checkout (`createCheckout`, owner billing route) | refused (`complimentary` / 409 `not_billed`); the owner's Plan card says "Complimentary GetShowUps account" |
| Onboarding steps | the legacy path (no payment step), even with a `self_signups` row |
| Ads safety stop (`adsHold`) | never a billing hold; suspension and deletion holds still apply |
| Lifecycle | stage `complimentary`; no 90-day recovery logic |
| Billing reconciliation | report only; the one automatic resync (`applied`) is skipped with `complimentary_account` |
| Metrics (`growth`) | never counted in paying customers, MRR, ARR or test-subscription counts |
| Deletion | the row is erased with the business (`ERASED_TABLES`) |

`provider_spend: blocked` turns off the PUBLIC receptionist (chat info route reports `enabled: false`; the voice route
answers `receptionist_off`) and makes `liveFor()` false (no live ad creation or Start). Admin Voice Lab sessions are
gated by the Lab itself (admin, test business, dry run, limits), not by this flag.

Sandbox businesses are also marked in `test_businesses` (set when classified; unmarked when moved to production,
which never promotes sandbox-era data), so every existing safeguard applies: Google Ads test accounts only, messages
only to `MESSAGE_TEST_RECIPIENTS`, no live Stripe, excluded from every platform metric, public sites `noindex`.

## Authorization and audit

Only platform admins (`PLATFORM_ADMIN_EMAILS`, checked server-side by `requirePlatformAdmin`) can read or change
account types; every change is same-origin, explicitly confirmed, and written once to `admin_audit` and the
permanent `audit_log` (`account.classify` / `account.create` with from → to, billing, environment, provider spend,
test mark, reason). Customer users have no route to these fields. A business with a LIVE Stripe subscription still
running cannot be moved away from "paying customer" (`live_subscription_running`): nothing is ever cancelled or
refunded automatically; the admin ends it in Stripe first. Stripe records are never modified by a classification.

## PoolThru (poolthru-llc), migrated in place

Production records (read-only, 2026-11-22): active; created via the legacy self-serve path; one owner; no
`self_signups` row (so it was already exempt by absence); `subscriptions` row `incomplete` with a Stripe test-mode
customer and NO subscription id (a checkout that was opened and never paid); no `subscription_modes` row; not a test
business; website live (version 13) on www.poolthru.com (`website_domains` row `securing`: verified and attached,
certificate not yet reported active); 6 leads, 3 appointments, 5 conversations; receptionist on; calendar connected.

Migration = one audited classification, nothing else: Admin → Customers → PoolThru → Account type → "Internal live"
(reason: GetShowUps-owned operating business). Identity, owner, domain, website, calendar, booking URLs, leads,
conversations, receptionist settings, services, hours and attribution are untouched. The Stripe test customer and the
`incomplete` placeholder stay as they are (no automatic cancellation or refund; nothing is owed: no subscription,
no invoice, no renewal). Equivalent statement, if done in D1 instead of the console (approval; the console path is
preferred because it audits):

```
INSERT INTO business_accounts (customer, classification, billing, environment, provider_spend, note, set_by, set_at)
VALUES ('poolthru-llc', 'internal_live', 'complimentary', 'production', 'allowed', 'GetShowUps-owned operating business', 'brandon@getshowups.com', <now ms>);
```

## Creating businesses

Admin → Platform → "Create an internal or sandbox business": name, type, optional owner email (must not already own
a business: `customer_users.email` is unique), reason. Uses the ordinary creation path with no `self_signups` row
(never a payment step) and classifies the new business in the same request. Several sandboxes can exist without any
subscription. An owner can be linked later (invitations / the admin customers route).

## Activation

1. Apply `migrations/0034_business_accounts.sql` to production (approval). Until then: every read says "customer",
   every write answers `migration_required`, and the console says so; nothing else changes.
2. Deploy (merged PR). 3. Classify PoolThru from the console (audited). 4. Business Review → PoolThru shows
   lifecycle `complimentary`; the owner's dashboard Plan card shows "Complimentary GetShowUps account".
