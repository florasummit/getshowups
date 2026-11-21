# Launch decision: first paying customer (2026-11-21)

Evidence-based readiness assessment on main `6ef80ac` (production deployment `27fce346`). Evidence tags are the
ones used in docs/LAUNCH_READINESS.md (2026-11-19), which this page supersedes for the launch decision:

| Tag | Meaning |
| --- | --- |
| **LIVE** | Seen working in production (read-only checks this day, or a dated production record) |
| **SANDBOX** | Exercised against a provider's test mode (Stripe sandbox, Google Ads test account) |
| **MOCKED** | Exercised by our tests with the provider mocked (unit tests; Playwright on local workerd with the real Functions) |
| **BUILT** | Code exists, not exercised end to end |
| **OFF** | Built and switched off by a release switch (approval to turn on) |
| **BLOCKED** | Needs an external party or an owner decision |

Nothing below was switched on, charged, sent, launched, migrated or changed in production. The only production
activity was read-only HTTP checks.

## 1. Decision

| Launch mode | Decision | Why |
| --- | --- | --- |
| **A. Owner-operated pilot** (founder onboards a few customers by hand, unbilled or invoiced outside the product) | **GO, with conditions** | The promised core (hosted website, online booking into Google Calendar, service-area screening, Google invitations, show-up tracking) is LIVE and the full new-customer path is proven MOCKED end to end, including interruptions, failures, duplicate-payment refusal, booking conflicts and cross-business access. Conditions: founder present at the Calendar step (Google's "unverified app" screen), founder alerts switched on (approval), support mailbox monitored. |
| **B. Self-serve paid launch** (a stranger pays $499 and onboards alone) | **NO-GO** | Online sign-up is closed by design until live billing exists. Live billing is blocked on owner/external items, none of them engineering: terms of service page, refund/tax wording, accountant's sales-tax answer, Stripe live account settings, and Google's sensitive-scope verification. See §5. |
| **C. Not ready** | Does not apply | No P0 defect was found in the product itself. |

**Single highest-value next action:** run the first owner-operated pilot customer this week using the checklist in
§7, while the owner clears the non-engineering blockers in §5 in parallel. Revenue does not need to wait for
self-serve.

## 2. Capability matrix (what GetShowUps can actually deliver today)

| Capability | State | Evidence | Note |
| --- | --- | --- | --- |
| Homepage, offer, pricing ($499/month, no trial, ad spend separate) | LIVE | getshowups.com (deployment 27fce346); copy in src/content/site.js | Honest: no testimonials, "coming soon" for email/text/ads |
| Early access (Request early access → Google Calendar appointment page) | LIVE | `/api/enrollment` → `{"open":false}`; the appointment schedule loads (HTTP 200, "Get Show Ups - Free Demo") | Inquiries land on the founder's Google Calendar, not in the product (§6) |
| Google sign-in, sessions (7 days), sign-out, safe return links | LIVE | production 401s signed out; auth tests; journey spec | Google-only; no password recovery needed |
| New customer business creation | LIVE for testers/admins · **closed for strangers (by design)** | `signup_not_open` before anything is created; journey spec "stranger" case | Opens with STRIPE_LIVE_ENABLED |
| Stripe checkout, webhook, duplicate prevention, portal cancellation | SANDBOX + MOCKED | selfserve.spec, journey.spec (declined card, resume, 409 use_portal, replayed webhook) | Live mode never exercised; live webhook/portal/price not created (owner) |
| Access entitlements (paid → onboarding; sandbox subscriptions stop counting at go-live) | MOCKED | onboarding/enrollment tests; PAID_LAUNCH.md table | — |
| Guided onboarding (plan → details → services → calendar → hours → website → address → publish → launch) | LIVE (pilots) + MOCKED (new) | journey.spec: every step discovered from state, resumes after sign-out | No manual database step needed |
| Google Calendar connection, free/busy, event creation | LIVE | bookings on Calendar (2026-11-18); mocked OAuth in tests | **Google verification of sensitive scopes pending**: unverified-app screen, 100-user cap |
| Public booking page: details → ZIP screening → real open times → booked, double-booking guard | LIVE | PoolThru booking endpoint healthy (144 slots); journey.spec conflicts/invalid/forged/cross-site cases | — |
| Owner dashboard: upcoming, outcomes, cancellation, settings, help link | LIVE | app/modes specs; journey.spec owner visibility | — |
| Hosted website (starter, AI designs, Studio, own domain) | LIVE | PoolThru 5 pages byte-identical after every deploy; 12 render goldens | — |
| Email confirmations, reminders, follow-ups | OFF (test recipients only) | `MESSAGES_LIVE` unset | Not promised on the site ("coming soon") |
| Owner notices (new booking / unbooked lead) by email | OFF (same gate) | server/notify.js | Owner sees them on the dashboard |
| Text messages | OFF | no Twilio subaccounts, SMS_LIVE unset | Not promised |
| Founder alerts (calendar broken, booking page without times, delivery failures) | OFF | FOUNDER_ALERTS_ENABLED absent (verified 2026-11-20) | **Should be on for any pilot** (approval) |
| AI receptionist chat | BUILT, per-business opt-in, real model | /chat/poolthru-llc 200 | Not advertised; reliability unproven with customers |
| AI receptionist voice | OFF except poolthru-llc, bob-electrical | RECEPTIONIST_VOICE_BUSINESSES | Beta; owner decision 2026-11-19 |
| Teach Your AI | gated: editing for poolthru-llc only; live rules for nobody | AI_STUDIO_BUSINESSES / AI_RULES_LIVE_BUSINESSES | Awaiting founder review |
| Google Ads | SANDBOX (test account), Cloud project at Test level | ADS_ENABLED + allowlist, ADS_LIVE_LAUNCH unset | Explorer access + policy items before any spend |
| Meta ads | BUILT / OFF | mocked tests | App review |
| Attribution (campaign → lead → booking) | BUILT + MOCKED | server/ads/funnel.js | Real data only after ads run |
| Control Center, incidents, Business Review, audit log | LIVE | /api/platform/* 401 signed out; release records | — |
| Account deletion, retention | OFF | ACCOUNT_DELETION_ENABLED absent | Policy approval |

## 3. Autonomous customer journey test (MOCKED; test/e2e/journey.js + journey.spec.js)

A state-aware runner reads the real backend (`/api/dashboard/me`, `/calendar`, `/api/book/:id`), names the next
step, performs it with fixture identities (listed testers, mock Google, local Stripe stand-in with signed webhooks),
waits for the backend state to move, and diagnoses any step that changes nothing. Trace on desktop and phone:

```
sign_in → create_business → setup_payment → setup_details → [sign-out, sign back in: resumes at setup_details]
→ setup_services → setup_calendar → setup_hours → [public page 404 until here] → setup_website → setup_address
→ setup_publish → setup_launch → ready (bookable, 120 open times)
→ [Google revokes the grant] calendar_reconnect → [new grant] ready
```

Also verified in the same run: duplicate checkout refused (409 `use_portal`); Ads and Teach Your AI 404 for a
non-allowlisted business; invalid ZIP / missing name / honeypot / forged lead token / cross-site requests refused;
a real booking lands on the (mock) calendar and in the owner's dashboard; the same slot and a never-offered time are
refused (409 `slot_unavailable`); another business's owner sees nothing and cannot cancel it; signed-out and
cross-site requests refused; during the revoked grant the public page offers no times, the owner's Settings says
"Needs reconnecting", the founder's live check reports `reconnect_required`, and a customer is told booking is
unavailable while their request is still saved; a returning customer lands straight on the dashboard; the founder
console lists the business as live, paid, with one booking and no attention flags. A stranger (not a tester) is
stopped at `create_business` with "Online sign-up opens soon" and nothing created.

**Exact blocked point for a real visitor today:** `create_business` (`checkoutOpen: false`): the product refuses to
create a business that could never pay. This is the designed state until live billing (§5), not a defect.

What this does NOT prove: live Stripe, live email/SMS, live AI, real advertising, Google's consent screen.

## 4. Problems found, ranked

| # | Priority | Problem | Impact | Root cause | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | **P1** | After signing out (or a 7-day session expiry), a customer who first arrived via the sign-up link saw "Online enrollment isn't open yet" with "Book a call" as the primary button | An existing paying customer could believe they were locked out; sign-in was demoted to a quiet button | The remembered sign-up plan (`localStorage` `gsu_plan`) was never cleared once a business existed | **Fixed** (src/dashboard/Dashboard.jsx; journey.spec covers it) |
| 2 | **P1** | Booking page showed "No open times right now" when the business's calendar connection was broken, the same words as a full calendar | A customer gives up; the owner and founder don't learn from the customer | Page did not distinguish `status: 'unavailable'` | **Fixed** (src/booking/BookingPage.jsx: "Online booking isn't available right now"; request still saved; journey.spec covers it) |
| 3 | **P1** | Failures are visible only if someone looks: founder alerts are built but OFF | A pilot customer can silently stop receiving bookings | FOUNDER_ALERTS_ENABLED not set; founder not in MESSAGE_TEST_RECIPIENTS | **Owner approval** (docs/OPERATIONAL_ACTIVATION.md §5 items 6–7) |
| 4 | **P1** (paid launch) | No `/terms` page, no refund/tax wording at checkout, no terms URL in the Stripe portal | Cannot offer a paid subscription compliantly | Legal drafts awaiting owner [DECISION]s and attorney review | **Owner/attorney** (LAUNCH_CHECKLIST A) |
| 5 | **P1** (paid launch) | Sales-tax treatment undecided; live price must not be created before it | Blocks the live $499 price | Accountant answer outstanding | **Owner/accountant** (LAUNCH_CHECKLIST B) |
| 6 | **P1** (trust) | Google sensitive-scope verification pending: customers see "Google hasn't verified this app" at the Calendar step | Drop-off at the most important step; 100-user cap | External review | **Owner** checks Cloud Console status; founder walks pilots through it meanwhile |
| 7 | **P2** | An expired session while using the dashboard shows generic errors instead of returning to sign-in | Confusion until the page is reloaded | `api()` has no 401 handling after the initial load | Follow-up (needs loop-safe handling) |
| 8 | **P2** | Early-access inquiries live only in the founder's Google Calendar; the product has no record or count of them | Funnel stage "inquiries" not measurable in the product | Appointment-schedule embed by design (no form, no data stored) | Acceptable for pilot; later: a lead row per booked call (approval: stores personal data) |
| 9 | **P2** | Platform-level acquisition funnel (sign-ins without a business, checkout starts, published sites) is not shown in /admin | Owner computes it by hand from events | Growth metrics cover customers/activated/first-booked/leads/outcomes, not the pre-signup stages | Follow-up (counts only, no personal data) |
| 10 | **P3** | Owners cannot invite a teammate themselves (admin-issued invitations only) | Founder does it on request | Scope | Later |

No P0 was found: no path lets a customer pay without access, book twice, see another business's data, or skip a
required setup step.

## 5. Remaining owner approvals (nothing here is engineering)

1. Founder alerts on: add the founder's address to `MESSAGE_TEST_RECIPIENTS`, set `FOUNDER_ALERTS_ENABLED=true`,
   redeploy, press "Send test alert" (OPERATIONAL_ACTIVATION.md §5 items 6–7).
2. Pilot tester/customer emails in `MESSAGE_TEST_RECIPIENTS` (lets a sandbox checkout through and confirmation
   emails reach them; public sign-up stays closed).
3. Google Cloud: OAuth consent screen status (In production, unverified) and the verification review.
4. Legal: terms + privacy decisions → attorney → `/terms` PR (LAUNCH_CHECKLIST A1–A5).
5. Tax: accountant answer → tax-exclusive live price (LAUNCH_CHECKLIST B1–B5).
6. Stripe live: account, webhook, portal, retries → `STRIPE_LIVE_ENABLED=true` → controlled charge-and-refund
   (LAUNCH_CHECKLIST C1–C9, PAID_LAUNCH.md).
7. Email to real customers: `MESSAGES_LIVE=true` (D2) once confirmations should go out automatically.

## 6. Owner operations check (can the founder run this without a developer?)

| Need | Where | State |
| --- | --- | --- |
| See new inquiries | Founder's Google Calendar (early-access bookings) | Works; not in the product (§4 #8) |
| Businesses awaiting onboarding | /admin customers list: `setup_stalled`, `checkout_abandoned`, `invite_pending`, `no_owner` flags | LIVE |
| Subscription state | /admin customer detail + Business Review lifecycle stage | LIVE (sandbox data until go-live) |
| Failed integrations | `calendar_disconnected`, `domain_problem`, incidents in Control Center, live health check per business | LIVE; push alerts OFF (§4 #3) |
| Bookings needing attention | Owner dashboard "Needs attention" / outcomes to record; admin `booking_failures`, `no_recent_bookings` | LIVE |
| Campaign readiness | Ads tab (allowlisted businesses), admin campaign pause | SANDBOX |
| Test vs live data | Test businesses tagged and excluded; test leads tagged | LIVE |
| Failed automations | Admin outbox list (status/attempts/error), incident register | LIVE |
| What needs manual intervention | Business Review "approvals" and attention flags | LIVE |

## 7. First-customer onboarding checklist (owner-operated pilot)

1. Before the session: founder alerts on (§5 #1); customer's Google email added to `MESSAGE_TEST_RECIPIENTS`
   (§5 #2); confirm hello@getshowups.com is monitored; decide pricing/invoicing outside the product (the product
   will not charge them while live billing is off).
2. Create the business for them: /dashboard?plan=founding → sign in with their Google account → business name →
   plan step → sandbox checkout with the test card (no money moves; audited), or have an admin create/invite the
   business (never billed).
3. Details, services, service-area ZIPs, hours.
4. Calendar: warn them about Google's unverified-app screen; connect; Settings must say "Connected".
5. Website: "I'm starting fresh" or import; review the privacy page; publish with confirmation.
6. Test booking from the founder's phone: event on their calendar, invite received, slot gone from the page;
   cancel it from Appointments (event removed).
7. Out-of-area ZIP: the request shows under Needs attention; approve or decline.
8. Mark the founder's test lead as test. Record outcome flows once a real visit happens.
9. Weekly: Business Review (/admin/review) 20 minutes; act on attention flags; answer the Help mailbox.

## 8. Verification record

- Tests: see the PR for this page (feat/launch-readiness) and docs/STATUS.md.
- Production (read-only): build.json commit 6ef80ac; `/api/enrollment` closed; `/api/dashboard/*` and
  `/api/platform/*` 401 signed out; cross-origin POST to business creation and lead capture 403; HSTS, X-Frame-Options
  DENY and frame-ancestors 'none' on /dashboard; customer pages unchanged.
