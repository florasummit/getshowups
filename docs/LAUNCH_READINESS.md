# Launch readiness: first paying customer (2026-11-19)

Coordinator assessment for the owner. Base: main **425d311** (production deployment b6ba40a5, docs-only change on top
of c5258264). Evidence types are kept apart:

| Tag | Meaning |
| --- | --- |
| **LIVE** | Seen working in production (date + source) |
| **SANDBOX** | Exercised against a provider's test mode (Stripe sandbox, Google Ads test account) |
| **MOCKED** | Exercised by our tests with the provider mocked (unit tests, Playwright on local workerd) |
| **BUILT** | Code exists, not exercised end to end |
| **OFF** | Built and switched off by a release switch |
| **BLOCKED** | Needs an external party or an owner decision |

Verification run for this assessment (coordinator worktree, branch docs/launch-readiness):
`npm run verify` on main 425d311: lint clean, **604/604** unit tests, build, Functions compile.
`npm run verify:all` on docs/launch-readiness: **604/604** unit + **152/152** Playwright (desktop + phone). MOCKED.

## 1. What the $499 promises today (src/content/site.js)

Website built and hosted (own domain optional) · online booking into Google Calendar · service-area screening ·
Google Calendar invitations for every booking · show-up / no-show tracking · direct help from the founding team.
Explicitly **not** promised (labelled "coming soon"): email reminders and follow-ups, text messages, ad management.
**Not mentioned at all:** the AI receptionist (chat and voice).

So the minimum commercially viable product is the six promised items plus working billing, support and recovery.
Email, SMS, voice and ads are **not required** to deliver the current promise.

## 2. Customer journey audit

Method: code reading of every step, the existing Playwright journeys (MOCKED), production facts recorded in
docs/STATUS.md (LIVE, with dates). No production writes and no real messages were made for this audit; no browser
session against production was run (no approval for live customer-data requests).

| # | Step | State | Evidence | Finding |
| --- | --- | --- | --- | --- |
| 1 | Homepage and positioning | LIVE | site.js; FAQ; no testimonials or claims | Honest. "Get started" leads to Google sign-in, and only then does a visitor learn sign-up isn't open (J-3) |
| 2 | Google sign-in | LIVE | OAuth consent "In production / External", cap 3/100 users (STATUS) | Sign-in itself uses non-sensitive scopes |
| 3 | Business creation | LIVE for allowed emails; refused for others | `signup_not_open` while live billing is off (by design) | A real stranger cannot sign up today (J-1) |
| 4 | Sandbox checkout | SANDBOX | bob-electrical / toys-for-us test subscriptions; gate #63 | Works; restricted to admin / test emails / test businesses |
| 5 | Subscription states | MOCKED + SANDBOX | billingSubscription, reconcile (#72), holds | Live mode never exercised (C8/C9 approvals) |
| 6 | Google Calendar connection | LIVE | OAuth demo video 2026-11-14; bookings on Calendar | **Sensitive-scope verification still under Google review**: customers see Google's "unverified app" warning; 100-user cap (J-2) |
| 7 | Hours and availability | LIVE | freeBusy slots; double-booking UNIQUE index; MOCKED race test | — |
| 8 | Services, prices, service area | LIVE | profile, ZIP coverage (0029) | — |
| 9 | Website Studio setup | LIVE | #76 starter deployed, renders byte-identical | Agent A hardening (§4) |
| 10 | Preview and publish | LIVE | explicit confirm, render-before-publish | — |
| 11 | Customer booking | LIVE | bob-electrical booking 2026-11-18 | — |
| 12 | Confirmation | LIVE (Calendar invite only) | Google event with `sendUpdates=all` | Email confirmations are built but gated (`MESSAGES_LIVE` off); matches the "coming soon" copy |
| 13 | Reminders | OFF | messages.js; gate | Matches copy ("coming soon") |
| 14 | Outcomes | LIVE + MOCKED | Appointments tab; reversible changes | — |
| 15 | Follow-ups | Listed for manual follow-up (LIVE); automatic OFF | FollowUps tab | Matches copy |
| 16 | Dashboard clarity | MOCKED | app.spec | Help link was missing (J-4, fixed) |
| 17 | Ads setup and approvals | SANDBOX (Google Ads test account) | ADS_ENABLED + allowlist; Explorer level | Copy says "coming soon"; correct |
| 18 | Error recovery and support | Partly | Allowlisted error codes; reconnect button; admin Business Review | No push alerting to the founder (J-5); support link fixed (J-4) |

### Defects and gaps (each with repro, impact, fix, coverage)

**J-1 · Paid sign-up is closed (by design) · Critical for paid launch, not a defect**
- Repro: any non-allowlisted Google account → /dashboard?plan=founding → plan step "Online sign-up opens soon".
- Expected for launch: a stranger can pay $499 and onboard. Actual: refused until live billing is switched on.
- Impact: no paying customer is possible. Fix: the approval chain in docs/LAUNCH_CHECKLIST.md A → B → C (legal,
  tax, Stripe live). Coverage: selfserve.spec (MOCKED); live activation untested (C8/C9).

**J-2 · Google sensitive-scope verification pending · High for first customer trust**
- Repro: a customer who is not a test user connects Calendar → Google shows the "Google hasn't verified this app"
  screen (expected behaviour for unverified sensitive scopes; owner to confirm current state in Cloud Console).
- Impact: a nontechnical owner may abandon at the most important step; 100-user lifetime cap.
- Fix: complete Google's review (external). Interim: tell the first customer in advance and walk them through it.
  Coverage: not testable locally.

**J-3 · "Get started" before sign-up opens · Medium · FIXED in this branch (owner decision 2026-11-19)**
- Repro (main): homepage → Get started → Google sign-in → only then "Online sign-up opens soon".
- Fix: public `GET /api/enrollment` → `{ open }` (server/onboarding.js `enrollmentOpen`, the same rule as
  POST /api/dashboard/business; rate-limited per IP; one boolean, no-store). While closed, all five homepage CTAs read
  "Request early access" → the call section, with a note in the hero and pricing card; an old/shared sign-up link
  (/dashboard?plan=founding) says "Online enrollment isn't open yet" **before** Google sign-in, with "Book a call"
  first and "Continue with Google" kept for existing accounts, invitations, admins and testers. Public signup stays
  closed (server rule unchanged). If the status can't be read, the old "Get started" shows and the server still refuses.
- Also fixed: the "book a call with us" link after sign-in pointed at `/#book` (no such section; the old test asserted
  the broken link), and arriving at `/#book-demo` from another page didn't scroll (React renders after the browser's
  fragment scroll).
- Coverage: test/enrollment.test.js (6 cases incl. half-configured billing, live, no-store, allowlisted errors);
  site.spec "enrollment closed" (real endpoint, desktop + phone) and "enrollment open" (mocked go-live state);
  selfserve.spec stranger path (closed notice before sign-in, Book a call lands on the section, server still refuses).

**J-4 · No way to reach support on normal screens · High (advertised promise) · FIXED in this branch**
- Repro (main): sign in as an owner → onboarding or dashboard → no contact link anywhere (only shown when suspended or
  payment failed).
- Fix: "Help" (mailto:hello@getshowups.com) next to Sign out on every owner screen, not /admin
  (src/dashboard/Home.jsx `SignOut`). Coverage: app.spec "dashboard home layout" and "partly set-up business".
- Owner check: confirm hello@getshowups.com is a monitored mailbox.

**J-5 · Failures are visible only if someone looks · High for paid launch**
- Repro: a business's Google grant is revoked → its booking page shows no times; the owner sees "Needs reconnecting"
  only on their dashboard; admin sees `calendar_disconnected` only in /admin. No email to the owner or founder
  (owner notices go through the messaging gate and cover bookings/cancellations only).
- Impact: a paying customer can silently stop receiving bookings.
- Fix: proposal in docs/FOUNDER_ALERTS_PROPOSAL.md (three alert kinds: broken Calendar connection, slots unavailable
  because of an integration failure, delivery failures; founder only; existing outbox and launch gate; off by default;
  ~1 day). Not built: Agent B's area, after its PR. Owner "reconnect your calendar" notice later, once messaging is live.

**J-6 · AI receptionist is self-serve but unproven and unadvertised · High (positioning and reliability)**
- Repro: owner → Receptionist tab → switch on → a "Chat or talk with us" link appears on their live website.
- Production evidence: bob-electrical's browser voice call 2026-11-18 answered 1 of ~5 caller turns (STATUS).
- Impact: a paying customer can put an unreliable voice experience in front of their own customers; legal notices
  (recording/transcription) are not settled (legal/ATTORNEY_REVIEW.md Q11–13); tax treatment unclear
  (ACCOUNTANT_PACKAGE.md §3).
- Owner decision (2026-11-19): voice reliability is a launch blocker **for offering voice**; investigate a safe gate
  so new owners can't unknowingly turn it on; keep existing settings; keep chat if it is independently reliable.
  Assigned to Agent B (its files): voice allowed only for allowlisted businesses, server-enforced, honest UI, Beta
  label; existing stored settings untouched. Result in §5.

## 2a. Primary acceptance criterion: activation in 20 minutes

**Target (owner, 2026-11-19):** a nontechnical owner who has never seen GetShowUps goes from "Get started" to a
**published website and a confirmed test booking on their own Google Calendar in ≤ 20 minutes**, unassisted, on
their own device.

| Measure | Target | Measured |
| --- | --- | --- |
| Sign-in → business created | — (part of 20 min) | **Not measured** |
| Checkout (sandbox, test card) | — | **Not measured** |
| Calendar connected (incl. Google's consent screen) | — | **Not measured** |
| Hours, services, ZIPs | — | **Not measured** |
| Website started, previewed, published | — | **Not measured** |
| Test booking appears on their calendar | — | **Not measured** |
| **Total, unassisted** | **≤ 20 min** | **Not measured: no real-person run yet** (LAUNCH_CHECKLIST G) |
| Times the tester needed help (> 2 min stuck) | 0 | **Not measured** |

What exists today is automated only: the Playwright self-serve journey (selfserve.spec) runs the whole path with
mocked Google and Stripe in about a minute of machine time. That proves the path works, not how long a person takes.
**How it gets measured:** LAUNCH_CHECKLIST G1–G5 (one fresh tester, sandbox checkout, screen recording with consent,
time per step, every hesitation noted). Needs approval for adding the tester's email to `MESSAGE_TEST_RECIPIENTS`.
Known risk to the target: Google's unverified-app screen at the Calendar step (J-2).

## 3. Release-readiness matrix

Effort = engineering only (owner/external time excluded). QA = controlled QA with test accounts; Beta = a few
invited, unbilled businesses; Paid = first paying customer.

| Component | Verified state | Evidence | Open blockers | Risk | Owner | Next action | Effort | QA | Beta | Paid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Authentication | LIVE | Google sign-in; sessions 7 d; safeNext | — | Low | Eng | — | 0 | ✅ | ✅ | ✅ |
| Onboarding | LIVE for allowed emails | selfserve/journey specs; G-run not done | J-1; 20-minute activation not measured (§2a); J-3 fixed in this branch | Med | Owner + Eng | Run G1–G5 | 0.5 d (fixes after run) | ✅ | ✅ | ⛔ J-1, §2a |
| Billing | SANDBOX | #63–#72; reconcile | Legal A, Tax B, Stripe live C1–C9 | High | Owner | Accountant + attorney; Stripe live settings | 0.5 d (automatic tax PR) | ✅ | n/a (unbilled) | ⛔ |
| Booking | LIVE | bob-electrical booking; UNIQUE index | Agent B review of booking path (§5) | Low | Eng | Merge B's fixes after review | — | ✅ | ✅ | ✅ |
| Google Calendar | LIVE | OAuth video; events created | J-2 verification pending | High | Google / Owner | Follow up on the review | 0 | ✅ | ⚠️ warning screen | ⚠️ |
| Website Studio | LIVE | #76; 10 goldens byte-identical | Agent A UX hardening (§4) | Med | Eng | Review A's PR | — | ✅ | ✅ | ✅ after A |
| Email | OFF (test recipients) | outbox, gate, opt-outs MOCKED | D1 test, D2 approval; postal-address question (legal Q14) | Med | Owner | D1 test email ($0) | — | ✅ | optional | not promised |
| SMS | OFF | followups engine MOCKED | Twilio paid account, A2P, approvals D3–D6 | Med | Owner | Defer | — | ✅ mocked | ✗ | not promised |
| AI voice | Configured; per-business opt-in; unreliable | 2026-11-18 call 1/5 turns | Launch blocker for offering voice (owner); gate in Agent B's PR; acceptance targets; live test approval E2 | High | Owner + Eng | Review gate; approved live test | see §5 | ✅ mocked | ⚠️ chat only | voice gated off |
| Google Ads | SANDBOX | test account campaign paused | Explorer→standard access, ADS_LIVE_LAUNCH | Med | Google / Owner | Defer | — | ✅ | ✗ | not promised |
| Meta Ads | BUILT / OFF | mocked tests | App review, enablement | Low | Owner | Defer | — | ✅ mocked | ✗ | not promised |
| Security | MOCKED + reviewed | CLAUDE.md rules, tests, audit chain | Coordinator review of A/B PRs (§6) | Med | Eng | — | — | ✅ | ✅ | ✅ after review |
| Privacy | Live /privacy (Google) | Privacy.jsx | Draft update, personal address | Med | Owner + Attorney | Fill [DECISION]s | 0.25 d publish PR | ✅ | ✅ | ⛔ |
| Legal | Drafts only | legal/*.md | No /terms; no DPA; refund wording | High | Owner + Attorney | legal/ATTORNEY_REVIEW.md | 0.25 d publish PR | ✅ | ⚠️ pilot agreement | ⛔ |
| Tax | Analysis only | SALES_TAX_ANALYSIS.md | Accountant answers; owner facts F1–F9 | High | Owner + Accountant | ACCOUNTANT_PACKAGE.md | 0.5 d (with Billing) | n/a | n/a | ⛔ |
| Support | Mailbox link (J-4 fixed) | this branch | Monitored mailbox; response expectation | Med | Owner | Confirm mailbox | 0 | ✅ | ✅ | ⚠️ |
| Monitoring | Pull-only (Business Review) | /admin/review | J-5 no push alerts; slot-lookup failures not recorded | High | Eng | Approve FOUNDER_ALERTS_PROPOSAL.md, then PR | 1 d | ✅ | ⚠️ | ⛔ J-5 |
| Recovery / rollback | Proven runbooks | backups + rollbacks used 2026-11-17/18/19 | — | Low | Owner | Keep the backup-before-release rule | 0 | ✅ | ✅ | ✅ |

## 4. Agent A: Website Studio (PR #80, head b7a7fad, CI green)

- **Built:**
  - Photo usage tracking across the draft, the live site, saved versions, History and logos.
  - Delete only when nothing recoverable uses the photo.
  - Hide (bytes kept; migration 0030).
  - Replace everywhere in the draft.
  - Back/Forward-aware full screen and panels; Escape inside the preview frame.
  - Editor state preservation with the 409 conflict path.
  - Opt-in phone images (`responsiveImages: true`).
  - EXIF orientation fix.
  - Details: docs/STUDIO_UX_HARDENING.md.
- **Real defect fixed:** photos used by older `content.design` sites weren't counted as in use. They could be deleted while live, and the public asset route refused them.
- **Deferred:**
  - No prompt when leaving Studio through a dashboard tab (the edits are kept).
  - Escape inside the frame on touch devices.
  - AI-composition phone order (needs renderer versioning).

## 5. Agent B: AI communications (PR #81, head ec5e4f3, CI green)

- **Voice root causes fixed (in our code, checked against Retell's protocol):**
  - an interrupted answer wasn't aborted;
  - one failed turn silenced the rest of the call;
  - Retell's auto-reconnect was refused;
  - a bad `response_id` broke staleness checks;
  - talked-over words were lost;
  - the holding line was late;
  - the 25 s ×2 timeout;
  - the microphone was requested after the call was created.

  The 2026-11-18 bob-electrical call fits the first and the fifth (preliminary until a live call).
- **Measured, mocked harness only (our overhead, not end-to-end):** first spoken chunk after the model's first token P50 8 ms / P95 10 ms (n=200). The next turn after an interruption went from ≈3.06 s to <0.1 s (n=1). End-of-speech → audio on a real call is **not measured**. Targets are in docs/COMMS_RELIABILITY.md, kept separate from these results.
- **Voice gate:** `RECEPTIONIST_VOICE_BUSINESSES` (allowlist; empty = nobody). Enforced at call creation, on the socket and on reconnect; Beta label; honest wording; chat unchanged; no stored setting changed.
- **Email/booking:**
  - outbox backoff, expiry and permanent-failure handling;
  - the confirmation and owner booking notice go out right after the booking (the cron stays as fallback; the deterministic id and the Resend idempotency key prevent duplicates);
  - orphan Calendar events are cleaned up and retried;
  - booking and availability failure/recovery events (codes for the founder-alert PR).
- **Provider:** keep Retell, tune the configuration (`retell-setup.mjs --tuned`, never run). Retell stores everything by default with no retention limit; the proposal is `everything_except_pii` and 30 days (attorney/owner).

## 6. Integration and security review (coordinator)

- **Integration worktree:** main + #80 + #81 + #82. Only conflict: docs/STATUS.md, resolved keep-both. No other file is touched by more than one PR, and there are no dependency changes. `npm run verify:all`: **634/634 unit** (604 + 10 + 14 + 6), **166 passed / 1 skipped** Playwright (A's opt-in screenshot test), lint clean.
- **Customer websites:** PoolThru (5 pages), bob-electrical and toys-for-us rendered from the latest local backup through the full `serveSite` path (including B's `offerSmsFor`/`receptionistOn`), with the receptionist off and on. **Byte-identical to main** on #80, #81 and the integration branch. The 12 render goldens pass; `test/fixtures` is unchanged.
- **Security review:**
  - Asset actions are session-scoped and same-origin, ownership is checked by `customer` on every query, another business's id gets 404, and error codes are allowlisted.
  - Delete is refused for anything recoverable.
  - 0030 is additive and idempotent, is in ERASED_TABLES, and fails soft before it is applied. No 0031 was needed.
  - The voice gate is fail-closed, with server enforcement in 3 places.
  - The reconnect window is limited to 2 minutes and the conversation must not have ended.
  - Immediate confirmations use the same launch gate (`recipientAllowed`) and the atomic claim.
  - The edited outbox test assertions are stricter, not weaker.
  - No secrets or personal data appear in events (codes and numbers only).
- **Found nothing blocking.** Notes:
  - (1) With B's change, account mail (e.g. an invite) queued more than 23 h ago is closed as `expired`, not sent (intended: no late bursts).
  - (2) Concurrent cron and immediate flush of the same outbox row is deduplicated by Resend's idempotency key, not by our database.

## 7. Critical path to the first paying customer

Mandatory for the $499 offer as advertised: promised six items (LIVE today) + support (J-4 fixed; mailbox) +
monitoring (J-5) + billing live (A → B → C) + Calendar verification (J-2, external).
Deferred safely (not promised): email/text reminders and follow-ups, voice, ads.

1. **Owner, now (parallel):** send ACCOUNTANT_PACKAGE.md (fill F1–F9); send legal/ATTORNEY_REVIEW.md; confirm the
   support mailbox; decide voice gating (J-6); check Google verification status.
2. **Engineering, now (≈2–3 days, no approvals needed to build):** review/merge-ready A and B PRs; founder alert PR
   (J-5); "sign-up opens soon" CTA (J-3, wording from owner).
3. **Controlled QA (approval: add the tester's email to MESSAGE_TEST_RECIPIENTS):** LAUNCH_CHECKLIST G — one person
   who has never seen the product, timed, sandbox checkout.
4. **After written tax + legal answers:** automatic-tax PR (0.5 d), `/terms` + `/privacy` PR (0.25 d) — approvals.
5. **Go-live (approvals):** Stripe live C1–C8; controlled $499 charge-and-refund (C9); founder on hand 1 h.
6. **First customer onboarding** with the founder present, using the QA plan below.

### First-customer QA plan (run in sandbox first, then once live)

| Step | Check | Pass when |
| --- | --- | --- |
| 1 | Sign up, pay (C9 test first) | Webhook recorded live; billing card "Active"; receipt from Stripe |
| 2 | Connect Calendar | Status "Connected"; warning screen explained beforehand |
| 3 | Hours, services, ZIPs | Booking page offers only free times inside hours |
| 4 | Website | Starter site previewed, published with confirmation; phone shows Book + Call on first screen |
| 5 | Test booking (founder's own email, test mark if needed) | Event on the owner's calendar; invite received; slot no longer offered |
| 6 | Out-of-area ZIP | "We may be able to help in your area"; owner sees the request |
| 7 | Outcome | Mark showed / no-show; undo works; dashboard counts update |
| 8 | Cancellation from the owner side | Event removed first, slot free again |
| 9 | Support | Email to Help reaches the founder; reply time noted |
| 10 | Failure drill | Disconnect Calendar on a test business → founder alert (after J-5) → reconnect restores times |

## 8. Next project (recorded, not started)

**Admin Intelligence / QA Command Center**: deliberately not started (owner, 2026-11-19). Starts after the
launch-critical items above (Agent A and B PRs, founder alerts, closed-signup fix, the 20-minute activation run).
Natural inputs: Business Review capabilities/incidents, founder alerts, the activation-run measurements.

## 9. Approvals needed

Listed in the consolidated report. This branch needs only merge approval (Help link, closed-enrollment notice, docs);
it changes no switch, no stored data and no customer website.
