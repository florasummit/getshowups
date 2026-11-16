# Texting and follow-ups: activation runbook

Build 49 deployed the follow-up engine, two-way texting, the assistant and A2P 10DLC tracking with **live texting
off**. Nothing below has been done; each step needs the approval noted. Steps are in order.

## 0. Database (approval: production migration)

```
npx wrangler d1 execute ONBOARDING_DB --remote --file migrations/0024_followups.sql
```

Additive and idempotent (4 new tables, no change to existing ones). Until it is applied, Follow-ups shows "being set up",
the engine does nothing, and every existing flow (leads, booking, emails, confirmations, reminders) works as before.
After it is applied: website-form leads get an immediate acknowledgment email (owner preference, on by default) and
conversations appear in the dashboard. Email still follows `MESSAGES_LIVE` (test recipients only until it is `true`).

## 1. Twilio account (approval: paid service)

1. Create or choose the Twilio account (production, upgraded, billing set).
2. Cloudflare Pages → getshowups → Settings → Variables (Production), as **secrets**:
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`. (No platform-wide sender: each business texts from its own.)
3. Webhooks, on each business's Messaging Service (step 3) → Integration:
   - Incoming messages: `https://getshowups.com/api/sms/twilio/inbound` (HTTP POST). Status callbacks are set per
     message by GetShowUps.
   - Advanced Opt-Out: keep STOP handling on (Twilio sends the STOP confirmation). Turn the default HELP auto-reply
     **off** (GetShowUps sends the business-specific HELP answer).

## 2. Per business: registration (A2P 10DLC)

1. The owner opens Follow-ups → Texting → **Start texting registration**, enters the business details and approves
   submission (the attestation is stored with time and an owner reference). We never fill this in for them.
2. A platform admin submits in Twilio (Trust Hub: customer profile → A2P brand → campaign, use case "Customer care /
   Account notifications", samples and use-case text exactly as shown to the owner; opt-in proof URL =
   `https://getshowups.com/sms-terms/<business id>`, plus the business's booking page). Cost: brand + campaign fees
   (approval: spend).
3. In /admin → Follow-ups and texting → **Record**: status `pending` after submitting; later `approved` or `rejected`
   (with Twilio's reason) **only as Twilio reports it**.

## 3. Per business: sender (approval: phone number purchase)

1. Buy a 10DLC number for the business and put it in a Messaging Service linked to the approved campaign.
2. /admin → Record → Messaging Service SID (`MG…`) and/or sender number (`+1…`). One business per sender.

The business can now text **test recipients** (`MESSAGE_TEST_RECIPIENTS`) — verify end to end: form with the texting box
→ acknowledgment text → reply → assistant/fixed answer → STOP → no more texts.

## 4. Live switches (approval each)

| Switch | Effect |
| --- | --- |
| `SMS_LIVE=true` | Texts may reach real customers (still only for approved businesses with consent). |
| `FOLLOWUP_AI=true` | The assistant answers texts with the included model (needs the `AI` binding; ≤ $0.20/business/day). Off: fixed safe replies, owner asked. |
| `MESSAGES_LIVE=true` | Emails (and texts) leave test mode. |
| `MESSAGING_KILL_SWITCH=true` | Emergency stop for every automatic email/text (nothing sent later in a burst). |

## What to watch (/admin → Follow-ups and texting)

Send/delivery failures, assistant fallbacks, opt-outs, hand-offs, webhook problems, stuck work, unusual volume
(> 100 messages/hour for one business), cost estimates per business. Business Review lists the capabilities
`followups.engine`, `followups.sms`, `followups.assistant`, `followups.registration`.
