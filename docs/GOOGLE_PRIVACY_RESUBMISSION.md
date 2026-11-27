# Google OAuth: privacy-policy finding and resubmission

Finding (project getshowups): "Your privacy policy does not specify any data protection mechanisms for sensitive data."
Policy: https://getshowups.com/privacy (public, no sign-in, readable without JavaScript). The URL is unchanged.

## Claims and evidence (2026-11-24)
| Claim in the policy | Status | Evidence |
| --- | --- | --- |
| HTTPS only, HSTS | VERIFIED | live 301 and header; functions/_middleware.js; test/security-headers.test.js |
| Cloudflare encrypts D1/KV at rest (AES-256) | VERIFIED (documented) | developers.cloudflare.com/d1/reference/data-security, /kv/reference/data-security |
| Google refresh credentials AES-256-GCM, server-only | VERIFIED (code, tests) | server/google-oauth.js, server/ads/connections.js; test/google-oauth.test.js |
| Access tokens not stored | VERIFIED (code) | calendar.js, ads/google.js fetch per use |
| Least-privilege calendar scopes, state + PKCE | VERIFIED | server/google-oauth.js |
| Session tokens hashed, 7 days | VERIFIED | server/auth.js |
| Email sign-in (2026-11-26): address used only to send the code + link; single use, 15 minutes, stored as hashes (code: keyed HMAC) | VERIFIED (code, tests) | server/email-auth.js, migration 0046; test/email-auth.test.js. Sign-in emails reach only test recipients until AUTH_EMAIL_LIVE |
| Server-side separation between businesses | VERIFIED (tests) | requireSession; isolation tests. Application-level in one database |
| Named administrators, tamper-evident log | VERIFIED | server/platform.js, auditlog.js |
| Logs hold codes, not contents | VERIFIED by code review | no central redaction filter |
| Inbox and receptionist text deleted after 12 months | VERIFIED | followups/engine.js, receptionist/engine.js |
| Failures recorded for review | VERIFIED | server/ops/incidents.js; push alerts are off and not claimed |
| No training on Google user data by GetShowUps | VERIFIED for our code | provider practices below |
| OpenAI carries voice today | VERIFIED 2026-11-24 | production default openai, no overrides |

Not claimed, because MISSING or UNCONFIRMED: certifications, penetration tests, breach-notice times, round-the-clock
monitoring, automatic or self-service deletion, in-app calendar disconnect, zero retention, end-to-end encryption, and "no provider trains" for ElevenLabs and Retell.

## Open gaps (owner)
1. ElevenLabs may use non-enterprise data to improve models unless opted out, and keeps agent conversations 2 years by
   default; Retell keeps calls indefinitely by default. Spoken open times come from Google free/busy, so don't select
   either for a business until their account settings are confirmed.
2. OpenAI data-sharing setting, Cloudflare plan and minimum TLS version: confirm in their dashboards.
3. Disconnecting Google Ads keeps figures already read (disclosed in the policy).
4. Docs disagree whether the Ads API access is Test or Explorer.

Other operational items were reported to the owner directly.

## Resubmission (owner; nothing has been submitted)
1. Open https://getshowups.com/privacy and read "How we protect your data".
2. Google Cloud console → project getshowups → Google Auth Platform → Branding: privacy policy link is
   https://getshowups.com/privacy. No change needed if it already is.
3. Data Access: the listed scopes must equal what the app asks for: openid, email, calendar.events.owned,
   calendar.freebusy, adwords. Business Profile and Data Manager are off; don't list them.
4. Verification Center: follow the open issue, or reply to Google's email with the text below.

### Reply (draft, not sent)
> Hello,
>
> We have updated our privacy policy for project getshowups: https://getshowups.com/privacy (same URL).
>
> The section "How we protect your data" now describes our data protection mechanisms: HTTPS in transit, encryption at rest
> by our hosting provider, additional AES-256-GCM encryption of stored Google credentials with a key kept as a server
> secret, least-privilege scopes, hashed session tokens, server-side separation between businesses, restricted and logged
> administrator access, and monitoring. "Google data and AI", "Sharing" and "Retention and deletion" were updated as well.
>
> Please let us know if anything else is needed.
>
> Best regards,
> GetShowUps
