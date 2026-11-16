# Texting and follow-ups: activation runbook

Build 49 deployed the follow-up engine, two-way texting, the assistant and A2P 10DLC tracking with **live texting
off**. Step 0 is done (2026-11-16); nothing else below has been done. Each step needs the approval noted, in order.
Registration details (ISV profile, brand types, campaign fields, fees, review): docs/A2P_REGISTRATION.md.

## 0. Database — DONE 2026-11-16 (approved; 4 tables + 5 indexes verified, existing data unchanged)

```
npx wrangler d1 execute getshowups-onboarding --remote --file migrations/0024_followups.sql
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
   - Opt-out: **enable Advanced Opt-Out** on the Messaging Service (Opt-out tab; only Twilio support can turn it off
     again) with the business's HELP text (docs/A2P_REGISTRATION.md). Twilio then answers STOP/START/HELP and tells
     us (`OptOutType`); GetShowUps records it and never sends a second answer. Plain default handling also
     auto-replies but may not send `OptOutType`, which would make START/HELP answered twice.

## 2. Per business: registration (A2P 10DLC)

1. The owner opens Follow-ups → Texting → **Start texting registration**, enters the business details and approves
   submission (the attestation is stored with time and an owner reference). We never fill this in for them.
   From then on the optional texting box is shown on the booking page and website forms (carriers review the live
   opt-in before approving); consent is recorded, but no text is sent before the provider approves. A rejected or
   suspended registration, or the kill switch, hides the box again.
2. A platform admin submits in Twilio (secondary customer profile → brand → campaign; brand type per business:
   docs/A2P_REGISTRATION.md; description, message flow and samples exactly as shown to the owner; opt-in evidence URL =
   `https://getshowups.com/sms-terms/<business id>` (both boxes, exact wording), plus the business's booking page). Cost: brand + campaign fees
   (approval: spend).
3. In /admin → Follow-ups and texting → **Record**: status `pending` after submitting; later `approved` or `rejected`
   (with Twilio's reason) **only as Twilio reports it**.

## 3. Per business: sender (approval: phone number purchase)

1. Buy a 10DLC number for the business and put it in a Messaging Service linked to the approved campaign.
2. /admin → Record → Messaging Service SID (`MG…`) and/or sender number (`+1…`). One business per sender.

Only after the campaign is approved (no A2P traffic before), the business can text **test recipients** (`MESSAGE_TEST_RECIPIENTS`) — verify end to end: form with the texting box
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
