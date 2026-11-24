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
| A Foundation | in progress | below |
| B Public messaging | not started | |
| C Usability | not started | |
| D Static help | not started | |
| E Dashboard AI chat | not started | |
| F Inline writing | not started | |
| G AI architecture | not started | |
| H Commercial journeys, KPIs | not started | |
| I Final integration | not started | |

### A. Engineering workflow

Measured (PR #140, run 45297608877, 12 m 13 s): browser tests 446 s, Chromium install 226 s, everything else 41 s.
Local: lint 0.3 s, unit 16 s, build 0.5 s, Functions 0.7 s, full browser suite 3.3 min (5 workers).

- Third CI browser worker: to be compared below.
- Chromium install: the fix (caching the browser) is a workflow file change; our token has no Workflows permission
  (owner).
- Releases were ad-hoc shell each time: now `scripts/release.sh`; CI is looked at with `scripts/ci-check.sh`.

## Needs the owner (never inferred)

Applying the sales answers · enrollment · live Stripe, terms/privacy, sales tax · live ad spend · customer messaging and
founder alerts · secrets · migrations · paid model benchmarks · Google app review and Ads access level.
