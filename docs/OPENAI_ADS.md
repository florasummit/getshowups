# ChatGPT Ads (OpenAI Ads API): third ad platform

Status 2026-11-24: built and tested against a stand-in. **Not verified against OpenAI**: no ChatGPT Ads account is
connected yet. Off in production (`OPENAI_ADS_ENABLED` unset). Migration 0039 **applied to production 2026-11-25** (backup
prod-20261125T021654Z-pre-0039.sql restored and checked; full rehearsal on SQLite and local D1 passed; afterwards every other
table's count and the three ad tables' complete contents, foreign keys and indexes were unchanged; marker ad_platforms present).

## What it does
One more adapter (`server/ads/openai.js`) behind the shared engine (`server/ads/campaigns.js` `adapter()`). The rest
is reused unchanged: owner budget approval and ceilings, the claims filter (`validateSpec`), ads holds (the safety stop),
the action log, encrypted ad tokens (KV `ads:openai:<business>`), the daily read-back cron, metrics sync and the one
results definition (`server/ads/funnel.js`).

| Step | Behaviour |
| --- | --- |
| Connect | The owner pastes their **Ads API key** (OpenAI: one key per ad account, Ads Manager → Settings). Before anything is stored it is checked with a read-only `GET /ad_account`. A refused key is never stored. Only the last 4 characters are shown afterwards. |
| Draft | "Draft a ChatGPT ad" builds a starter from the business's records. It is a chat card (title 3–50 characters, text ≤100) linking to the booking page, with the services as context hints. All text goes through the claims filter. |
| Where | Markets (metro areas) and regions (states) from `GET /geo_lookup/search`, chosen by the owner. **OpenAI has no ZIP, radius or city targeting**, and the editor says so. The booking page still checks the ZIP, so a visitor outside the area is never offered a time, but the click has already been paid for. |
| Check | Dry run: builds exactly the three payloads and sends nothing. |
| Create | Campaign → ad group → ad, **all `paused`**, each with an `Idempotency-Key` of `gsu-<campaign>-<step>`, so a retry never duplicates. If OpenAI reports anything as running, it is paused at once and the launch fails (`not_paused`). |
| Read back | Status, budget, locations, tracking template, context hints, ad text and landing page are compared on create and daily, the same as for Google and Meta. Archived in Ads Manager → reconciled to `error`. |
| Start / pause / budget | Same rules as Google and Meta (`ADS_LIVE_LAUNCH`, owner approval, budget ceiling, holds, subscription). Pausing always works, even with the switch off. |
| Attribution | `landing_page_configuration.query_string_template = utm_source=openai&utm_medium=paid&utm_campaign=<our id>` gives the lead source `openai_ad_click` (an ad source in `funnel.js`). |
| Reporting | `GET /campaigns/{id}/insights`, daily, in the account's time zone; spend comes in major units and is stored in cents in `ad_metrics_daily`. |

## Switches (all off unless exactly `true`; each needs approval)
- `OPENAI_ADS_ENABLED`: routes `/api/ads/openai/*`, drafts, starter and dashboard row. Off means 404 and no UI change.
- `OPENAI_ADS_VERIFY_BUSINESSES`: a comma list of businesses allowed to **create paused** campaigns in their real
  account without `ADS_LIVE_LAUNCH`, because OpenAI has no sandbox. Starting still needs `ADS_LIVE_LAUNCH`. A test
  business is never allowed (it must never touch a real ad account). Recommended first value: `getshowups`.
- `ADS_LIVE_LAUNCH`: unchanged, shared by all platforms.
- `OPENAI_ADS_API_MOCK_ORIGIN`: test only, loopback only.

## Not built (deliberately; each is a later, separate approval)
- **Partner OAuth** (AdsOAuth, `auth.openai.com`). The spec has it, but client registration isn't public, and it is
  undocumented how a token selects an ad account. Owner keys are used until OpenAI registers us.
- **Conversions API** (`bzr.openai.com`, pixel and `oppref`). It would mean a new script or cookie on booking pages, a
  new click id to store, and per-account enablement by OpenAI.
- **Lead forms** (`lead_form.response.created` webhook), and images on the chat card (`/upload`).
- Bulk API, custom audiences, product feeds.

## Unverified until a real account is connected
- The error body shape (codes are mapped from the HTTP status only, and provider text is never passed through).
- The format of `readable_time` in daily rows (a row whose value isn't `YYYY-MM-DD` is skipped).
- Whether a payment method is needed before paused creation, and whether paused ads are reviewed.
- Whether `GET /ad_accounts` ever lists more than the key's own account.

## External setup (the founder)
1. Open **ads.openai.com** with the GetShowUps business identity. Create the ad account and complete any business or
   identity verification it asks for. Don't add a payment method unless OpenAI says paused creation needs one.
2. **Ads Manager → Settings → API keys**: create a key for that account. Save it in Keychain as
   `getshowups-openai-ads-key`. Never paste it into chat.
3. Ask your OpenAI partner contact:
   - partner OAuth client registration (redirect `https://getshowups.com/api/ads/openai/callback`);
   - how an OAuth token selects an ad account;
   - whether a test or sandbox account exists;
   - payment and review for paused objects;
   - the policy for home-service advertisers and for B2B software;
   - pixel, Conversions API and lead forms enabled on the account.
4. Approvals, in order: migration 0039 → `OPENAI_ADS_ENABLED=true` and `OPENAI_ADS_VERIFY_BUSINESSES=getshowups` →
   the owner (founder) connects the key in the `getshowups` dashboard → one paused campaign is created and read back.
   `ADS_LIVE_LAUNCH` is not part of this.

## Migration 0039 release (table rebuild; approval)
SQLite can't widen a CHECK in place, so 0039 rebuilds `ad_connections`, `ad_campaigns` and `ad_metrics_daily`. It is the
one reviewed exception to "additive only". It also adds a marker table, `ad_platforms` (google, meta, openai). That is the table Business Review checks (`build.json`) to show 0039 as applied, because the working `*_0039` tables are renamed away. `test/migration-0039.test.js` covers:
- every row, column, index and foreign key is kept;
- `openai` is accepted and unknown platforms are refused;
- it is safe to run twice;
- the rollback refuses while any `openai` row exists.

Release steps:
1. Fresh backup: `npx wrangler d1 export getshowups-onboarding --remote --output ~/getshowups-backups/prod-<UTC>-pre-0039.sql`.
   Check its integrity and table count, as for earlier releases.
2. **Rehearse on a restored copy**: load that export into a local SQLite database, run 0039, then compare row counts and
   `PRAGMA foreign_key_check`. This is done before production is touched.
3. Record the counts of the three tables. Apply:
   `npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0039_ads_platform_openai.sql`.
4. Same counts again, `PRAGMA foreign_key_check` returns no rows, and the new `CHECK` appears in `sqlite_master`.
5. Merge the PR (pinned head), then deploy. Code before this PR works with either schema.

**Rollback:**
- Code: roll Pages back to the previous deployment.
- Schema (rarely needed): disconnect ChatGPT Ads and remove its drafts, take a backup, then run
  `scripts/rollback/0039_ads_platform_openai.down.sql`. It aborts if any `openai` rows remain.
