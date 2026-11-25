# GetShowUps: the founder's overview (V1, 2026-11-25)

The one page to start from. Details stay in the linked documents; where they differ from this page, the code and the newer date win.
Live switch and release facts: `/admin/review`. Decisions waiting for the founder: the local launch folder.

## What it does

A service business gets a website, online booking into its own Google Calendar, an AI receptionist, follow-ups, ads it approves,
and a dashboard with an assistant that reads its records. Growth is $499 a month.

## State of each capability

| Capability | State | Evidence |
| --- | --- | --- |
| Website, own domain, booking into Google Calendar | Live (pilots) | production bookings 2026-11-18; live pages compared at every release |
| Dashboard, outcomes, payments recorded by the owner | Live (pilots) | production |
| Owner's assistant (Claude Haiku 5.5) | Live | test business in production, 2026-11-25 |
| Receptionist chat | Live per business the owner turns on | production conversations |
| Receptionist voice in the browser | Live for released businesses | production; no phone line exists |
| Teach Your AI | Editing for all; customers only where AI_RULES_LIVE_BUSINESSES names the business | local real-model tests; not yet with real customers |
| Founder alerts, health, backups, audit log | Live | production |
| Sign-up and payment | Stripe test mode; enrollment closed | browser tests |
| Email to customers | Off except test recipients | MESSAGES_LIVE |
| Texts | Off | SMS_LIVE, Twilio |
| Google Ads, Local Services reading | Test account only; nothing can spend | ADS_LIVE_LAUNCH |
| Calls from Google ads | Built, off | GOOGLE_CALLS_ENABLED, migration 0040 |
| Meta ads; ChatGPT ads | Built against stand-ins, off; never seen with a real account | docs/META_ADS.md, docs/OPENAI_ADS.md |
| Account deletion | Built, off | ACCOUNT_DELETION_ENABLED |
| Phone line, call routing, recordings | Not built | by decision |

## How it fits together

Browser → Cloudflare Pages Functions (`functions/`, thin) → `server/` modules → D1 (records), KV (encrypted Google credentials),
R2 only for ad images when set. A scheduled Worker calls `/api/cron/run` every 5 minutes for messages, safety stops and checks.
Deploys come from `main` (docs/WORKFLOW.md); migrations are applied by hand first.

**Shared intelligence** (docs/INTELLIGENCE.md): one body of facts per business, records plus what the owner published in Teach Your
AI, read per role. Receptionist and website see customer-facing facts; ads planning and the owner's assistant also see internal
notes, seasons, margins. `server/ads/economics.js` follows every source to booked, completed and paid. The models write words;
code checks claims, numbers, references and permissions, and only the owner's button saves. ChatGPT ads plans don't read the
shared knowledge yet. The assistant's conversations stay in the owner's browser.

**Outside services:** Cloudflare, Google (Calendar, sign-in, Ads), Anthropic, OpenAI or Retell or ElevenLabs (voice, one at a time),
Stripe, Resend. Twilio, Meta and OpenAI Ads are built but unused.

## What must never break

| Invariant | Held by |
| --- | --- |
| One business never sees or changes another's | session → business id; every query scoped; isolation tests |
| A time is booked once, only if offered | unique index; calendar check; our own event id |
| Nothing is claimed sent, booked or paid unless it was | provider answer recorded; claims checks |
| No live charge, message, ad spend or deletion without the founder's switch | switches off unless exactly `true`; tests |
| Money reports use recorded payments only; cost only with measured spend | server/ads/funnel.js, economics.js |
| Payment, deletion and admin actions leave a permanent trail | audit_log, hash-chained |
| Customers' words and imported text are never instructions | engine rules, fixed tools |
| AI can propose; only the owner's button changes anything | proposals.js |
| Test sessions reach only the test business and a short list of routes | server/acceptance.js, acceptance-routes.js |

## Watching it

| Check | Where | When |
| --- | --- | --- |
| Alerts by email | founder alerts | when they arrive |
| Open incidents, affected businesses, assistant answers owners reported | `/admin/control` | daily, 5 minutes |
| Capabilities, switches, migrations, audit chain, reconciliation | `/admin/review` | weekly, 20 minutes |
| `{"status":"ok"}` from `/api/health` | an outside monitor (founder to set up) | every 5 minutes |
| Backup age | `node scripts/backup-policy.mjs` | monthly |

## When something is wrong

1. Code: roll back in Cloudflare Pages → Deployments. Each release prints its rollback target. Data isn't touched.
2. One feature: turn its switch off (docs/OPERATIONS.md); `AI_ASSIST_CHAT_ENABLED=false`, `RECEPTIONIST_ENABLED=false`,
   `ADS_ENABLED=false`, `MESSAGING_KILL_SWITCH=true` are the stops.
3. Data: docs/BACKUPS.md. Never restore to undo a release. Deletions are replayed after any restore.
4. A leaked or lost key: docs/KEY_ROTATION.md (never run in production yet).

## Known risks

| Risk | Now | Reduced by |
| --- | --- | --- |
| One founder has every approval | accepted | written runbooks; a second trusted admin later |
| Google verification pending | warning screen, 100 users | founder submission |
| No restore into Cloudflare D1 has been exercised | local restore only | a drill on synthetic data |
| Workers Free limits | daily AI allowance for website copy; 7-day database history | Workers Paid (approval) |
| AI wording varies | in the last 423 test answers, 34 drafts were corrected before showing and 2 were held back; amounts and statuses are checked by code, wording isn't | owner reports on `/admin/control` |
| No platform-wide daily AI cost ceiling for the receptionist | per-business ceilings | add before 100 businesses |
| Ads, texts, live payments never run with real accounts | off | staged activation, one at a time |
| Rate limits and some counters fail open on a storage error | accepted | alerts |

## Who does what

| Role | Owner |
| --- | --- |
| Approvals, accounts, money, legal, customers | Founder |
| Product engineering, releases, verification | Claude engineering session |
| Acquisition, sales answers, homepage funnel | Claude commercial session |
| Independent check of consequential changes | a separate agent that did not write them, with its own tests |

One release at a time, announced between sessions. A consequential change (money, tenant data, messages, sign-in, deletion) is
merged only after: tests, CI, an independent review whose findings are resolved, and a rollback target.

**V1 feature freeze:** new engineering needs a genuine defect, customer feedback, a measured commercial result or an operational
need. The next milestone is the first paying customer.
