# Google customer acquisition engine

One self-service Google acquisition experience inside the existing Ads tab, for businesses that already advertise
(Journey A) and businesses that never have (Journey B). An incremental extension of the Google Ads integration in
server/ads/google.js and server/ads/campaigns.js: same OAuth, same campaign model, same approvals, same funnel.

## Facts verified on official Google pages (2026-11-23)

- Google Ads API: latest v26.2 (2026-11-11); the code uses v26. Our Cloud project is at **Test** access: production
  accounts are refused (`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`); Explorer access is an external application
  (docs/GOOGLE_ADS_COMPLIANCE.md).
- Local Services Ads: "The Google Ads API blocks the creation and removal of standalone Local Services campaigns
  (`advertising_channel_type = 'LOCAL_SERVICES'`)." Mutable: `campaign.status` and `campaign_budget.amount_micros`
  (plus bidding manual_cpa / maximize_conversions and campaign criteria: ad schedule, location, local_service_id). No
  ad groups, ads or other criteria. Since v26 a Local Services **Performance Max** campaign can be created
  (`pmax_campaign_settings.local_services_enabled`, a GBP `listing_id`; both immutable). Lead resources
  (`local_services_lead`, `local_services_lead_conversation`) are read-only and return data only when such a campaign
  exists in the client account; `local_services_lead` exposes lead type, status, `lead_charged`, credit state,
  category, creation time and the consumer's contact details (which GetShowUps does not store) but **no cost field**:
  cost per lead is campaign spend divided by charged leads. `LocalServicesLeadService.ProvideLeadFeedback` /
  `AppendLeadConversation` exist. `LocalServicesEligibilityService.CheckLocalServicesEligibility(customer_id,
  listing_id)` needs a Google Business Profile listing id.
- Google Business Profile APIs: access is granted through Google's application form (a verified GBP active 60+ days
  with a website is required; quota 0 QPM until approved, 300 QPM when approved; no sandbox); OAuth scope
  `https://www.googleapis.com/auth/business.manage` (separate consent from Ads); Account Management API
  `GET /v1/accounts`; Business Information API `GET /v1/{parent=accounts/*}/locations`, `POST …/locations`
  (validateOnly, requestId); Verifications API `fetchVerificationOptions` / `verify` / `verifications.complete`.

## Step A: existing campaigns read into GetShowUps (2026-11-23)

- **What**: when a business has a Google Ads account chosen, every campaign in it (not removed) is read through
  GAQL searches only and kept in `ad_imported_campaigns` (type, Google status + serving status, daily budget or
  "shared", a settings snapshot) with Google's daily numbers in `ad_imported_metrics_daily` (spend, clicks,
  impressions, Google-counted conversions). Search campaigns also carry locations (names resolved from
  geo_target_constant), languages, ad schedules, negative keywords, ad groups, keywords with match types, responsive
  search ads (headlines, descriptions, final URLs, approval) and biddable conversion goals. Other types (Local
  Services, Performance Max, Display, Video, Shopping, Demand Gen) are listed with status, budget and numbers.
- **Never**: GetShowUps' own campaigns (name tag `[gsu:<id>]`, rows in `ad_campaigns`) are skipped; no mutate is ever
  sent; a campaign Google stops listing becomes status REMOVED (kept, no longer synced); no contact details anywhere.
- **When**: right after the owner chooses the account (`POST /api/ads/google/accounts`, after the response), on
  "Refresh" in the Ads tab (`POST /api/dashboard/ads/imported {action:'refresh'}`), and by the cron (`imports` step:
  businesses older than 20 h, failed reads again after 1 h, 5 per run; `ad_import_state` remembers each read). First
  read: 90 days of metrics; later reads restate the last 3 days.
- **UI** (src/dashboard/AdsImported.jsx, under the connection card): "Your Google Ads campaigns" with a 7/30/90-day
  period, each campaign's name, type, status (Running · Paused · Ended · Scheduled · Not serving), daily budget,
  spend, clicks and Google conversions; the row opens the settings in words. Labelled as Google's own numbers;
  leads and bookings in Results stay GetShowUps' records. Read-only: no Start/Pause/budget controls.
- **Migration 0037** (approval to apply on production): also creates the tables for the next steps (`lsa_leads`,
  `ad_templates`, `gbp_connections`, `ad_change_requests`). Until it is applied, the section is hidden, the route
  answers `{ ready: false }` and the cron step reports `not_ready`.
- **Verified**: unit (`test/ads-imports.test.js`: first read with settings and 90-day metrics, own campaign skipped,
  idempotent re-read with 3-day window, removal marking, partial copy on a failing detail query, revoked access,
  labels/totals/periods, pre-0037 behaviour, route auth/isolation/period bounds, account choice triggers the read,
  cron due-selection and bounds) and browser (`test/e2e/ads.spec.js` "Journey A" against the Google Ads stand-in).
  Against Google's real API: **nothing yet** (Test access; the stand-in follows the documented GAQL shapes).

## Step B: Local Services Ads (2026-11-23)

- **Existing LSA customers**: a Local Services campaign in the account is imported like any other (status, budget,
  Google's spend). Its leads are read from `local_services_lead` (type, status, `lead_charged`, credit state,
  category, creation time, campaign; **contact details and notes are never selected or stored**) into `lsa_leads`
  (keyed per business + Google lead id; 90 days the first time, the last 30 days restated afterwards because statuses
  change). The Ads tab shows, per Local Services campaign and period: leads by type, charged / credited back / marked
  booked in Google, **cost per charged lead = the campaign's Google-reported spend ÷ charged leads** (null without
  both), and the recent leads (date, type, status, charged/credited). Google's lead counts stay Google's; GetShowUps'
  own leads and bookings are in Results. Status and budget edits for these campaigns come with step E's change
  requests (the only fields the API lets anyone change).
- **New LSA customers**: a readiness checklist under the imported campaigns (`lsaReadiness`): eligible category
  (likely / check from the industry on record), supported location (ZIP codes on record), Google account, verified
  Business Profile (step D), background/license/insurance checks, billing in Google Ads, business phone; every item
  is Google's and the owner's; the note says plainly that Google only creates Local Services campaigns in its own
  setup and links to it. Nothing is created, verified or represented as active by GetShowUps.
- **Not possible through the API** (documented): creating or removing a standalone Local Services campaign; ad
  groups/ads; lead cost per lead (no field); eligibility check without a Business Profile listing id.
- **Verified**: unit `test/ads-lsa.test.js` (read window and mapping, no contact details in the query or the rows,
  status update on re-read, counts/CPL/period, nothing read without a Local Services campaign, readiness states) and
  the Journey A browser test (6 leads, 4 charged, 1 credited, cost per charged lead $60 = $240 ÷ 4, no contact
  detail on the page, checklist only for businesses without one). Against Google's real API: nothing yet.

## Step C: campaign templates (2026-11-23)

- **Curated templates** (`server/ads/templates.js` TEMPLATES): pool cleaning, pool repair, HVAC maintenance, HVAC
  repair, plumbing, electrical services, roofing. Each: high-intent keywords (phrase match), negative keywords (job
  seekers, DIY, bargain hunters, parts), headlines ≤ 30 and descriptions ≤ 90 characters that pass the unapproved-claims
  filter, a cautious starting daily budget ("a first-week floor, not a promise of results": no customer data backs
  them yet), landing page = the business's booking page or published website, goals = the booking form lead and the
  confirmed booking. `templateSpec` fits a template to the business: its name and "Serving <town>" as headlines, a
  local keyword from the town on record, its ZIP codes as the area, its exclusions as extra negatives, the budget the
  owner typed (floored at the platform minimum). `suggestTemplates` puts the trade's templates first.
- **Imported campaign → template** (`normalizeImported`): keywords (valid characters, match type kept), negatives, the
  first ad's headlines and descriptions (claims filtered, length fitted), the https landing page; never ad group,
  location or ad ids; only this business's own imported Search campaign; refused for other types or too little text.
  **Draft → template** (`saveFromDraft`) keeps the draft's words minus its attribution link. Saved templates live in
  `ad_templates` (≤ 20 per business, removable).
- **Flow**: Review your campaign → "Start with a template" (beside "Draft my plan") → picker with "Your templates"
  and GetShowUps' templates (suggested first, searches and ad lines shown, daily budget editable) → one editable draft
  (409 `draft_exists` while one is open) → the unchanged steps: edit, preview, approve (budget approval), create
  paused, read back, explicit Start. Nothing is created or spent by a template.
- **Route** `GET/POST /api/dashboard/ads/templates` (session business, Ads access, rate-limited, allowlisted errors).
- **Verified**: unit `test/ads-templates.test.js` (every template valid for a real business and fitted to it; suggestion
  by trade; one draft with the attributable booking link; second start refused; approve path unchanged; imported →
  normalized template without identifiers, claims dropped, other business/type refused; draft → template; remove is
  the owner's own; pre-0037 behaviour) and browser Journey B (`e2e-starter` / `-m`: details → Start with a template →
  suggested HVAC templates first → draft from HVAC repair with the chosen budget, the business name and town, the ZIP
  area, the attribution link; second start refused; nothing on Google) plus "Save as a template" in Journey A.

## Step D: Google Business Profile (2026-11-23)

- **Switch**: `GBP_ENABLED=true` (approval: a new Google OAuth scope `business.manage` and Google's Business Profile
  API access, which is an application form with 0 QPM until approved and no sandbox). Off (production today): the
  connection row says "Not available yet", explains that Google must approve GetShowUps' access, offers no Connect
  and shows the facts-only checklist (does a listing exist? eligibility, the owning Google account, Google's own
  create/claim flow, Google's verification, then connect here) with Google's setup link.
- **On**: `/api/ads/gbp/start` (business.manage only, PKCE, encrypted state cookie, same business re-checked) →
  `/callback` (server-side exchange, scope and refresh token required, token encrypted in KV `ads:gbp:<customer>`) →
  the account's listings are read (Account Management `GET /v1/accounts`, Business Information
  `GET /v1/{account}/locations` with the required readMask, names/places/what-is-filled only; never contact details
  stored) → one listing is linked automatically, several → the owner picks from Google's list (a typed name is refused)
  → Google's **Voice of Merchant** state is the only verification claim (Verified · Verification pending · Needs
  verification · Ownership conflict · Suspended/Disabled by Google · Being reviewed), refreshed at most daily →
  `gbp_connections` (names, verification snapshot, what is missing: website, phone, hours, category). Read-only toward
  the profile: GetShowUps never creates a listing (duplicates cause months of trouble) and never edits one in this step.
- **Ads tab**: third row under "Connect your ad account": status in words, the linked listing (title, place, state
  chip, Google Maps link, missing fields), Change business / Reconnect; the Local Services readiness checklist marks
  "verified Business Profile" from this link.
- **Not done, by design**: no location creation, no profile edits, no eligibility API call (CheckLocalServicesEligibility
  needs the listing id and its REST path was not confirmed on an official page; it stays a documented follow-up).
- **Verified**: unit `test/ads-gbp.test.js` (off switch, scope/PKCE/state, listing read with readMask, auto-link and
  stored state, no tokens or phone numbers in rows or payloads, isolation, choice from several with a refused typed
  name, Voice of Merchant states, error mapping, callback refusals, readiness, pre-0037) and browser (Journey B: Connect
  → linked "Verified" listing with missing website; the unavailable state and a Google account without a listing).
  Against Google's real API: nothing (access not applied for).

## Step E: owner-approved changes, recommendations, KPIs (2026-11-23)

- **Changes to the account's own campaigns** (`server/ads/changes.js`, `ad_change_requests`): status (pause / start)
  and daily budget, the two fields the API lets anyone change on every campaign type. Propose → current value →
  proposed value → the expected effect in plain words (mechanism, never a promise) → the owner's explicit approval
  (confirm) → applied through `campaigns:mutate` / `campaignBudgets:mutate` on resources read fresh by id → read
  back → our copy follows Google's answer → recorded (request, `ad_actions` kinds imported_pause / imported_resume /
  imported_budget, the permanent audit log). Nothing changes on Google before the approval step. Starting a campaign
  or raising a budget goes through the same serving guard as GetShowUps' campaigns (ADS_LIVE_LAUNCH, or a verified
  Google Ads test account) and is refused on an ads hold; pausing and lowering always work. Shared budgets and removed
  campaigns are refused; a newer proposal replaces an older one; proposals expire after 7 days.
- **Recommendations** (`server/ads/recommend.js`, cron `recommend imported`): deterministic rules over Google's
  numbers (14 days) and Local Services lead records, recommendation-only, minimum data, never more spend by itself:
  stale numbers; clicks with nothing Google or GetShowUps can count as a lead; budget used up almost daily (only the
  owner decides to raise); Display Network / search partners on; location targeting by interest; Local Services:
  spend with no charged leads, cost per charged lead above half the first-job value. Each finding states what was
  observed, the numbers, what to consider, why it should help, its confidence and limits, and that any change goes
  through approval. Written once per campaign, rule and day.
- **Attribution and KPIs**: a lead whose link carries `utm_source=google&utm_campaign=<Google campaign id>` of one of
  the business's own campaigns is credited to that campaign (source `google_ads_imported`) and counted apart from
  GetShowUps' campaigns in the funnel (`attribution.importedLeads`; never against GetShowUps campaign spend). The
  results route adds `imported` (Google's spend, clicks, conversions for the account's own campaigns) and the Results
  view states the definitions: cost each = GetShowUps campaign spend ÷ the stage count (lead, qualified, booking,
  show-up, completed job), ROAS = paid revenue ÷ spend, Google's conversion counts and Local Services leads shown apart.
- **Verified**: unit `test/ads-changes.test.js` (3) and `test/ads-recommend.test.js` (3); browser Journey A (cron
  findings, propose pause → approve → "Google reports: paused", lower budget, results kept apart). Against Google's
  real API: nothing (Test access).

## Next steps (in order)

- C: templates: curated industry templates through the existing spec/validateSpec path, imported campaign → draft
  template (normalized, no account ids), "Start with a template" flow.
- D: Google Business Profile: separate OAuth scope + Google access approval (founder), location list and link,
  readiness checklist, no automatic creation.
- E: supported edits of imported campaigns (status, budget) with current → proposed → approve → apply → read back,
  recommendations over imported data, KPI definitions.

## Founder actions (external)

1. Approve applying migration 0037 to production (`npx wrangler d1 execute getshowups-onboarding --remote
   --file=migrations/0037_google_acquisition.sql`).
2. Google Ads API Explorer access for the Cloud project (needed for any real, non-test account).
3. Google Business Profile API access application (needed before step D can call Google).

## Calls (2026-11-25; migration 0040; OFF: GOOGLE_CALLS_ENABLED)

Read-only, from Google's `call_view` (v26 reference read 2026-11-25): start time, length, RECEIVED or MISSED, campaign, and whether the
number was shown on the ad or the landing page. The business keeps its own number: Google shows a forwarding number and passes the call
on. Nothing is built for lines, routing, porting or recording.

| Question | Answer |
| --- | --- |
| Who called? | Not available. The API has an area code and country only; we select neither. So no automatic matching: the owner links a call or adds the caller |
| Answered or missed | Yes, per call |
| Calls from the landing page | Only where Google's own website call conversion is set up on that page; our pages carry no script, so calls dialed from a GetShowUps page are not counted |
| Callback | Owner's own mark ("I called back") |
| Booking, completed job, payment | From the linked person's own records, only appointments made since that call |
| Source | A caller added from a call gets Google's campaign; someone already recorded (same phone number) keeps their first source |
| Local Services | Leads, type, status, charged, credited (existing) and now linking to customers. Google reports no missed/answered for them; conversations, recordings and messages are not read |
| Time zone of the call time | Not documented by Google: shown as given, sorted as the Ads account's zone |
| Creating call assets, turning on call reporting | Owner, in Google Ads: Admin → Account settings → Call reporting; Assets → Call |
| Verified | Unit tests and a Google stand-in. NOT against a real account: needs Google API access level and the switch |

Approval that unlocks it: (1) privacy policy names call records (proposed sentence, in src/legal/Privacy.jsx after "Local Services Ads … message
contents": "If call reporting is on, we read when calls from ads happened, how long they lasted, whether they were answered and which campaign they came from, not who called."), with docs/GOOGLE_PRIVACY_RESUBMISSION.md changed together;
(2) migration 0040; (3) `GOOGLE_CALLS_ENABLED=true`.
