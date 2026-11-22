# Meta (Facebook / Instagram) ads: readiness, controlled testing, activation path

Status 2026-11-21: **built and tested against a mocked Graph API; not connectable in production** because GetShowUps
has no Meta app configured (`META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` are not set). Owners can
draft, preview, review and dry-run a Facebook & Instagram lead-ads campaign today; connecting a Page and ad account,
creating the (paused) campaign and starting it come after the steps below. Nothing here spends money by itself.

## What exists (server/ads/meta.js, spec.js, campaigns.js; src/dashboard/Ads.jsx)

| Step in the owner's workflow | Where | State |
| --- | --- | --- |
| 1. Connect a Meta business (Page + ad account) | `/api/ads/meta/start` → Meta login → `/callback` → `/accounts` (choose one of each; validated against Meta's lists) | Built, tested with a mocked Graph API. Needs the Meta app (below). |
| 2. Choose placements | spec `meta.placements` (`facebook`, `instagram`; both = Meta's automatic placements) → ad set `targeting.publisher_platforms` | Built. |
| 3. Objective | Fixed: `OUTCOME_LEADS` with an instant form (`destination: 'instant_form'`); website-click lead ads are refused (`unsupported_destination`, they need a pixel) | Built. |
| 4. Service geography | ZIP codes from the business details (`geo.zips` → `geo_locations.zips`, format verified only against a test account) | Built. |
| 5. Audience | `meta.audience.ageMin/ageMax` (18–65) → `age_min` / `age_max`. No interest or lookalike targeting (not promised, not built) | Built. |
| 6. Budgets | Daily budget (minor units) under the owner's approved monthly ceiling; optional `endDate` → ad set `end_time`, shown as "most it can spend" = daily × days | Built. |
| 7. Creative | AI image (OpenAI Images, when `OPENAI_API_KEY` + `OPENAI_IMAGE_MODEL` + R2 `AD_ASSETS` exist: not in production) **or the owner's own website photo** turned into a creative (`from_asset`, no AI, no cost). Every creative needs the owner's explicit approval; logos are never offered; video upload is not implemented | Built. |
| 8. Preview | Sponsored · placements, main text, image, headline, description, button | Built. |
| 9. Review | The review list the approval covers: platform, goal, where, ages, budgets, stop date, images, form, button, what happens on approval | Built. |
| 10. Create paused | `launch`: everything created `PAUSED`, idempotent (objects found by our `GSU-<id>` tag), partial failures keep ids | Built, mocked. Needs `ADS_LIVE_LAUNCH=true` (approval) + an approved budget + (billed accounts) an active subscription. |
| 11. Verify the created campaign | `verifyCampaign`: campaign, ad set and ad read back; status, objective, daily budget, ZIPs, placements, ages, optimization goal, end date, ad present; recorded as `ad_actions` kind `verify`; a deleted campaign reconciles to "removed" | Built, mocked; runs right after creation and daily (cron `verifyLaunched`). |
| 12. Approve activation | Owner presses Start (`resume`) → ad, ad set, campaign set `ACTIVE`; refused on hold, without budget room, or without the live switch | Built. |
| 13. Monitor | Daily insights (`spend`, impressions, clicks, lead actions) → `ad_metrics_daily` → funnel | Built, mocked. |
| 14. Pause | Owner Pause, the optimizer (pause-only), holds (failed payment, suspension, deletion) | Built. |
| 15. Attributable leads and bookings | Lead-ads webhook (`/api/ads/meta/webhook`, verify token + idempotent `leadgen_id`) → lead with `lead_attribution.source = 'meta_lead_form'` → bookings/outcomes in the one funnel (server/ads/funnel.js) | Built, mocked. |

Not built and not promised: interest/lookalike audiences, Messenger/Audience Network placements, video ads,
website-conversion campaigns (pixel), Advantage+ campaigns, A/B tests.

## What the founder must do outside the product (approval items)

1. **Meta app**: create an app in Meta for Developers under the GetShowUps business; add Facebook Login and Marketing
   API; set the redirect `https://getshowups.com/api/ads/meta/callback`.
2. **Business verification** of the GetShowUps business portfolio (Meta requirement for Advanced Access).
3. **App Review** for `ads_management`, `ads_read`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads`,
   `pages_manage_metadata`, `leads_retrieval`, `business_management` (the scopes in `META_SCOPES`). Until approved,
   the app works only for people with a role on the app (fine for PoolThru/GetShowUps testing).
4. **Leads webhook**: subscribe the app to the Page `leadgen` field with the callback
   `https://getshowups.com/api/ads/meta/webhook` and the verify token you set as `META_WEBHOOK_VERIFY_TOKEN`.
5. Set `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` on the Pages project (secrets; approval).
6. A **test ad account** for the first dry runs and the first paused campaign; a payment method is set up in Ads
   Manager by the business that advertises (GetShowUps never stores card data).

Then, for a real paused campaign: `ADS_LIVE_LAUNCH=true` (approval), the owner's budget approval and their Start.

## The smallest test, in order

1. Local/e2e: the Meta editor, preview, review and dry run work with no Meta app (test/e2e/ads.spec.js).
2. Production, after the app exists: connect the GetShowUps (or PoolThru, with their say-so) Page + test ad account;
   draft; dry run ("Check (no spend)") → no objects created.
3. `ADS_LIVE_LAUNCH=true` → Approve and create (paused) → the read-back shows "all checks match" → leave it paused;
   compare with Ads Manager.
4. Only with a separate, explicit approval: Start, with a small daily budget and a stop date.

A paused campaign is not a live campaign. Nothing in this flow bypasses Meta's business verification, permissions or
advertising policies.
