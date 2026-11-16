# Texting and follow-ups: activation runbook

Architecture: ONE GetShowUps parent Twilio account, ONE Twilio **subaccount per business** (Twilio's preferred ISV
setup). Each business's registration, Messaging Service, number, opt-outs and usage live in its own subaccount.
Registration runs step by step from /admin (server/followups/provisioning.js, through Twilio's APIs), each step
confirmed and audited. Details, brand types, fees and review: docs/A2P_REGISTRATION.md.

Done: migration 0024 (2026-11-16). Nothing else below has been done. Each step needs the approval noted, in order.
`SMS_LIVE`, `FOLLOWUP_AI`, `MESSAGES_LIVE` stay off.

## 0. Databases

- 0024_followups — DONE 2026-11-16.
- **0025_twilio_accounts (approval: production migration)** — 3 new tables (`sms_accounts`, `sms_provider_objects`,
  `sms_registration_extra`), additive, no change to existing ones:
  ```
  npx wrangler d1 execute getshowups-onboarding --remote --file migrations/0025_twilio_accounts.sql
  ```
  Until it is applied no business can text (readiness `no_account`) and Twilio setup shows "not available"; everything
  else works as before. Owners who saved texting details before 0025 must re-save them (address, representative,
  industry are stored only from 0025 on).

## 1. GetShowUps parent account (founder; approvals: paid service, legal attestation, secrets)

1. Twilio Console: upgrade the account (paid) and enable billing.
2. Trust Hub → Customer Profiles → create GetShowUps's **Primary Customer Profile**, business identity
   **"ISV Reseller or Partner"** (Console only; docs/A2P_REGISTRATION.md §1). Wait for **Twilio Approved**.
3. Cloudflare Pages → getshowups → Settings → Variables (Production):
   - secrets `TWILIO_ACCOUNT_SID` (AC…), `TWILIO_AUTH_TOKEN` — the PARENT account's;
   - `TWILIO_PRIMARY_PROFILE_SID` = the approved Primary profile (BU…);
   - `TWILIO_PROFILE_EMAIL` = a GetShowUps address Twilio sends registration notices to.
   - Leave `TWILIO_REGISTRATION_SUBMIT` unset until you approve submissions (step 2).
   No platform-wide sender: each business texts from its own number in its own subaccount.

## 2. Per business (admin, /admin → Follow-ups and texting → the business → **Twilio setup…**)

0. The **owner** completes Follow-ups → Texting (details incl. address, representative, industry; EIN unless sole
   proprietor) and **approves submission** (attestation stored with time + owner ref). From then on the optional
   texting box shows on their booking page/forms (carriers review it); no text is sent before approval.
1. **Create subaccount** (free) — `GetShowUps <business id>`; its auth token is stored encrypted.
2. **Prepare the business profile** (free, draft) — Secondary Customer Profile (EIN) or Starter profile (sole
   proprietor), linked to the Primary profile, then Twilio's evaluation. Noncompliant → the failing fields are
   shown; nothing is submitted.
3. Steps that **submit or cost money** need `TWILIO_REGISTRATION_SUBMIT=true` (approval) AND ticking "I approve this
   step" for that step:
   - Submit the business profile → Prepare + submit the A2P profile → **Register the brand** (fee) →
     (sole proprietor: Twilio texts the owner a code; "Resend owner code" if needed) → **Sync status** until the
     brand is APPROVED → Create the Messaging Service (free; incoming-message webhook set to
     `https://getshowups.com/api/sms/twilio/inbound`) → **Register the campaign** (vetting + monthly fee) →
     **Buy a local number** (monthly fee; area code of the business phone) and attach it.
4. **Sync status** (also hourly by cron): the registration becomes `approved` ONLY when Twilio reports the campaign
   VERIFIED; failures/suspensions are recorded as Twilio reports them.
5. In the Twilio Console, on that subaccount's Messaging Service → Opt-out: **enable Advanced Opt-Out** with the
   business's HELP text (docs/A2P_REGISTRATION.md). Twilio then answers STOP/START/HELP and reports `OptOutType`;
   GetShowUps never answers twice.

An unclear Twilio answer (timeout/5xx) is recorded as "unknown" and never repeated automatically: check the
subaccount in the Twilio Console, then "Clear unknown …" only if nothing was created.

Manual fallback (unchanged): /admin → Record (status as Twilio reported it, Messaging Service SID, number).

## 3. Test, then live (approval each)

With the campaign approved and `SMS_LIVE` off, the business texts **test recipients** only
(`MESSAGE_TEST_RECIPIENTS`): form with the texting box → acknowledgment text → reply → fixed/assistant answer → STOP.

| Switch | Effect |
| --- | --- |
| `TWILIO_REGISTRATION_SUBMIT=true` | Admin may run the submitting / paid registration steps (each still needs its own approval tick). |
| `SMS_LIVE=true` | Texts may reach real customers (still only approved businesses, with consent). |
| `FOLLOWUP_AI=true` | The assistant answers texts with the included model (needs the `AI` binding; ≤ $0.20/business/day). |
| `MESSAGES_LIVE=true` | Emails (and texts) leave test mode. |
| `MESSAGING_KILL_SWITCH=true` | Emergency stop for every automatic email/text. |

## Isolation and data

- Texts are sent only under the business's own subaccount (`/Accounts/<sub>/Messages.json`); a business without an
  active subaccount never texts. Webhooks are verified with the token of the account Twilio names (`AccountSid`);
  a webhook from one business's subaccount can never land in another business's inbox.
- Usage: "Usage" in Twilio setup reads that subaccount's provider-reported SMS count and price for the month.
- Account deletion closes the business's subaccount (Twilio releases its numbers) and erases its rows.

## What to watch (/admin → Follow-ups and texting)

Send/delivery failures, assistant fallbacks, opt-outs, hand-offs, webhook problems (incl. `account_mismatch`), stuck
work, unusual volume, cost per business, each business's Twilio setup step and provider statuses.
