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
(A1, L2, R1), never names or contact details. The conversation is kept in the owner's browser only
(`src/dashboard/assistant-memory.js`: references, never names; 30 days; cleared on sign-out; the privacy policy says we store none);
the server re-reads every reference inside the session's business. Earlier answers are what was said, never evidence. Ambiguity that changes the action: one question (instructed); withdrawing: enforced (§4).

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
deployed site through a test session (§8). Every real defect becomes a scenario with its strict expectation; a
failing one moves to `known` with a severity and leaves only after passing repeatedly. Read the transcripts: checks miss things.
Blocks a release: material factual error, wrong consequential action, security or tenant failure, broken core function, claimed
but unverified success. Wording imperfections are listed, not chased. Green CI is not acceptance.

## 8. Test sessions (authentication for acceptance only)
Normal sign-in is unchanged: Google, `server/auth.js`. A test session is a separate thing that can only ever be one admin-marked
test business. Off unless `ACCEPTANCE_SESSIONS_ENABLED` is exactly `true`; every error refuses.
| Rule | Where (enforced) |
| --- | --- |
| Pairing: the runner sends a hash of its secret, gets a 10-minute code; a platform admin approves it for a business typed to confirm; spent in one transaction; rate-limited | `server/acceptance.js`, `functions/api/platform/acceptance.js` |
| Grant 90 days, one per business, renewed only by pairing again; session 1 hour, one at a time; revoking ends both on the next request | `server/acceptance.js` |
| Test mark, active business, grant, session and switch read together on every request, and again when an action or tool runs | `server/acceptance.js` (live), `server/acceptance-env.js` (stillAllowed) |
| Own cookie; never combined with a normal session; unknown to admin and normal session code | `server/acceptance.js`, `functions/_middleware.js` |
| Exact method + path list; everything else under /api/ refused | `server/acceptance-routes.js` |
| No Google, Ads, Stripe, email, text, CRM or voice credentials; calendar tokens unreadable; queues, other tables and other businesses not writable | `server/acceptance-env.js` |
| Synthetic records: fixed ids, no deliverable addresses, no calendar event, no queued message, outside the owner-notice window | `server/acceptance-fixture.js` |
| Out of platform metrics, revenue, MRR and founder alerts (test businesses) | `server/metrics.js`, `server/growth.js`, `server/alerts.js` |
| Only hashes stored; the secret lives in the runner's Keychain | `migrations/0038_acceptance_sessions.sql`, `scripts/acceptance/grant.mjs` |
| Approve, refuse, session, refused write and revoke are in the permanent audit log | `server/acceptance.js` |
Tests: `test/acceptance.test.js`. Renew: `node scripts/acceptance/pair.mjs`, then Admin, Acceptance testing.

## 9. Shared knowledge
One body of taught knowledge, one industry table, read per role; each capability keeps its own instructions and permissions.
| Rule | Where | Test |
| --- | --- | --- |
| Source: the owner's PUBLISHED rules only (drafted, reviewed, versioned, rolled back). Never a draft, a customer conversation or an AI answer | `server/intelligence/knowledge.js`, `server/intelligence/store.js` | `test/unified.test.js` |
| Records (services, prices, hours, area, policies) win; prices and discounts can't be taught | `server/intelligence/schema.js` | `test/unified.test.js` |
| Customer-facing roles see only what may be told to customers, and only where published rules are released; planning roles also see internal notes, job figures, seasons, goal | `server/intelligence/knowledge.js` (roles) | `test/unified.test.js` |
| Ways around platform rules, instructions and links are refused when taught and again when read | `server/intelligence/platform-rules.js`, `server/intelligence/schema.js` | `test/unified.test.js` |
| Kinds of business: defaults in one table; the owner's published questions replace them | `server/intelligence/industries.js` | `test/unified.test.js` |
| A correction becomes a general fact to review; nothing is saved or published by it | `server/intelligence/teach.js` | `test/unified.test.js` |
| Ads: every source followed to money; cost only with spend; profit only with the owner's margins and labelled an estimate; no authority to spend | `server/ads/economics.js` | `test/unified.test.js` |

| Capability | Role | Reads it in |
| --- | --- | --- |
| Receptionist (chat and voice), lead qualification, scheduling | receptionist | `server/receptionist/knowledge.js` |
| Follow-up texts | followups | `server/followups/engine.js` |
| Website copy, writing help | website, writing | `server/website-ai.js`, `server/writing.js` |
| Ads plans (Google, Meta) | ads | `server/ads/strategy.js` |
| Owner assistant, performance analysis | owner, analysis | `server/operator-tools.js` |
Not yet: the Claude/OpenAI website designer, ChatGPT ads plans (they can call `taughtFor(env, customer, 'ads')`).
