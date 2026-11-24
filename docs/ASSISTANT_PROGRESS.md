# Assistant + Google data protection: progress

- [x] 1 Inspect: #135–#147 live; #148 (selected metric stays visible) cancelled by CI's 15-minute limit, carried here
- [x] 2 One assistant: header button on every section; same panel as metric/setting help; conversation kept across pages (in the page only)
- [x] 3 Insights: calendar incident, unanswered inquiries, outside the area, funnel findings, running campaign without data, receptionist without services
- [x] 4 Actions: service-area proposal (reviewed, stale-safe, audited), follow-up wording, funnel diagnosis with evidence, setup links
- [x] 5 Design: one quiet suggestion per page, evidence on demand, phone sheet
- [x] 6 Limits below
- [x] 7 Privacy policy + evidence + resubmission text
- [x] 8 Acceptance: test/operator.test.js, test/assist.test.js, test/e2e/assistant.spec.js, privacy.spec.js
- [ ] 9 Release: see the PR

## Limits (per business)
| What | Limit |
| --- | --- |
| Any assistant request, dismissal, approval | 40 / 10 min (`assistMessage`) |
| Questions that reach a model | 5 / min, 20 / day (`aiAskBurst`, `aiAsk`) |
| Writing help (incl. follow-up replies) | 10 / min, 40 / day (separate) |
| Question / earlier turns / answer | 500 characters / 4 × 600 / 900 characters, 400 output tokens, 12 s |
| Off switches | AI_ASSIST_ENABLED, AI_ASSIST_CHAT_ENABLED, AI_INSIGHTS_ENABLED = 'false' |

Insights, definitions and service-area proposals never call a model and don't use the daily allowance.

## Estimated model cost (not measured)
Assumes 1,800 input + 150 output tokens per question at the Workers AI list price ($0.351 / $0.555 per million) = $0.0007.
| Businesses | 2 questions a day each | Ceiling (20 a day each) |
| --- | --- | --- |
| 10 | $0.43 / month | $4.30 / month |
| 100 | $4.30 / month | $43 / month |
| 1,000 | $43 / month | $430 / month |
Timed-out calls are recorded at $0, so the real bill can be slightly higher. No platform-wide ceiling exists (owner decision).

## Deferred on purpose
Stored conversations, applying anything but ZIP codes, reading customers' messages to draft a reply, snooze per user (per
business today), conversion-rate benchmarks, any agent framework. Real answer quality: not evaluated (no paid calls).
