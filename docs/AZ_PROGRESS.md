# A–Z plan: progress

Specification: docs/AZ_MASTER_PLAN.md (verbatim). Update after every verified release; resume from the first row that
isn't done. Evidence only: nothing is marked done from a claim.

## History reconciled (2026-11-24, GitHub + production)

| PR | Merge commit | In main | Deployment |
| --- | --- | --- | --- |
| #135 Ads import fields | 089c04d | yes | 2b7810e9 (import of two test accounts read ok, 0 campaigns) |
| #136 Enterprise | 1240b40 | yes | 861d8bbe |
| #137 Works with strip | 76af182 | yes | 2ac2fdac |
| #138 AI efficiency | 8c96ebd | yes | 6f9132b1 |
| #139 Sales answers, expired session | 026e182 | yes | 169b00a3 |
| #140 Writing help | 21e60a5 | yes | 1587ad1d |

## Phases

| Phase | State | Evidence |
| --- | --- | --- |
| A Foundation | done | #141 (main e106333, deployment f3af0540, rollback 1587ad1d) |
| B Public messaging | done | #142 (main 9678a7e, deployment 7aef7890, rollback f3af0540) |
| C Usability | done | #142; defects below |
| D Static help | in progress | az/d-help: 20 topics, one panel, zero requests (browser-tested) |
| E Dashboard AI chat | in progress | az/e-chat |
| F Inline writing | in progress | #140 verified in code (10/min, 40/day, off switch); setup description field added. Wording quality unverified (no paid calls) |
| G AI architecture | in progress | below |
| H Commercial journeys, KPIs | in progress | below |
| I Final integration | not started | |

### A. Engineering workflow

Measured (PR #140, run 45297608877, 12 m 13 s): browser tests 446 s, Chromium install 226 s, everything else 41 s.
Local: lint 0.3 s, unit 16 s, build 0.5 s, Functions 0.7 s, full browser suite 3.3 min (5 workers).

- Third CI browser worker: #141's whole verify job took 8 m 36 s; the six runs before it 8 m 00 s to 12 m 13 s. One
  run proves no speedup (the Chromium step alone varies by minutes); no flake seen. Kept, to be compared per step.
- Chromium install: the fix (caching the browser) is a workflow file change; our token has no Workflows permission
  (owner).
- Releases were ad-hoc shell each time: now `scripts/release.sh`; CI is looked at with `scripts/ci-check.sh`.

### C. Defects found and fixed (each reproduced in code, browser-tested)

| Defect | Effect |
| --- | --- |
| Settings / setup forms opened EMPTY when loading failed | saving then erased stored services and notes (data loss) |
| A failed 30-second refresh of Follow-ups unmounted the conversation | a reply being written was lost |
| Changing tabs dropped unsaved text silently | now asks first |
| Appointments stayed blank on a load failure | now says so, with Retry |
| Setup showed "Google Calendar connected ([object Object])" | shows the email |
| Reminders / follow-up switch and "Undo" ignored failures | now say so |
| Booking page: no retry when times fail; focus lost between steps; tab/radio roles without their keyboard behaviour | retry, focus on the new heading, plain pressed buttons |

### G. AI architecture

- New gap found: chat turns recorded no latency and no channel recorded cached tokens, so #138's gain could never be
  proven. Now `turn_usage` events (both channels, numbers only). Compare once there are 20+ turns. Baseline: 29
  conversations, $0.0155 per chat turn, about 2.5 s to first words on recent Retell turns.
- Production volume 2026-11-24: no receptionist conversation since #138. No new saving can be claimed.
- OpenAI voice (the default): the browser talks to OpenAI directly; our server only runs its tools, so model latency is
  not on our side to measure. Session minutes and caps are recorded.
- A timed-out Workers AI call (writing, ask) counts toward limits but its cost is recorded as 0 (the provider reports none).
- Assumption for growth: one receptionist turn is about 8 database reads and 5 writes (counted in code); 100 chats × 5
  turns per business a month at 1,000 businesses is about 500,000 turns, 4 million reads, 2.5 million writes a month.
  Average load is small; the likely first limit is the provider's account rate limit in peak hours (not visible here).
- Platform-wide AI ceiling (proposal, NOT built: changes caps): one daily total across businesses, warn at 80%, at 100%
  new receptionist conversations get the fixed reply with the booking link while open ones finish. Suggested start:
  $25 a day (about 1,600 chat turns). Needs approval before onboarding more than about 25 active businesses.

### H. Commercial journeys (read-only, 2026-11-24)

| Journey | Evidence | Not verified |
| --- | --- | --- |
| Growth | gate truthful in production (closed; Request early access); full journey passes against stand-ins (journey, selfserve specs) | live Stripe checkout: closed and in test mode |
| Enterprise | form and refusals live; stored path tested with the real handlers; 0 real inquiries | a real inquiry |
| Sales assistant | code knows Growth, Enterprise, Teach pilot | production record still says Founding: owner applies |
| Ads import | both test accounts read ok, 0 campaigns: list query proven, detail, metric and LSA queries unproven against Google | an account with its own campaigns |
| Alerts | no alert switch among the production secret names (a plain variable would not show there); not enabled by this program | |
| Privacy | /privacy is served; /terms does not exist (shows the homepage) | terms, and whether the policy covers the AI features: owner/attorney |

Customer value, production totals (all businesses, test-marked leads left out where noted): 14 leads, 5 booked + 1 showed + 2 cancelled
appointments, 0 payments recorded, 0 ad spend. Too few for any rate. Overview now shows the one finding worth acting on
(server/ads/funnel.js diagnose, minimum samples).

## Needs the owner (never inferred)

Applying the sales answers · enrollment · live Stripe, terms/privacy, sales tax · live ad spend · customer messaging and
founder alerts · secrets · migrations · paid model benchmarks · Google app review and Ads access level.
