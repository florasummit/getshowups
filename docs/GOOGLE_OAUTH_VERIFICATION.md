# Google OAuth verification (sensitive scopes)

Status: **submitted by the owner; under Google review** (recorded 2026-11-14; submission date to be confirmed by the
owner). Cloud project: one OAuth client (`380394286094-cume4v1s…apps.googleusercontent.com`). Branding and Explorer
access were approved earlier; this review covers the sensitive scopes.

## Scopes requested and where they are used

| Flow (route) | Scopes | Used for | Code |
| --- | --- | --- | --- |
| Dashboard sign-in (`/api/auth/google/start`) | `openid`, `email` | Identify the person; business access comes from our own records | `server/auth.js` `LOGIN_SCOPES` |
| Connect Google Calendar (`/api/google/oauth/start`) | `openid`, `email`, `calendar.freebusy`, `calendar.events.owned` | Free/busy for open booking times (never event details); create/delete only the appointment events GetShowUps adds | `server/google-oauth.js` `SCOPES`, `server/calendar.js` |
| Connect Google Ads (`/api/ads/google/start`) | `adwords` | List the owner's accounts, create campaigns **paused** after owner approval, read status/budget/metrics, pause/resume on request | `server/ads/google.js` `ADS_SCOPE` |
| (off) Conversion feedback | `datamanager` | Only when `ADS_CONVERSIONS_ENABLED=true` | `server/ads/conversions.js` |

`datamanager` is **not** part of the submission or the video. Do not set `ADS_CONVERSIONS_ENABLED` while this review
is open; adding it later is a new sensitive scope (new verification evidence, approval).

## Evidence (kept outside the repo; never delete)

`~/getshowups-demo/` on the founder's machine, read-only files:

| File | What | SHA-256 |
| --- | --- | --- |
| `raw.mov` | Original live screen recording (2026-11-14) | `a2e93ef3…2b71` |
| `getshowups-oauth-demo-v1.mp4` | First edit (Calendar event scene missing) | `c9b5afd2…005` |
| `getshowups-oauth-demo-v2.mp4` | **Submitted video**: v1 + live Google Calendar evidence clip | `264fbd74…612` |

What the video shows (all live, test business "GSU Stripe Test Pools", Google Ads test account, no spend): homepage →
Google sign-in (account chooser covered) → Calendar consent (English, app name, both Calendar scopes, client ID in the
address bar) → booking page offers only free times → booking → the appointment on Google Calendar (Mon Nov 16 11:00,
event id matches the booking record) → Appointments tab → Ads details → Ads consent (`adwords`) → test account
connected → budget approval → campaign created **paused** → read back from Google → status check → disconnect
control. Emails, the Ads customer id, the passkey prompt and other desktop windows are cut or covered.

## Keep consistent with the submission (change freeze while under review)

Changing any of these can invalidate the evidence; each needs approval and possibly new evidence:

- Requested scopes (adding, removing or widening any), `prompt`/`access_type` of the Calendar and Ads flows.
- App name/logo, homepage `https://getshowups.com`, privacy policy `https://getshowups.com/privacy`, authorized
  domains, redirect URIs (`/api/auth/google/callback`, `/api/google/oauth/callback`, `/api/ads/google/callback`).
- Removing the behaviour shown: free/busy-only availability, event creation on the business calendar, paused
  campaign creation with owner approval, read-back, owner disconnect.

Safe while under review: UI copy, unrelated features, admin console, billing, tests.

## Reviewer questions: prepared answers

- **Why `calendar.events.owned` and not full `calendar`?** We only create (and on cancellation delete) the events
  GetShowUps adds for bookings, using our own event ids; we never read or edit other events.
- **Why `calendar.freebusy`?** To offer only times the business is free. Event titles/details are never read.
- **Why `adwords`?** The owner connects their own Google Ads account; GetShowUps lists their accounts, creates
  campaigns paused after explicit owner approval within an owner-approved budget, reads status/budget/metrics, and
  pauses/resumes only on the owner's request. No automatic budget increases; launch needs an explicit switch.
- **Data handling:** refresh tokens AES-GCM encrypted at rest (KV), never logged or shown; event/calendar data not
  stored beyond our own appointment rows; owner can disconnect at any time (Ads disconnect deletes our token).
- **Limited Use:** Google user data is used only to provide these user-facing features; not sold, not used for ads
  targeting or model training. `/privacy` ("How we use Google user data") says this and links the Google API
  Services User Data Policy, including Limited Use (`src/legal/Privacy.jsx`; checked 2026-11-14).

## Risks to watch

- Privacy policy: Calendar (free/busy only, own events), Google Ads, Limited Use statement present (checked 2026-11-14).
  Keep `src/legal/Privacy.jsx` in sync with any behaviour change.
- The demo's sign-in account and the Calendar/Ads account differ (connections use whichever Google account the owner
  picks on Google's screen; by design). If asked, explain that the business owner may connect any Google account
  they control.
- The production Google Ads developer token is Explorer access; real-account campaigns need standard access later.
