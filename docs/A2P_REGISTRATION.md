# A2P 10DLC registration: GetShowUps (ISV) and each business

Sources (Twilio docs, read 2026-11-16): [A2P 10DLC overview](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc),
[ISV onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv),
[Collect business info](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info),
[Standard / Low-Volume Standard](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/direct-standard-onboarding),
[Sole proprietor](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/direct-sole-proprietor-registration-overview),
[Trust Hub profiles](https://www.twilio.com/docs/trust-hub/profiles),
[Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out),
[US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us).
The A2P fee table (help.twilio.com article 1260803965530) does not render outside a browser: **fees below marked
"estimate" are not verified**; Twilio shows the exact fee on screen before each submission.

Nothing here has been submitted, bought or attested. Every step marked (approval) needs the founder's explicit yes.

## How GetShowUps registers (ISV / reseller)

- GetShowUps is the ISV: **one Primary Customer Profile** (business identity "ISV Reseller or Partner"), created only in
  the Console (Trust Hub). It must be approved before any business can be registered.
- Each business gets its **own Twilio subaccount** (Twilio's preferred ISV architecture #1, decided 2026-11-16) and,
  inside it, its own **Secondary (or Starter) Customer Profile → A2P profile → Brand → Messaging Service → Campaign →
  number**. One business's traffic, suspension or opt-outs never touch another's.
- Credentials (Twilio subaccount docs): the parent's credentials act on a subaccount's v2010 resources (sending,
  numbers, addresses, usage, closing); Trust Hub and Messaging APIs (subdomains) are called with the subaccount's own
  credentials, stored encrypted. Webhooks are verified with the token of the account Twilio names (`AccountSid`).
- The registration runs through Twilio's APIs from /admin → Twilio setup (server/followups/provisioning.js), one
  confirmed, audited step at a time; submitting and paid steps need `TWILIO_REGISTRATION_SUBMIT=true` plus an
  approval tick for that step. Not verified until the first real run (Twilio's docs don't say): whether a profile
  created in a subaccount can reference the parent's Primary profile SID directly. If Twilio refuses it, the step
  stops with Twilio's error code before anything is submitted; see "If the first real run fails" below.
- Registration type is chosen **per business**, never assumed:

| Business has | Brand type | Campaign use case | Notes |
| --- | --- | --- | --- |
| An EIN (every US LLC, corporation, partnership; most nonprofits) and < 6,000 segments/day | **Low-Volume Standard** | `LOW_VOLUME` (mixed) | No secondary vetting. Our businesses send tens of texts a day. |
| An EIN and more volume | Standard (secondary vetting) | `CUSTOMER_CARE` or `MIXED` | Not needed today. |
| **No EIN** (true sole proprietor, SSN only) | Sole Proprietor | `SOLE_PROPRIETOR` | 1 campaign, 1 number, ~1,000/day to T-Mobile. For ISVs Twilio documents this **API-only**: supported by Twilio setup (Starter profile `RN806d…`, trust product `RN670d…` with `sole_proprietor_information`, `BrandType=SOLE_PROPRIETOR`; Twilio texts a one-time code to the proprietor's own, non-Twilio mobile — reply within 24 h, "Resend owner code" otherwise; verify within 30 days). Lifetime caps across all carriers' registrations: mobile 3 uses, email/address 10. A business with an EIN must **not** register as sole proprietor (fees lost, redo); the owner form derives the path from the business type. |
| 501(c)(3) | Standard, nonprofit | `CHARITY` (special) | Extra review. None today. |

Legal name must match the IRS EIN letter (CP 575 / 147C) **exactly**; a new EIN can take 30–90 days to propagate.

## 1. GetShowUps platform profile (Primary Customer Profile) — owner action

Console: **Trust Hub → Customer Profiles → Create** (Twilio Console, left menu Trust Hub; guide: https://www.twilio.com/docs/trust-hub/profiles).
Business identity: **ISV Reseller or Partner**. Review: up to 48–72 hours.

| Field | GetShowUps value (founder supplies / confirms) |
| --- | --- |
| Legal business name | Exactly as on GetShowUps's EIN letter |
| Business type / company type | (e.g. LLC) / private |
| EIN | GetShowUps's EIN |
| Address | Registered business address (not a P.O. box) |
| Website | https://getshowups.com (has /privacy and /terms, public) |
| Industry | Technology |
| Authorized representative | Founder: name, title, job position, email, phone |
| Notifications email | A monitored GetShowUps address |
| Identity check | Government photo ID + selfie, if Twilio asks |

Before this: upgrade the Twilio account (paid; approval) and enable billing.

## 2. First business checklist (recommended: PoolThru, `poolthru-llc`)

PoolThru is an LLC → it has an EIN → **Low-Volume Standard** brand, `LOW_VOLUME` campaign.

**A. Owner, in the GetShowUps dashboard** (Follow-ups → Texting): enter legal name, type, EIN, address, website, contact;
review the description, opt-in flow and samples; tick the attestation; **Approve submission**. From that moment the
optional, unchecked texting box appears on PoolThru's booking page and website forms (no texts are sent before
carrier approval: `smsReadiness` still requires the provider's approval + own sender + `SMS_LIVE`).

**B. In the owner form** (since 2026-11-16): street address, city, state, ZIP; authorized representative's first/last
name, title and position; industry; mobile number. Company type is derived (private; nonprofit → non-profit).

**C. Admin, /admin → Follow-ups and texting → PoolThru → Twilio setup…** (approvals per step): create subaccount →
prepare profile (draft + Twilio evaluation) → submit profile → prepare + submit A2P profile → register brand (fee) →
Sync until the brand is APPROVED → create Messaging Service → register campaign (fee) → buy number (fee) → Sync until
the campaign is VERIFIED. The campaign is submitted with these values (the same the owner approved):

| Campaign field | Value (copy from the owner's Texting view, which shows exactly what they approved) |
| --- | --- |
| Use case | `LOW_VOLUME` (Low volume mixed) |
| Description | The owner's "What carriers will see" text |
| Message flow / call to action | The owner's "How customers agree to texts" text (names the booking page, both box wordings, terms and privacy URLs) |
| Opt-in evidence URL | `https://getshowups.com/sms-terms/poolthru-llc` (shows both boxes exactly, unchecked) + `https://getshowups.com/book/poolthru-llc` (the live box) |
| Privacy policy | https://getshowups.com/privacy (non-sharing statement for mobile numbers; frequency; rates) |
| Terms | https://getshowups.com/sms-terms/poolthru-llc |
| Samples (4) | The owner's "Example messages" (brand name first, [variables], real getshowups.com links, STOP language) |
| Embedded links / phone | Yes / No |
| Opt-in keywords | (none; web form opt-in) — Twilio default START handling |
| Opt-out / help | Twilio keyword handling (STOP/UNSUBSCRIBE/END/QUIT/STOPALL/REVOKE/OPTOUT/CANCEL; START; HELP) with **Advanced Opt-Out enabled** on the Messaging Service (so Twilio reports `OptOutType` and we never answer twice) and the HELP text "Poolthru LLC: replies about your request. Call [phone]. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out." (Advanced Opt-Out can only be turned off again by Twilio support.) GetShowUps never sends a second answer to a keyword Twilio answered (`OptOutType`). |
| Volume | < 2,000 segments/day to T-Mobile |

The registration shows `pending` from the profile submission and `approved` only when Twilio reports the campaign
VERIFIED (Sync, and hourly by cron). Console fallback: Messaging → Regulatory Compliance → Onboarding
(https://console.twilio.com/us1/develop/sms/regulatory-compliance/a2p-onboarding) with "Switch Customer Profile",
inside the business's subaccount, then /admin → Record.

**If the first real run fails** at "Prepare the business profile" with a Twilio error on the Primary-profile link
(the one undocumented point): stop there (nothing was submitted or charged), send me the error code, and we either
link via the parent account or create the client profile from the Console in that subaccount.

**D. Review**: brand usually minutes (manual review 7+ business days); campaign vetting up to 5 business days
(contact support after 10). Common rejections: legal name/EIN mismatch, website unreachable/parked/login-gated,
privacy policy missing the non-sharing statement, terms off-domain or not public, vague samples, description not
matching the use case. Record the outcome **exactly as Twilio reports it** (`approved` / `rejected` + reason).

**E. Sender** (approval: purchase): the "Buy a local number" step searches the business phone's area code, buys one
number in PoolThru's subaccount (estimate ~$1.15/month), attaches it to PoolThru's Messaging Service (incoming
messages already point to `https://getshowups.com/api/sms/twilio/inbound`) and records it as PoolThru's sender.
Then enable Advanced Opt-Out on that Messaging Service in the Console (row above).

### Fees (estimates unless stated)

| Item | Amount |
| --- | --- |
| Outbound / inbound SMS (verified, Twilio pricing page, Nov 2026) | $0.0083 per segment each way |
| Carrier pass-through per SMS (verified table, columns partly ambiguous) | ~$0.0025–$0.005 (AT&T 0.0035, T-Mobile 0.0045/0.0025, Verizon 0.005) |
| Failed message processing (verified) | $0.001 per failed message |
| Brand registration, Low-Volume Standard / Sole prop | estimate ~$4–$5 one-time |
| Brand registration, Standard (with secondary vetting) | estimate ~$44–$46 one-time |
| Campaign vetting | estimate ~$15 per submission (incl. resubmissions) |
| Campaign monthly | estimate ~$1.50/month (low volume / sole prop) to ~$10/month (standard) |
| 10DLC number | estimate ~$1.15/month |

Per business, first year (estimate): ~$4 + $15 + 12 × ($1.50 + $1.15) ≈ **$50**, plus usage
(e.g. 300 texts/month ≈ $3.70/month incl. carrier fees).

## 3. What can be done and tested before carrier approval (no spend, no live texts)

- Owner details + approval in the dashboard; the texting box appears on booking page / website forms; consent is
  recorded with the wording version (`booking-sms-v1`, `site-form-sms-v1`). Verified by tests.
- Public opt-in evidence and terms: `/sms-terms/<id>`, `/privacy`, `/book/<id>` (no sign-in needed).
- Twilio account upgrade and Primary Customer Profile (profile review is free; account upgrade is a paid service).
- Buying a number and creating the Messaging Service is possible before approval (spend; approval), but **no A2P
  traffic is allowed until the campaign is approved** (unregistered 10DLC traffic is blocked). So: no test texts to
  real phones before approval, even to test recipients.
- Everything else is exercised against the Twilio mock (unit + browser tests): signed webhooks, STOP/START/HELP,
  duplicate webhooks, delivery updates, quiet hours, limits, tenant isolation.

## 4. Controlled website-form acknowledgment email test (no MESSAGES_LIVE)

Uses the sandboxed test business `gsu-journey-test`: a marked test business only ever emails
`MESSAGE_TEST_RECIPIENTS`, whatever `MESSAGES_LIVE` says.

1. (Founder) Sign in as the test business owner → Website → add a Contact section with **form: contact** → Publish
   (test business only; never PoolThru).
2. Open https://getshowups.com/p/gsu-journey-test, wait 5 s, submit the form with **an address listed in
   `MESSAGE_TEST_RECIPIENTS`** (ZIP 29401).
3. Within one scheduler run (≤ 5 min) the acknowledgment ("thanks, here's how to book") arrives at that inbox.
4. Read-only check: `SELECT kind, channel, status, error FROM messages WHERE customer='gsu-journey-test' AND kind='lead_ack'`
   → `sent`; `lead_threads.source = 'website_form'`; Follow-ups inbox shows the email. Any other address → `test_mode`.
