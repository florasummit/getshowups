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
