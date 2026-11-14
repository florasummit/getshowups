# Founder command center — evaluation and proposed design (NOT implemented; needs approval)

Date: 2026-11-14. Production: deployment 1db27fd7 (abbbbfa). Based on the live /admin (Overview + Business Review) seen by
the founder, the production records behind it, and the two closest earlier designs that could be located:

- `~/Downloads/GetShowUps-Architecture-Map.html` — a static explainer (no scripts or controls): customer journey,
  ownership, test-vs-live, multi-customer separation, scenarios, decisions. It defined the status vocabulary
  (Live-verified / Built + tested / Sandbox only / Off · needs approval / Not built / Unknown) that Business Review uses.
- The other agent's `business-review.patch` UI (not merged): exception-first home, capabilities on two axes
  (implementation vs live health), per-business and per-capability drill-downs, actions with a recorded reason.

The "interactive HTML dashboard/prototype" the founder remembers was **not found** in the repository, worktrees, local
files, artifacts or this project's session records. It must be supplied (link or file) before it can be compared;
nothing here is reconstructed from memory.

## 1. Does today's /admin answer the founder's seven questions?

| Question | Today | Verdict |
| --- | --- | --- |
| 1. Is the platform healthy? | Business Review: status counts, health, incidents, audit, migrations | Mostly — but before fix/review-accuracy it called the never-triggered safety stop "live-verified", missed reconciliation differences and an orphaned credential, and used test-business activity as evidence |
| 2. How many businesses are active and getting results? | Overview metrics (customers, activation, conversion, show-up) | Partly — on a different tab from Q1/Q4; no "getting results" definition |
| 3. Where are leads lost (ads → qualify → book → show → revenue)? | Per-business counts in a drill-down only | **No** platform-wide funnel; no ads stage, no qualification stage (not built), no job value |
| 4. Which businesses need intervention? | Overview attention list AND Business Review incidents | Yes, but in two places with two wordings |
| 5. Automation, integrations, billing, ads OK? | Capability list (33 rows) | Yes, but noisy: the founder must scan 33 rows; exceptions are not separated from inventory |
| 6. What needs my decision? | "Waiting on a decision" (switch approvals) | Partly — policy decisions (retention schedule, deletion, Google confirmation) live only in docs |
| 7. Better or worse over time? | Nothing (except revenue growth once live billing is on) | **No** trends |

Conclusion: the platform-readiness half is solid; the business-performance half is missing, and the screen mixes a
capability inventory with exceptions. A healthy platform can show "all green" while no customer gets a booking.

## 2. Proposed design: one exception-first home, two clear halves, drill-downs for everything else

One /admin home (Overview and Business Review merged; no second dashboard):

1. **Needs you** (top, usually empty): one ranked list merging incidents, business flags, stuck jobs, reconciliation
   differences and pending decisions (switches AND policy decisions). Each row: what, why it matters, one action/link.
2. **Business performance — last 30 days vs previous 30** (real businesses only):
   live businesses · paying · funnel `ad clicks → leads → booked → showed → jobs done` with stage conversion and the
   biggest drop-off highlighted; ad spend and cost per show-up once ads are live; small trend arrows. Missing data
   shows "—", never 0.
3. **Platform health** — one line per journey stage (signup, billing, website, ads, booking, messaging, show-up,
   results) coloured from the capabilities in that stage, with "last proven" time. Tap → capability list/drill-down.
4. **Businesses** — compact table: stage, last 30 days (leads/booked/showed), flags. Tap → existing business drill-down.
5. **Changes** (collapsed): releases, migrations, switch changes.

Built entirely on what exists: review engine + registry (health, incidents, decisions), metrics.js (funnel, activation,
billing), audit_log (history, trends from events), lifecycle (stages). New: one funnel/trend query (SQL over leads,
appointments, outcomes, ad_metrics_daily for two windows) and a "decisions" list that includes policy decisions
(registered like capabilities' approvals). No new tables or services.

## 3. Estimate

| Part | Effort |
| --- | --- |
| API: merged home payload, funnel + 30/30 trend query (real businesses only), decisions list | 0.5–1 day |
| UI: one exception-first home, stage-health strip, businesses table, keep drill-downs | 1–1.5 days |
| Tests: unit (funnel math vs records, trends, no test data), e2e + 320/390 px, accuracy against seeded data | 0.5–1 day |
| Total | **2–3.5 days**, one draft PR, no migration |
