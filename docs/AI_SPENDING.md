# AI spending and abuse protection

Verified 2026-11-27 against the code and with mocked providers (`test/ai-budget.test.js`, `test/receptionist.test.js`,
`test/e2e/admin.spec.js`). No real model calls were made. Production settings were not changed.

## Limits (defaults; change them in Admin → "AI spending today")

| Limit (UTC day) | Default | Setting |
| --- | --- | --- |
| All GetShowUps-paid AI on the platform | **$5** | `platform_micros` |
| Public chat and voice AI (receptionist), all businesses together | **$3** | `public_micros` |
| One business, every AI feature | **$1** | `business_micros` |
| Retell voice minutes, platform-wide (browser voice and, later, phone AI) | **60 min** | `retell_minutes` |
| Everything off | off | `all_off` |

- **Changing a limit**: Admin → "AI spending today" → change the number → "Change …" → type a reason → "Save the new
  limit". Only platform admins can do this, from the same origin, at most 30 changes per 10 minutes. Each change is
  audited with who, from, to and the reason (`admin_audit` action `ai_budget.set`). It applies within 30 seconds with no
  deploy. Ceilings can be set up to $100 a day, and Retell up to 1,000 minutes.
- **Stricter limits that stay in force** (the effective limit is always the lowest one):
  - receptionist: $1 per conversation, 60 turns, and its own `RECEPTIONIST_DAILY_MICROS`
  - Teach, Assistant, ads plan, ad images: $1 per business each
  - the Assistant's own `OPERATOR_*` dollar limits and its 20 answers a day
  - every request rate limit
  - voice minute limits: 120 per business, 600 per provider for OpenAI and ElevenLabs
  - The `AI_*_DAILY_MICROS` variables can only **lower** the admin settings.
- **Warnings**: the card shows "over 80% of its limit" and "limit reached (AI refused, fallbacks shown)" for the platform,
  the public share, each business and Retell minutes.
- **Emergency off**:
  - "Turn all AI off now" on the card (audited, takes effect within 30 seconds).
  - For one business: the admin restriction **"All AI paid by GetShowUps"** (business → Controls, reason required, audited).
  - Without the database: the Cloudflare variables `AI_ALL_OFF=true` and `AI_OFF_BUSINESSES=a,b`.
  - All of them stop model calls and voice starts. Customers get the booking and contact fallback.

## How a model call is capped (`server/ai-budget.js`)

1. **Before** the provider is called, the call's worst case (input estimate plus every output token allowed) is charged
   against the platform, public (public entry points only), business and entry counters in **one conditional SQL
   statement**. Either all are charged or none, and only if every counter stays under its limit. Requests that arrive at
   the same moment can't pass a limit together: in the test, 40 simultaneous requests against $1 gave exactly 10.
2. **After** the call, the charge is replaced by the provider's reported cost.
3. **Fails closed**: unreadable counters, settings or restrictions mean no call. Request rate limits, by contrast, fail
   open; spending doesn't rely on them.

Entry points:
- **Receptionist** (public, every model call): standalone chat, website panel, homepage sales chat, Retell voice turns,
  and future phone AI turns.
- **Owner tools**: Teach Your AI, the owner Assistant on Claude, the ads plan, ad images.
- **Not covered**: Workers AI features (free daily quota; the account is on Workers Free, so they can't bill) and calls on
  an owner's own key (the owner pays).

## What each cost is, and how strictly it is capped

| Cost | Paid to | In the dollar guard? | How it is capped | Strict? |
| --- | --- | --- | --- | --- |
| Receptionist, Teach, Assistant, ads plan: Claude tokens | Anthropic | Yes | Reserved before the call, settled after | **Yes**, except the timeout row below |
| Ad images | OpenAI | Yes | Image price reserved before the call | **Yes** |
| A first attempt the SDK retries after a timeout (`maxRetries: 1`) | Anthropic | Only if reported | The SDK reports usage only for the attempt that succeeds | **No**: at most one extra call per request, only on provider timeouts (visible as `model_timeout` events) |
| Concurrent requests | — | Yes | One atomic statement | **Yes** |
| Failed requests | — | Yes | A provider refusal (HTTP status) is settled at $0; a timeout or abort keeps its worst case | **Yes** (conservative) |
| **Retell voice minutes** | Retell (about $0.07/min) | **No**: separate, counted in minutes | `retell_minutes` (default 60/day). A start is allowed only if finished calls, plus every open call at its full 15-minute ceiling, plus this call fit. Unreadable means refused. | **Nearly**: starts that land in the same instant can each pass before the other is recorded. Bounded by 3 calls at once per business and 6 starts per IP per 10 min. Retell also bills hold time and short calls as 10 s, so its bill can exceed our measured minutes slightly. |
| The model inside a Retell call | Anthropic (our engine) | Yes | Each turn is reserved like chat | **Yes** |
| OpenAI and ElevenLabs browser voice minutes | OpenAI, ElevenLabs | No (minutes) | 600 min per provider per day, 120 per business, 3 at once, 15 min per session | **No**: a running session counts only elapsed time, so calls already running can exceed the day's minutes by up to 15 min each |
| Phone lines (PR #192, off) | Twilio | No | `PHONE_DAILY_MINUTES`, `PHONE_CONCURRENT`; AI turns go through the guard; the AI leg's Retell minutes count toward `retell_minutes` | Off until approved |
| Sign-in emails (Claude 2, PR #198) | Resend | No | 300 per hour platform-wide, 5 per address per hour, 10 per IP per 10 min; test recipients only until `AUTH_EMAIL_LIVE` | Yes, by count |

## Cloudflare (dashboard, Free plan): what to enable and what not to

Checked against Cloudflare's docs on 2026-11-27. From outside I could only confirm that traffic goes through Cloudflare
(`server: cloudflare`, HSTS). The zone's security settings can't be read from here, so the list below is what's
**available**, not what's enabled.

**Do not turn on Bot Fight Mode.** Cloudflare: "You cannot bypass or skip Bot Fight Mode using WAF custom rules or Page
Rules", and it "may challenge API or mobile app traffic". It would apply to:
- Stripe, Twilio, Resend and Meta webhooks
- the scheduler Worker's `/api/cron/run`
- Retell's connection to `/api/receptionist/llm/…`

None of these can be exempted, so a challenged webhook means a missed payment event or call. Super Bot Fight Mode supports
exemptions but is a paid plan: deferred.

**Add one rate-limiting rule** (Free allows one: counted per IP, 10-second period, 10-second block, matched by path only):
1. Cloudflare dashboard → the getshowups.com zone → **Security → Security rules** → **Create rule** → **Rate limiting
   rules**.
2. Rule name: `Receptionist burst guard`.
3. "When incoming requests match…": **Edit expression** and paste:
   `(starts_with(http.request.uri.path, "/api/receptionist/") and not starts_with(http.request.uri.path, "/api/receptionist/llm/"))`
   - If the editor refuses `starts_with`, use the builder: *URI Path* **contains** `/api/receptionist/` **and** *URI Path*
     **does not contain** `/api/receptionist/llm/`.
4. Counting: **IP**. Rate: **30 requests per 10 seconds**. Action: **Block** for **10 seconds**.
5. **Deploy**. Afterwards, Security → Analytics → Events, filtered by the rule, should show no blocks of normal use.

Why this is safe: it covers only customer chat and voice requests. Our own limit for those is 40 turns per 10 minutes,
so 30 in 10 seconds is never reached by a person. It never matches sign-in (`/api/auth/*`), booking (`/api/book/*`),
Stripe (`/api/stripe/webhook`), Twilio (`/api/sms/*`, `/api/phone/*`), Resend, Meta, the scheduler or Retell's socket.

**Turnstile: deferred.** Spending is hard-capped server-side, and per-IP and per-business limits stop single sources.
What remains is many IPs together. That ends at the $3 public limit and is visible on the card ("limit reached"). Add
Turnstile at the start of a conversation if the card shows the public limit reached by traffic that isn't customers.
That needs a Cloudflare widget, approval and a privacy-policy line.
