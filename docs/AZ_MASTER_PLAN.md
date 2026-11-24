# GetShowUps — Authoritative A–Z Product, AI Architecture & Engineering Plan

Version: 2026-11-23. This document is the complete execution specification. Do not assume any additional text follows it.

## Mission
Ship a premium, intuitive, secure, lean, cost-controlled GetShowUps business growth platform, with reliable customer acquisition workflows and rapid, safe engineering delivery. Optimize customer value, time to revenue, and maintainability—not lines of code or speculative features. Operate autonomously across scoped phases, with existing consequential-action approval boundaries.

## 0. Verified history and reconciliation
Repository: `florasummit/getshowups`; production: `getshowups.com`. Stack: Vite/React, Cloudflare Pages/Functions/Workers/D1, Stripe, Google Calendar, Google Ads integrations, existing AI receptionist and model infrastructure.

User-supplied release report states these are merged and live; verify from repo and production before marking complete:
- PR #135 Google Ads campaign import field fix, commit `089c04d`.
- PR #136 Enterprise pricing/inquiry, commit `1240b40`.
- PR #137 trademark-safe text integrations strip, commit `76af182` (verify).
- PR #138 AI efficiency: parallel reads, history caching, voice usage accounting, Teach Your AI limits; commit `8c96ebd`.
- PR #139 sales-answer accuracy and expired-session UX, commit `026e182`.
- PR #140 owner AI writing assistance, commit `21e60a5`.

Do not rebuild, re-merge, or redeploy completed features. Reconcile actual repo/CI/prod status first. Existing two-offer pricing: Growth $499/month; Enterprise starting at $10,000/month via Contact Sales. Enterprise shared organization login/reporting/billing are NOT live. Enrollment is currently closed; do not open it without approval. Sales assistant new approved answers are deployed as code but NOT applied to live records; require explicit user action/approval. Logo permission research is deferred: keep current text-only integrations strip; do not pursue logo approvals or change logo usage in this program.

## 1. Persistent execution and workflow speed
Save this exact specification to `docs/AZ_MASTER_PLAN.md` and maintain `docs/AZ_PROGRESS.md` with phases, evidence, PRs, deployment IDs, blockers and next action. Update after each release and at context compaction. Resume from unfinished work, not the beginning. Treat each PR as a checkpoint, not a stopping point. Do not invent approvals.

Inspect existing CLAUDE.md, agents, skills, CI/test/deploy scripts and relevant project docs only as needed. Identify measurable bottlenecks: repeated repository reading, long planning, CI polling, excessive broad tests, duplicate agent work, context bloat. Implement low-risk improvements. One lead orchestrator; up to three agents for independent frontend, AI/backend, QA/release work; isolated worktrees where beneficial; avoid file conflicts and excessive usage. No new orchestration framework. Use targeted tests during coding, required CI at release. Poll CI with bounded nonblocking checks; continue independent work. Do not enable paid fast mode, credits, providers, or new paid infrastructure. Report measured versus estimated engineering speed improvements.

## 2. Public product positioning and conversion UX
The value proposition is the whole business growth lifecycle: ATTRACT → CAPTURE → QUALIFY → BOOK → FOLLOW UP → MEASURE → OPTIMIZE. GetShowUps is not merely an AI receptionist. Explain actual available outcomes: faster lead response, qualification, bookings, follow-ups, visibility into funnel performance and less manual work. Preserve truthful homepage headline “More booked jobs. Less chasing.” where appropriate. Show the customer journey visually and plainly without claims of guaranteed revenue or capabilities not shipped.

Preserve established premium Stripe-inspired design *direction*, not Stripe assets or copied layouts: generous whitespace, calm hierarchy, precise typography, subtle gradients/motion, clear CTAs, polished mobile/accessibility, consistent components. Maintain existing integrations strip; only fix proven defects, do not restart trademark/logo work. Present Google Ads, Meta, texting, and other limited or future features with accurate status. Explain customer-owned API keys where material. Keep Growth and Enterprise positioning truthful; Enterprise contact-sales only. Update sales assistant knowledge as code already supports, but do not apply live approved answers without user permission.

## 3. Product-wide usability, prioritized by impact
Review and improve actual friction in: signup/onboarding, business settings, Google Calendar connection, availability, booking page, leads, follow-ups, AI receptionist, Ads drafting/approval, analytics/KPIs, billing/account settings, Enterprise inquiry. Every important screen should make its purpose clear, present one primary action, progressively disclose advanced settings, preserve user inputs, and offer actionable loading/empty/error states. Minimize steps and jargon; work on mobile and keyboard/screen reader. Reuse existing design system and proven workflows. Do not redesign functional screens for novelty. Prefer high-impact fixes with focused regression tests.

## 4. Contextual static help + optional dashboard AI Assist
Build reusable contextual help for business-owner screens, distinct from customer-facing receptionist. A user can select a field/setting/metric and get: what it is, why it matters, business example, and next action. Desktop compact side panel; mobile accessible sheet. Opening help uses curated static content and ZERO model calls. Optional follow-up chat invokes AI ONLY on explicit user submission. Prioritize onboarding, Ads budgets and settings, qualification, availability, conversion rate, cost per lead/booking, show-up rate, follow-up. Clearly distinguish measured, estimated and unavailable metrics. Avoid floating chat clutter and AI buttons everywhere.

Reuse existing model gateway, auth and tenant context, with strictly scoped read-only context for assistance. Never grant arbitrary tools, write permissions or consequential actions. Enforce tenant isolation, request validation, prompt-injection boundaries, rate/token limits, cost tracking, timeouts, safe errors and provider outage behavior. Never expose secrets or cross-tenant data. Select cost-effective models when quality is supported by evaluation; no unapproved provider changes or paid benchmarks. Maintain a feature off switch and graceful static-help fallback.

## 5. Inline AI writing
PR #140 already implemented Draft/Improve/Shorten for specific owner fields with review-before-apply and usage limits. Verify it exists and do NOT rebuild it. Only address demonstrated defects or important missing integration points. Suggestions must preserve facts, numbers and policies, use authorized tenant data, never overwrite text automatically, never publish/send content or change consequential settings. Evaluate real wording quality only with approval for paid model calls; otherwise note unverified. Existing reported limits: 10/min and 40/day/business; confirm in code.

## 6. Lean AI architecture, performance, cost and scalability
PR #138 already implemented evidence-supported optimizations. Do not repeat its audit or refactor. Verify existing telemetry and identify *new* demonstrable bottlenecks in model routing, context size, caching, per-turn cost, time to first token/words, provider latency, voice-specific path, timeouts/retries, concurrency and per-business caps. Important: #138 improvements applied to website chat/Retell, NOT necessarily OpenAI voice used by most callers. Distinguish local simulated timing and cost estimates from real production data. No new paid model calls just to benchmark without approval. If natural production volume is insufficient, report uncertainty and leave instrumentation/checkpoints rather than fabricate savings.

Evaluate growth at 10/100/1000 businesses by modeling request volume, provider quotas, database contention, concurrency and costs; label assumptions. A platform-wide AI spending ceiling is a worthwhile candidate before large-scale onboarding, but do not add production spend switches or change existing caps without evaluating effects and obtaining required approval. Fix only evidenced reliability/security/efficiency issues. No speculative gateway, vector DB, new providers, microservices or agent framework. Maintain clear data, authorization, model, tool and audit boundaries that permit future web/mobile/voice/wearable/robot interfaces without building those products now.

## 7. Security and reliability
Preserve authentication, tenant authorization, secret handling, CSRF where applicable, input validation, usage caps, approval gates, safe error handling and production rollback. Run proportional checks on modified boundaries rather than a new full unrelated audit. Test prompt injection and cross-tenant access for new AI functionality; model output is untrusted. Never let AI perform unrestricted tool calls, publish ads, message customers, charge cards, modify billing or production settings autonomously. Avoid destructive migrations and sensitive permission expansions without approval. Handle API/provider failures gracefully.

## 8. Commercial readiness and customer value
Validate Growth journey: visitor → pricing → enrollment gate → Stripe checkout (only if legitimately open and approved) → onboarding → Google connection → hours → booking page → booking. Do NOT enable enrollment, live charges, or make a real purchase without approval. When gated, test truthful gated UX and report live payment path unverified.

Validate Enterprise journey: visitor → Contact Sales → validation → persisted lead → admin visibility → manual follow-up. No fake production leads without approval. Check that the sales assistant knows the current plans, and report that new answers still need explicit admin apply if so.

Check Google Calendar app verification status, Google Ads API access level and actual campaign-import coverage (two test accounts previously returned zero campaigns). No ad launches, campaign changes or spend. Check founder failure alerts status without enabling live outbound emails. Respect messaging launch gates. Identify terms/privacy, sales-tax and live Stripe decisions as owner blockers rather than silently resolving them.

Measure customer value with honest data: lead count, qualification, booking conversion, show-up/completed service, cost per lead/booking, attributable revenue when verified, follow-up outcomes and time saved where measured. Separate observed, estimated, missing and unsupported metrics. Do not create decorative KPI dashboards without actionable value.

## 9. Autonomous phases and release policy
Proceed in reviewable, independently deployable workstreams, coordinating parallel work safely:
A. Reconcile state, save plan and progress, optimize measured engineering bottlenecks.
B. Truthful homepage and sales UX improvements (skip already shipped strip and pricing).
C. Priority onboarding/booking/Ads/analytics usability improvements.
D. Contextual static help components and coverage.
E. Secure optional contextual dashboard AI chat.
F. Verify/integrate existing inline writing, fix only proven issues.
G. Evidence-based AI/software architecture improvements, no repeated #138 work.
H. Commercial journey checks and actionable KPIs.
I. Final integration, regression, production verification and reporting.

For each phase: inspect existing code → implement scoped change → targeted tests → self-review/fix → required CI → verify mergeability → merge/deploy if previously authorized for safe non-destructive changes → production verify → update progress → CONTINUE AUTOMATICALLY to next phase. Do not stop merely because a PR merged. Avoid indefinite watchers. Stop for genuine blocker, consequential approval, or completion; continue other safe independent work when blocked.

Existing authorization covers safe, scoped, non-destructive code merges and deployments after all release gates pass. Explicit user approval required for live ad spend/campaign launches, customer messaging, live billing or charges, enrollment gate changes, production secrets, destructive data/migrations, sensitive permission expansions, paid AI/model changes, applying sales assistant answers, and irreversible external actions. Do not silently infer new permissions. Maintain rollback target and verify no critical regression.

## 10. Definition of done and final report
Done means truthful full-funnel public messaging, correct pricing and integration claims, intuitive priority workflows, working zero-cost contextual help, secure opt-in AI Assist, existing inline writing verified, lean/evidence-based architecture, intact auth/tenant/cost controls, passing CI/tests, production-verified authorized releases, measured engineering improvements where possible, and explicit unresolved launch blockers. Do not claim full commercial readiness when checkout/approvals remain gated.

Final concise report: completed vs skipped work; PRs/commits/deployments; tests/CI and production verification; AI/software architecture findings and measured vs estimated improvements; security/cost controls; launch readiness; external approvals/blockers; one highest-value next action. Do not expand into speculative projects or endlessly re-audit. Continue until all feasible phases are done.

END OF PLAN
