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
| Questions that reach a model | 5 / min (`aiAskBurst`); 20 successful answers / day (`answersUsedUp`, from `ai_ask` records); 60 attempts / day (`aiAttempt`) |
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

# Operator (2026-11-24)

## What was wrong (traced, production model, synthetic business)
No retrieval at all (counts only) · a prompt that told it to send owners to pages · a fixed "I can look at…" sentence for anything
else · validators that threw away whole answers · 4 short history turns without record identity · a small model that repeated its
instructions. Same tools, different model: the old model still parroted; so both architecture and model matter.

## What it is now
server/operator-tools.js (16 fixed tools; no business id, SQL or URL argument; references looked up inside the
business) · server/operator.js (≤5 rounds, ≤8 lookups, 40 s, checked answers, one correction) · server/operator-model.js (provider boundary).
The model never sees names, phones, emails or addresses; the app fills names in. Prepared: outcome, follow-up draft, ZIPs, hours.
Approval: tenant, state and arguments re-checked; stale and duplicate approvals change nothing; audited. Follow-ups are never sent.
Without a model the records still answer plain questions.

## Measured with real models (synthetic business; scoring: automatic checks per turn on facts, tools, prepared change, forbidden content)
| Model (identical tools and checks) | Turns | Passed | Median / p95 | Cost per turn |
| --- | --- | --- | --- | --- |
| Claude Haiku 5.5, medium effort, development set | 67 | 66–67 | 2.1 s / 3.9–4.3 s | $0.0005 |
| Claude Haiku 5.5, medium, holdout set (3 runs; two small wording fixes after the first two) | 114 | 109 (2 of the 5 misses were scoring errors) | 2.3–2.6 s / 5 s | $0.0005 |
| Claude Haiku 5.5, low effort, development set | 67 | 65 | 1.9 s / 3.2 s | $0.0004 |
| Claude Sonnet 5.5, low effort, development set | 67 | 62 (2 from a checker bug since fixed) | 3.0 s / 4.9 s | $0.0075 |
| Claude Opus 5.5, low effort, 18-turn set | 18 | 18 answered, read by hand | 4.6 s avg | $0.028 |
| gpt-oss-120b, 18-turn set, earlier prompt | 18 | 18 answered; wrong money answer twice | 6.7 s avg | $0.0028 |
| Gemma 4 26B, 18-turn set, earlier prompt | 18 | 16 answered, 2 timed out; accurate | 13.5 s avg | $0.0011 |
| Mistral Small 3.1 (production), 18-turn set, earlier prompt | 18 | 18 answered; first one useless, several repeated a data dump | 3.5 s avg | $0.0034 |
| Old assistant, production, real owner questions, last 24 h | 13 | 7 answered, 6 failed | | $0.0002 |
Naturalness, Sonnet 5.5 as judge: Haiku holdout 35 of 38; old assistant 18 turns: about 5 of 18 (the judge's two counts differed).
Zero tenant, name or contact leaks and zero unapproved changes in every run. Small samples: indications, not guarantees.
The final prompt could not be run on Workers AI models: the account's free daily allowance was used up by this evaluation.

## Cost of Claude Haiku 5.5 (estimate: $0.0005 a question, measured above)
| Businesses | 3 questions a day each | 20 a day each (limit) |
| --- | --- | --- |
| 100 | $4.50 / month | $30 / month |
| 1,000 | $45 | $300 |
| 10,000 | $450 | $3,000 |

## Production
Model unchanged (Mistral). Shared ceiling aiAskAll: 25 model answers a day across all businesses, because Workers Free allows 10,000
neurons (about $0.11) a day for every Workers AI feature together and a tool conversation uses about 300 per answer.
