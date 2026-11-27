# AI spending and abuse protection

Verified 2026-11-27 against the code and with mocked providers (`test/ai-budget.test.js`,
`test/receptionist.test.js`). No real model calls were made. Production settings were not changed.

## One spending guard: `server/ai-budget.js`

Every model call **GetShowUps pays for** reserves its **worst case** first, before the provider is called. The worst case is
the input estimate plus every output token allowed. One SQL statement charges four daily counters at once, and only if all
of them stay under their ceilings:

| Ceiling (UTC day) | Default | Variable |
| --- | --- | --- |
| Whole platform | $25 | `AI_PLATFORM_DAILY_MICROS` |
| Public entry points together (receptionist) | $15 | `AI_PUBLIC_DAILY_MICROS` |
| One business, every entry point | $6 | `AI_BUSINESS_DAILY_MICROS` |
| One business, one entry point | receptionist $5 (`RECEPTIONIST_DAILY_MICROS`); teach, assistant, ads plan, ads images $1 each | `ENTRIES` |

- **Atomic**: requests that arrive at the same moment can't pass a ceiling together. A refusal charges nothing. Tested with
  40 simultaneous requests against a $1 ceiling: exactly 10 passed.
- **Settled**: after the call, the reservation is replaced by the provider's reported cost. An aborted stream or a timeout
  keeps its worst case, because it may have been billed.
- **Fails closed**: if the counters can't be read or written, no call is made. Request rate limits, by contrast, fail open.
- **Tenants**: one business's abuse stops at its own ceiling. The public ceiling stops the receptionist using up the
  platform allowance that owner tools need.
- **Fallback**: when refused, the receptionist gives its fixed reply with the booking link and contact details. The
  Assistant answers from records. Teach Your AI keeps its fixed patterns. Ads calls return the code `ai_limit`.
- **Emergency off** (Cloudflare variable, effective on the next request, no deploy): `AI_ALL_OFF=true`, or
  `AI_OFF_BUSINESSES=a,b` for listed businesses only. These also stop browser voice sessions from starting.
- **Visibility**: Admin → "AI spending today" shows platform and public totals against their ceilings, the top businesses,
  each entry point and the switch states.

Counters live in `rate_limits` (keys `aib:<scope>:<day>`), so no migration is needed.

## Entry points

| Entry point | Who can reach it | Paid by | Guards |
| --- | --- | --- | --- |
| Receptionist: standalone chat, website panel, homepage sales chat, Retell voice turns, (future) phone AI turns | Public | GetShowUps (Claude) | Shared guard on every model call. 40 turns per IP per 10 min, 600 per business per hour. 60 turns and $1 per conversation. 6 model calls per turn, 4,096 output tokens, 1,500 input characters, 25 s / 10 s timeouts, 1 retry. Tools run server-side, bound to the business. |
| Browser voice minutes (OpenAI, ElevenLabs, Retell) | Public | GetShowUps (per minute) | Emergency switches. 6 starts per IP per 10 min, 60 per business per hour, 3 at once, 15 min per session, 120 min per business per day. OpenAI and ElevenLabs: 600 min per provider per day. **Retell: no platform cap unless set** (below). |
| Owner Assistant | Owner (session) | GetShowUps (Claude Haiku) or free Workers AI | Shared guard (Claude). Existing $2 per day and $0.10 per business. 5 per minute, 60 attempts per day, 25 per day across the platform, 20 answers per day. |
| Teach Your AI | Owner | GetShowUps (Claude) | Shared guard. 60 model requests per business per day, 30 per hour. |
| Ads plan / ad images | Owner | GetShowUps (Claude / OpenAI) | Shared guard plus their monthly allowance. 6 plans and 12 images per hour. |
| Website writing, AI website copy, follow-up texts | Owner / system | Workers AI (free daily quota) | Per-business daily limits. The free quota cannot bill: the account is on Workers Free. If it moves to Workers Paid, these need the shared guard too. |
| Website designer, own key | Owner | The owner's own key | Monthly limit. Never GetShowUps money. |

Other protections already in place: dashboard routes take the business from the session and check same origin. Public
routes check signed tokens and offered slots. Customer text never enters the system prompt, and tools are bound to the
business (`test/receptionist.test.js` prompt-injection and tenant-isolation tests). Errors are allowlisted codes.

## Ceilings verified (defaults)

- **GetShowUps-paid model spend**: at most $25 a day in total, $15 of it from the public receptionist, $6 per business.
- **Voice minutes**: at most 600 min a day each for OpenAI and ElevenLabs, and 120 min per business. Retell has no
  platform-wide minute cap yet.

## Gaps and what needs approval

1. **Set `VOICE_PROVIDER_DAILY_MINUTES_RETELL`** (Cloudflare variable). Without it, Retell minutes are capped only per
   business. 600 is suggested: about $42 a day at $0.07 per minute, before model cost, which the shared guard bounds.
2. **Cloudflare**: what can be confirmed from outside is that traffic goes through Cloudflare (`server: cloudflare`,
   HSTS). WAF custom rules, Bot Fight Mode, Cloudflare rate-limiting rules and Turnstile **could not be read** with the
   tools available here. Only the founder's dashboard shows them, so treat them as "available, not known to be enabled."
   Recommended (free plan):
   - Bot Fight Mode on.
   - One rate-limiting rule on `POST /api/receptionist/*`, 60 requests per minute per IP, as an edge backstop.
3. **Turnstile**: not built and not needed yet. Spend is now hard-capped server-side. If bots exhaust the public ceiling
   (visible in Admin), add a Turnstile check when a conversation starts. That needs a Cloudflare widget, the founder's
   approval and a privacy-policy line.
4. Request rate limits fail open when D1 is unavailable. Money no longer depends on them, because the guard fails closed.
