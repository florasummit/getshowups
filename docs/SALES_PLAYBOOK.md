# Sales playbook: the first five paying customers

Written 2026-11-21 (brief: revenue-first growth engine). Everything here describes what the product does in
production today; nothing promises results. Numbers in the "illustrative example" are labelled as such.

## 1. Revenue readiness audit (what sells today)

| Step a prospect takes | State | Notes |
|---|---|---|
| Discover GetShowUps | works | getshowups.com; no paid or organic acquisition running yet |
| Understand it in 10 s | works | "More booked jobs. Less chasing." + the live AI conversation in the first screen |
| Who it serves | works, friction | "For pool, HVAC and roofing businesses": three trades; the sales motion below targets ONE |
| Credible demonstration | works | the scripted AI conversation and the booking-page demo (simulation, labelled) |
| $499/month + ad spend separate | works | hero price line, pricing card, FAQ |
| Talk to an AI sales representative | **now possible** | the GetShowUps business record runs the same receptionist with the Software playbook (`/chat/getshowups`); needs the 5-minute setup in §6 |
| Answers on pricing and objections | **now possible** | owner-approved notes (§6) + the engine's price and claim guards |
| Book a demo / consultation | works, friction | Google appointment schedule iframe on the homepage (lands on the founder's calendar, NOT in the product); the sales chat books the same founder calendar THROUGH the product once set up |
| Safe paid signup | blocked by design | enrollment closed until live billing is approved (docs/LAUNCH_DECISION.md); pilots are set up by hand |
| Calendar + configuration | works | onboarding, Settings, Teach Your AI |
| Website / booking experience | works | hosted site, booking page, AI receptionist chat |
| Qualified inquiries handled | works | area check, qualification, booking, callback requests |
| Understand the value received | works | Overview "Last 30 days" (inquiries, booked, showed/visits, rate), Appointments money per visit, Ads results |

Gap classes: **already works** (most of the funnel); **friction** (three-trade positioning; early-access bookings outside the
product); **missing for the first customer** (a sales conversation, done in this release by configuration + a small
engine playbook; a sales-stage view for the founder, Release 2); **optional, waiting** (video, CRM, ads automation, forecasting).

## 2. The first market: pool service companies (Charleston area first)

Compared against HVAC and roofing on the brief's criteria:

| Criterion | Pool service | HVAC | Roofing |
|---|---|---|---|
| Cost of a missed inquiry | high (recurring service worth $160–$280/month for years) | high (emergency repairs) | very high but infrequent |
| Need for appointment booking | yes, visits on a route | yes | inspections, then estimates by a person |
| Can afford $499 + ads | yes at ~20+ recurring accounts | yes | yes |
| Sales cycle | short (owner-operator decides) | medium (office staff, dispatch software) | longer (seasonal, insurance) |
| Demonstrable ROI | easy: one recurring account pays for months | easy but competes with dispatch suites | harder (estimates are human) |
| Integration complexity | low | medium (existing dispatch tools) | low |
| Our credibility | PoolThru pilot, pool playbook, scenarios | playbook only | marked "upcoming" |

**Target buyer:** owner-operator of a residential pool service company with 1–5 trucks, answering their own phone.
**Primary pain:** inquiries arrive while they are at a pool; by the time they call back, the customer booked someone else.
**Existing alternative:** voicemail, a spouse or office person, a generic answering service that can't book, or nothing.
**Why GetShowUps:** answers on their website in seconds, confirms the area, asks their questions, books a real open time
on their Google Calendar, invites the customer, and shows the owner every inquiry and outcome.
**Economic reason:** one recurring account ($160–$280/month) kept per month covers most of the subscription; the owner
also stops doing the "same ten questions" from the truck.
**Expected objections:** "I have voicemail/texts" · "Will it say something wrong?" · "My customers want a person" ·
"$499 is a lot" · "I don't have a website" · "Ads cost extra" · "What if I cancel?" (answers in §5).

## 3. The offer (truthful, outcome-first)

- **Headline:** More booked jobs. Less chasing.
- **Value proposition:** Every inquiry answered, qualified and booked on your calendar while you are on a job.
- **Primary CTA:** Request early access (books a short call) · secondary: See it answer a customer · new: Ask our AI about GetShowUps.
- **Demonstration:** the homepage conversation (pool scenario), then the booking page + dashboard demo; for a live
  demo, the founder runs a real inquiry through the pilot business's chat and shows the booking land on the calendar.
- **Pricing in one sentence:** $499 a month, billed monthly, no setup fee, no free trial, cancel any time; advertising
  spend is separate and paid to Google or Meta; applicable taxes separate where required.
- **What you get for $499/month (verified in production):** a hosted website or your own domain; AI receptionist on
  your website chat; online booking straight into Google Calendar; service-area screening; Teach Your AI rules;
  Google Calendar invitations; show-up / visit tracking; direct help from the founding team. Not yet (say so): texting,
  email reminders, ad management, voice on the phone.
- **Illustrative example (not a result):** a pool company that receives 20 inquiries a month and today reaches 12 of
  them in time; if the receptionist answers all 20 and the same share books, that is 8 more conversations handled
  without the owner's time. Whether that becomes 2 or 5 recurring accounts depends on the business; we do not
  promise either. The dashboard shows the real numbers after month one.

## 4. Demo path

1. getshowups.com → first screen → "Send the first message" (pool scenario) → Booked on the calendar.
2. "Booking page & dashboard" tab → inquiry → area check → time → booked → owner records the outcome.
3. Live: the founder opens the pilot business's `/chat/<id>` on the call, types a real inquiry, and shows the
   appointment on the dashboard and on Google Calendar (dry, with a test lead marked as test afterwards).
4. Close: "Ask our AI about GetShowUps" or the early-access calendar to book the setup call.

## 5. Objection handling (what the AI and the founder say)

| Objection | Answer (truthful) |
|---|---|
| I already have voicemail/texts | Voicemail doesn't ask the questions or book the time. The receptionist answers in seconds, checks your area, asks what you'd ask, and books a real open slot. You still get every inquiry on your dashboard. |
| Will it say something wrong? | It only uses your records: services, prices, towns, hours, and notes you approve. It never invents a price or a promise; if a price isn't listed it says the team will confirm. You can test it before customers see it. |
| My customers want a person | It never pretends to be you, and it can't transfer calls. If someone wants a person it records a callback request you see immediately. Most people just want their question answered and a time booked. |
| $499 is a lot | It's billed monthly with no setup fee and you can cancel any time. One recurring account kept per month covers most of it; the dashboard shows exactly what came in and what got booked. |
| I don't have a website | A hosted website with booking and chat is included; you can use a GetShowUps address or your own domain. |
| Ads cost extra | Yes: ad spend is paid to Google or Meta directly and is separate. You don't need ads to start; the receptionist works on inquiries you already get. |
| What if I cancel? | Your site stays online to the end of the period you paid for plus 14 days, you can download your content, and your domain is always yours. |
| Does it text or call customers? | Not yet. Today it works on your website chat, and voice on the website is in a pilot. We say so everywhere. |

## 6. The AI sales assistant: configuration (5-minute founder setup, no code)

The engine already supports it (industry "Software" selects the sales playbook; the prompt switches to consultation
wording; no ZIP or address is required; prices come only from the listed plan and the notes). Setup, in the product:

1. Platform console → create/invite the business **GetShowUps** with id `getshowups` (invited businesses are never billed).
2. Settings → Business: name GetShowUps, appointment mode "At my location", time zone, **no service ZIP codes**;
   Booking hours = the hours you take consultation calls; visit length 20 minutes.
3. Settings → Details: industry **Software**; description "AI receptionist and booking for pool, HVAC and roofing
   businesses."; services: **Founding plan — $499/month** (only this; it is the only price the assistant may state).
4. Google Calendar: connect the founder calendar the consultations should land on.
5. Receptionist → on; greeting: "Hi, this is the GetShowUps assistant. What kind of business do you run, and how do
   new inquiries reach you today?"; notes (owner-approved answers, ≤3000 chars) = the §5 table in prose, plus:
   "What you get for $499/month: …" (the §3 list) and "Not yet: texting, email reminders, ad management, phone voice."
6. Publish nothing else. From then on: `/chat/getshowups` answers, qualifies, records callback requests (= leads in
   the dashboard), and books consultation calls on the founder's calendar; the homepage shows "Ask our AI about
   GetShowUps" automatically (GET /api/enrollment → salesChat: true).

Dry run before linking: ask it the §5 objections and "can you do it for $299?"; the price guard blocks any amount not listed.

## 7. Acquisition experiment (prepared; needs approval before any message is sent)

**Channel:** founder-led direct outreach to Charleston-area residential pool service companies (highest intent per hour,
fastest feedback, zero spend). Google Search ads are the second channel, prepared below, not activated.

- **Audience:** owner-operators of residential pool service companies in Charleston, Mount Pleasant, James Island,
  West Ashley, Summerville, Daniel Island; 1–5 trucks; a public business phone and website or Google listing. Sources:
  Google Maps listings and the founder's PoolThru network only (no scraped personal lists; business contact channels only).
- **Offer:** founding plan, $499/month, no setup fee, set up by hand with the founder, cancel any time.
- **Landing page:** getshowups.com (the first screen is the demo) → "Ask our AI about GetShowUps" or the early-access calendar.
- **Message A (problem-first):** "Hi <name>, I run PoolThru here in Charleston and built something for the inquiries
  that come in while we're at a pool: an AI receptionist on your website that answers, checks the area, and books a real
  open time on your Google Calendar. You can try it in 30 seconds at getshowups.com. If you want, I'll set yours up with
  you on a 20-minute call."
- **Message B (proof-first):** "Hi <name>, quick one from a fellow pool company in Charleston. We've been letting an AI
  answer our website inquiries and book the visit on our calendar instead of calling people back from the truck. It's
  $499/month, no setup fee, cancel any time, and I set it up with you. 30-second demo: getshowups.com. Worth a look?"
- **Conversion event:** a consultation booked (appointment on the `getshowups` business, or the early-access calendar).
- **Follow-up:** one follow-up after 4 days if no reply; every reply gets a same-day answer; demo within 48 hours; after
  the demo, the founder sets the business up on the call (pilot path in docs/LAUNCH_DECISION.md §7).
- **Measurement:** per message variant: sent, replied, demo booked, demo attended, agreed to pay, activated; recorded in
  the admin Sales funnel (Release 2) and a one-line log per prospect in the founder's notes.
- **Stop / continue:** 30 messages per variant. Continue the variant with the higher reply rate; if fewer than 2 demos
  from 60 messages, change the audience or the message before sending more. If 1 in 5 demos agrees to pay, move to the
  search-ads test.

**Google Search ads (prepared, not active):** one campaign, Charleston-area geo, exact/phrase keywords "pool service
answering service", "pool company scheduling software", "pool service booking software", "missed calls pool service";
two ads = messages A/B shortened; landing = getshowups.com; conversion = early-access booking or sales-chat consultation
booked; daily budget proposal $20 for 14 days (≈$280, approval required); stop if no consultation after $150 spent.

## 8. Sales KPIs (as of 2026-11-21)

| Metric | Value | Kind |
|---|---|---|
| Live MRR, paying customers | $0, 0 | real (billing in Stripe test mode; the one sandbox subscription is test data) |
| Pilot businesses (unbilled) | PoolThru, bob-electrical (voice pilots) | real |
| Qualified leads, demos booked / attended | unavailable: early-access bookings live on the founder's calendar, not in the product; the sales chat is not set up yet | missing |
| Homepage visitors, CTA clicks | unavailable: funnel events are in-page only (no tracker installed; adding one needs approval) | missing |
| Cost per lead, CAC, payback | unavailable (no spend, no customers) | missing |

## 9. Priorities (impact × confidence ÷ effort)

1. Founder sets up the GetShowUps business + receptionist (§6): unblocks the AI sales conversation and puts every
   inquiry and consultation in the product. 5 minutes, no code.
2. Send outreach variant A/B (§7) after approval: the only way to get the first prospect.
3. Release 2: a sales-stage strip in the admin growth metrics so the funnel is counted from day one.
4. Everything else waits for market feedback.
