# Business intelligence: the governing specification

One place for how GetShowUps knows, reasons, acts and learns. Engineering rules for Claude Code are in CLAUDE.md; what a model
is told at run time is `server/operator-instructions.js` (owner assistant) and `server/receptionist/engine.js` (customers).
**Enforced** = software refuses anything else. **Instructed** = depends on the model; measured, never assumed. A rule software
can hold is moved out of the instructions. `test/assistant-intelligence.test.js` fails when a file or test named here is gone.

## 1. Business truth
| Rule | How | Where | Test |
| --- | --- | --- | --- |
| A fact has one owner; pages and AI read the same service | Enforced for who is waiting, page figures, results | `server/attention.js`, `server/app-state.js`, `server/booking.js`, `server/ads/funnel.js` | `test/assist-truth.test.js` |
| "Unanswered" is one definition | Enforced | `server/attention.js` (UNANSWERED) | `test/assistant-intelligence.test.js` |
| Unreadable, left out, not recorded and zero are different | Enforced in data; wording instructed | `server/attention.js`, `server/fit.js` | `test/assist-truth.test.js`, `test/assistant-intelligence.test.js` |
| Records are never cut in half; long text says it continues | Enforced | `server/fit.js` | `test/assistant-intelligence.test.js` |
| Figures in an answer come from records; customer text is quotable, never a result | Enforced | `server/operator.js` (problemWith), `server/fact-numbers.js` | `test/assist.test.js`, `test/assist-truth.test.js` |
| Statements about a person match their record (kind of waiting, urgent, confirmed, sender, date, who waited longest) | Enforced, narrow | `server/claims.js` | `test/assistant-intelligence.test.js` |
| Authority when sources differ: records > owner's approved rules > owner notes > customer text > model | Enforced per service | `server/receptionist/knowledge.js`, `server/intelligence/schema.js` | `test/receptionist.test.js` |
| Estimated, invoiced and paid money stay apart; ads are not credited | Enforced | `server/revenue.js`, `server/ads/funnel.js`, `server/operator.js` | `test/assist.test.js` |
| One business only | Enforced (session business in every query) | `server/operator-tools.js` | `test/assist.test.js` |

Same person: a call back's conversation names its inquiry; exact phone or email matches are offered as `same_contact`. Nothing
is merged or written. Names alone never identify anyone.

## 2. Context and conversation
Every turn: who is waiting, the page on screen, the record open, people discussed (latest first), changes waiting for approval,
and the last lookups read again (`server/operator.js`). Other pages and records on demand by tool. The model gets references
(A1, L2, R1), never names or contact details. The conversation lives in the browser; the server re-reads every reference inside
the session's business. Ambiguity that changes the action: one question (instructed); withdrawing: enforced (§4).

## 3. Business reasoning
Figures are calculated in code; the model interprets. The principles (responsiveness, freshness, attendance, completion, money
to check, the owner's time, cause versus coincidence, small numbers) are in `server/operator-instructions.js` REASON: instructed.
Enforced: no forecast, no return credited to ads, no invented number. Unprompted suggestions stay deterministic (`server/insights.js`).

## 4. Tools and actions
Reasoning proposes; software executes. Fixed typed tools bound to the business (`server/operator-tools.js`). Prepared changes
have ids: a newer one for the same thing replaces the older, withdrawing names ids, several waiting without a name is refused
(`server/proposal-set.js`). Approval re-checks tenant and state, refuses stale, repeats change nothing, audited
(`server/proposals.js`). "Done" is claimed only by the page after the server saved. Tests: `test/assistant-intelligence.test.js`, `test/assist.test.js`.

## 5. Models
Business logic doesn't know the model: `server/operator-model.js` adapts it, and checks, tools and instructions stay the same.
Change a model only on the same scenarios through `scripts/acceptance` (accuracy, reasoning, tools, actions, latency, cost per
good answer), with the owner's approval. Cheapest that has no material failure wins.

## 6. Knowledge and learning
| What went wrong or was learned | Where it goes | Scope |
| --- | --- | --- |
| A fact about the business | Settings and records (owner edits or approves) | That business |
| How the receptionist should behave | Teach Your AI (`server/intelligence/store.js`: draft, publish, version, rollback) | That business; platform rules can't be overridden |
| `wrong_fact`, `missing` (owner's "Not right?") | Data, retrieval or claim rule: reproduce as a scenario, fix at the source | Product |
| `misunderstood`, `not_useful` | Scenario; instructions only if software can't hold it | Product or model limit |
| `wrong_action` | Release blocker until reproduced and fixed | Product |
| `unchecked`, `refusals` in `ai_ask` | Review weekly: a check that refuses true answers is a defect | Product |
| `setup`, `quota`, `busy`, `timeout` | Provider or integration | Platform |
Feedback is codes only (`functions/api/dashboard/assist-feedback.js`), never changes behaviour by itself, never crosses businesses.

## 7. Evaluation and release
`scripts/acceptance/run.mjs`: real dashboard, handlers and model on synthetic businesses (sets: main, fresh, known), or the
deployed site signed in as an admin-marked test business. Every real defect becomes a scenario with its strict expectation; a
failing one moves to `known` with a severity and leaves only after passing repeatedly. Read the transcripts: checks miss things.
Blocks a release: material factual error, wrong consequential action, security or tenant failure, broken core function, claimed
but unverified success. Wording imperfections are listed, not chased. Green CI is not acceptance.
