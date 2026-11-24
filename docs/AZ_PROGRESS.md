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
| B Public messaging | in progress | az/b-c: seven lifecycle steps with real status; Teach Your AI labelled pilot everywhere |
| C Usability | in progress | az/b-c: see below |
| D Static help | in progress | az/d-help: 20 topics, one panel, zero requests (browser-tested) |
| E Dashboard AI chat | not started | |
| F Inline writing | not started | |
| G AI architecture | not started | |
| H Commercial journeys, KPIs | not started | |
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

## Needs the owner (never inferred)

Applying the sales answers · enrollment · live Stripe, terms/privacy, sales tax · live ad spend · customer messaging and
founder alerts · secrets · migrations · paid model benchmarks · Google app review and Ads access level.
