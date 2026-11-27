# Business phone lines

Status (2026-11-26): built and tested against simulated Twilio and Retell. **Not live.** No number has been bought and no real
call has been placed. Everything is off until the approvals in "Activation" are given.

## What it does

A customer calls the business's GetShowUps number (or the business's own number, which forwards to it):

1. **The team rings first** (optional): every *verified* phone on the list rings at once for 10–45 seconds. Whoever presses 1
   takes the call. A voicemail that picks up never counts as answered.
2. **If nobody answers** (or it's after hours, if the owner chose that):
   - **AI receptionist**: the same engine, knowledge, services, prices, policies and booking times as website chat and browser
     voice. It is offered only when the receptionist is on and voice is released for the business.
   - **Call back**: a short message ("your number has been saved so they can call you back"). The call becomes a callback
     request in Needs attention, with the usual owner email.
3. **Every call is recorded as a row**: caller number (none if hidden), time, length, outcome, and where the number is shown.
   A row links to a customer only on evidence: an exact number that belongs to one person on record, or the AI
   conversation's own inquiry or booking.

Owners set this up under **Settings → Phone line**. The Receptionist page reports the line's state and links there; its old,
disabled "Phone calls" choices are no longer shown once lines are available, so routing has one place. The owner
assistant reads calls through `list_calls` (outcomes and person refs, never a phone number). Setup check flags a line
that rings nobody. `phoneSetup(env, id)` is the one status for the assisted-enrollment checklist.

Click-to-call already exists: the website's Call button (first screen and Contact page) and the booking page's call link and
confirmation use the phone on record. "Show this number on my website" sets that phone to the line, after a confirmation,
so no renderer change was needed.

## Architecture (one provider per job, reusing what exists)

| Part | Choice | Why |
| --- | --- | --- |
| Numbers, ringing, call events | **Twilio**, a number in the business's **own subaccount** (already used for texting, `server/followups/twilio.js`) | Per-business isolation, webhooks signed per subaccount, numbers released when the subaccount closes at account deletion. Bought and configured by API, so there's no console step per customer. |
| AI answering | **Retell custom telephony**: `POST /v2/register-phone-call`, then Twilio dials `sip:<call_id>@sip.retellai.com` | Same shared custom-LLM agent and engine as browser voice; the call id routes the LLM socket to the business (`receptionist_calls`). |
| Logic | `server/telephony/` (calls.js, lines.js, twiml.js); webhooks `functions/api/phone/twilio/[step].js`; owner route `functions/api/dashboard/phone.js` | Thin routes, logic in server modules. |

Webhook steps are voice, screen, dial, ai, status and verify. Each is signed with the subaccount token and answered only for
the business that owns that subaccount. `server/receptionist/routing.js` (the older pure plan) is kept for the
receptionist's descriptions; phone calls use `planCall()`.

Not used: Retell's own numbers (a second number provider), Twilio Studio or console flows, and SIP trunks. Retell transfer
doesn't work with this method; the team rings **before** the AI, so no transfer is needed.

## Safety

- **Tenant isolation**: a number, call or destination is acted on only when the subaccount that signed the webhook owns it.
  A parent-signed or unsigned request routes nowhere. Owner routes use the session's business only.
- **Verified destinations, and toll fraud**: US numbers only. Premium-rate (900, 976, …) and N11 numbers are refused. A
  number rings only after a verification call where the person types a 4-digit code shown on the owner's screen. The code
  is stored hashed, expires after 10 minutes, allows 3 tries, and is never sent to the provider. There are at most 6
  verification calls per business per day and 5 phones per business. Outbound calls are made only to verified numbers
  and to Retell.
- **Loops**: our own lines and the owner's forwarding number can't be added as destinations, and the reverse is refused
  too. A call that arrives forwarded from a team phone or from one of our lines is rejected (`<Reject reason="busy">`).
  Each line takes at most 60 incoming calls an hour.
- **Idempotency**: CallSid is the key. Outcomes only move forward. One callback task per call (unique id `call:<CallSid>`).
- **Limits**: `PHONE_CONCURRENT` (default 3 calls at once) and `PHONE_DAILY_MINUTES` (default 120 per business, rolling
  24 h). Over a limit, the caller gets the callback message: no ringing and no AI.
- **Recording**: doesn't exist. There's no setting, column or `<Record>`. Adding it would need consent wording,
  retention rules and approval.
- **Failures**: if Retell is unreachable or refuses, the caller falls back to the callback path (`phone.ai_unavailable`
  event). A webhook error ends with a spoken apology, never silence. An unknown purchase outcome is never retried blindly.
- **Test businesses**: they never place a real call or buy a real number (only against the loopback mock).
- **Data**: retention, deletion and export are covered in docs/DATA_RETENTION.md. Logs and events carry codes only, never
  numbers.

## Costs (published US prices, read 2026-11-26; estimates, not bills)

| Item | Price |
| --- | --- |
| Twilio local number | $1.15 / month |
| Caller's leg (inbound) | $0.0085 / min |
| Each answered team leg | $0.014 / min |
| Leg to the AI (SIP) | $0.004 / min |
| Retell for the AI leg | $0.055 voice infrastructure + $0.015 voice ≈ $0.07 / min. Retell lists no custom-LLM charge, so our Claude cost is extra. |
| Verification call | about $0.014 each |
| Recording / transcription (not used) | $0.0025 / min, $0.05 / min |

Examples, per month, for a business with 150 calls of 3 minutes:

| Scenario | Estimated cost |
| --- | --- |
| All answered by the team | about $11 |
| All taken by the AI | about $40, plus model cost |

Settings → Phone line shows the month's calls, minutes and this estimate, labelled as an estimate. A provider-reported price
(`price_micros`) is shown only when every call has one; fetching it isn't built yet.

**Recommendation (no pricing change made)**: include one number and a generous allowance, for example 500 minutes a month,
in Growth. Phone costs at that level are small next to $499. Meter AI minutes separately above an allowance, because
an AI-answered minute costs about 4× a team-answered one (about $0.08 vs $0.02). Decide before the first external customer.

## Activation (each needs approval)

1. **Privacy policy**: name call records (caller number, time, length, outcome) and say that calls aren't recorded.
   `PHONE_ENABLED` must stay off until the policy is published.
2. Apply **migration 0049** (additive) to production.
3. `PHONE_ENABLED=true` turns on the Phone card, webhooks and verification calls (paid, small).
4. `PHONE_NUMBER_PURCHASE=true` lets owners buy numbers ($1.15 / month each, on our Twilio account).
5. For AI answering: the business has the receptionist on and is in `RECEPTIONIST_VOICE_BUSINESSES`. The Retell agent needs
   no change. Retell bills the minutes.
6. Twilio account: voice geographic permissions US-only on the parent account (subaccounts inherit), and the account
   funded. This is the one console check, done once, not per customer.
7. First live check on PoolThru: buy one number, verify the owner's cell, call it once answered and once unanswered,
   confirm the rows, then decide on showing it on the website.

## Not built (deliberately)

- Porting an existing number into Twilio (forwarding covers keeping a number).
- Per-campaign tracking numbers or dynamic number insertion. Attribution is only the owner's label on each number.
- Outbound calling from the dashboard, voicemail, recording, transcripts of team-answered calls, and a live transfer from
  the AI to a person.
- Fetching Twilio's per-call price (the column exists; the estimate is shown meanwhile).
