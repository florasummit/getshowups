# Google Ads API: eligibility and compliance gate

Reviewed 2026-11-13 from official Google pages (links below). **Verified** = stated on an official page.
**Inference** = our reading, to confirm with Google. Re-check before any real (non-test) launch.

## What Google states (verified)

| Topic | Fact | Source |
| --- | --- | --- |
| Developer tokens | Sunset on September 9, 2026. API access levels now belong to the **Google Cloud project** that issued the OAuth client. Sent tokens are ignored. | [developer-token](https://developers.google.com/google-ads/api/docs/api-policy/developer-token) |
| Access levels | **Test**: test accounts only. **Explorer**: production accounts, 2,880 operations/day (automated approval in most cases). **Basic**: 15,000/day, needs brand verification. **Standard**: unlimited, manual audit, RMF applies. | [access-levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels) |
| Explorer restrictions | Blocks account creation (`CreateCustomerClient`), user management, planning services and billing/payments services. Campaign, ad group, keyword and ad management are not on the list. | access-levels |
| Test-level projects | A Test-level project calling a production account gets `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`. | developer-token |
| Offline conversions | Since June 15, 2026 the Google Ads API accepts no new adopters of offline click uploads (`CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`). New integrations must use the **Data Manager API** (`POST https://datamanager.googleapis.com/v1/events:ingest`, scope `https://www.googleapis.com/auth/datamanager`, a sensitive scope). It still sends events to a conversion action of type `UPLOAD_CLICKS`. Events are deduplicated by `transactionId`, and the API supports `validateOnly`. | [blog 2026-05](https://developers.google.com/ads/blog/posts/2026/05/changes-to-offline-click-conversion), [Data Manager offline](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline), [ingest](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest) |
| Account creation | `CreateCustomerClient` creates an account under a manager account. It needs Basic+ access and is "available only to advertisers who have spent more than $1,000 USD". | [create-account](https://developers.google.com/google-ads/api/docs/account-management/create-account) |
| Billing | Billing setups link a Payments account and profile. Billing services are blocked at Explorer. Card setup via the API is not documented. | [billing-setups](https://developers.google.com/google-ads/api/docs/billing/billing-setups) |
| Developer policy: proxies | Prohibits "programmatic proxies" (interfaces that solely re-expose Google Ads capabilities), letting third parties avoid their own access, and shared proxies routing many businesses' automated requests. It also states that "end users of your tool will need to manually sign in to make changes" and that headless programmatic changes need Google review or per-entity Google authentication. | [Developer Policies](https://support.google.com/adspolicy/answer/6169371), [blog 2026-08-31](https://developers.google.com/ads/blog/posts/2026/08/making-google-ads-more-secure-with) |
| Developer policy: tools for advertisers | In-app disclosure of data access and use. Help documentation for deleting data. Within 3 business days of a request, clients can disassociate and regain exclusive control. Encrypt tokens at rest. Prominently disclose reporting delays over 24 hours. Provide a demo account within 7 days of a request. | Developer Policies |
| RMF | Required Minimum Functionality applies **only to Standard** access. | [rmf](https://developers.google.com/google-ads/api/docs/api-policy/rmf) |
| OAuth | Multi-user apps use the `adwords` scope with offline access. Apps used by external users must complete **OAuth app verification**. New user sign-ins need a passkey (rollout from Aug 5, 2026). | [multi-user auth](https://developers.google.com/google-ads/api/docs/oauth/multi-user-authentication), [passkey blog](https://developers.google.com/ads/blog/posts/2026/07/passkey-authentication-requirement-for) |
| Inactivity | Access is revoked after 90 consecutive days without use. | Developer Policies |

## Our status

**Verified by our own production behavior.** Production discovery calls to a real Google Ads account return
`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`. Our Cloud project is therefore at **Test** level and can only use
**test accounts**. PoolThru is connected to test client 642-666-3252.

**Fits the policy text (inference):**
- Each business signs in with its **own Google account** (per-advertiser OAuth).
- GetShowUps calls Google directly from its own Cloud project. It offers no API or MCP interface to anyone.
- Every change is started by the owner in the dashboard. Automatic pausing is **off** unless
  `ADS_AUTOMATION_ENABLED=true` (approval). The optimizer only recommends.
- Ads tokens are AES-GCM encrypted at rest.

**Open (needs confirmation from Google):**
1. Whether one multi-tenant Cloud project (shared with our Calendar sign-in) fits the "dedicated Google Cloud project"
   and "end-advertiser clients … their own Google Cloud Platform account" wording, or whether Google expects a
   different setup. Ask the Google Ads API Compliance team:
   https://support.google.com/adspolicy/contact/contact_ads_api
2. OAuth consent screen publishing status and app verification for the `adwords` scope (Cloud Console; not visible
   to us here).
3. Whether the scheduled reads (daily metrics sync, daily read-back of created campaigns) count as acceptable
   per-advertiser-authenticated automation. They are read-only.

## Launch blockers for a real (non-test) PoolThru pilot

1. **API access:** apply for **Explorer** access in Cloud Console (Google Ads API overview page). This is an
   external action that needs approval.
2. **Policy confirmation:** the multi-tenant model (open item 1). Recommended before real spend.
3. **OAuth verification:** for the `adwords` scope, if the app isn't already verified.
4. **PoolThru's Google Ads billing:** set up by the owner in Google Ads. Google collects payment, and GetShowUps never
   handles ad payment details.
5. **`ADS_LIVE_LAUNCH=true`:** approval. Test businesses stay test-only regardless.
6. **Conversions to Google:** need the Data Manager API, a new sensitive OAuth scope (approval and verification),
   and the conversion action. Until then, campaigns use **Maximize clicks**, not conversion bidding.

## Built-in safeguards that follow from this review

- **Bidding:** created campaigns use Maximize clicks (`targetSpend`), because no conversion data reaches Google yet.
- **Read-back:** every created campaign is read back from Google right after creation and daily after that. Differences
  are shown to the owner, and paused/enabled/removed state follows Google.
- **Account switching:** switching Google Ads accounts resets approvals on campaigns not yet created. Created campaigns
  are never acted on in another account (`account_changed`).
- **Lower budgets:** a lower budget approval lowers running campaigns on Google, or pauses them if that fails.
- **Charging wording:** the daily budget is described as an average. Google may spend up to 2× on a day, but at most
  about 30.4× the average in a month.
