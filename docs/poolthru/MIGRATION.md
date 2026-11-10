# PoolThru: managed website pilot, review and domain migration plan

Nothing in this plan has been done to PoolThru's live domain, DNS, website or production records. Each step
marked **approval** needs an explicit yes.

## 1. Current vs proposed

| | Current (checked read-only 2026-11-10) | Proposed (GetShowUps) |
| --- | --- | --- |
| Website | Squarespace at www.poolthru.com ("PoolThru Pool Care"); pages: Home, Services, About, Contact, Careers, Our App, Privacy | One page at www.poolthru.com: headline, 3 services, about, service area, booking, call button |
| Content source | PoolThru's own Squarespace copy | Draft in `docs/poolthru/website-draft.json`, written only from facts PoolThru already publishes: Charleston, SC; weekly service; one-time service; pool closing and winterization; phone 678-855-8825 |
| Booking | "Request Service" form | Book a time → existing GetShowUps booking page on PoolThru's Google Calendar (unchanged) |
| Current GetShowUps page | getshowups.com/p/poolthru-llc is published with the placeholder headline "Service", no services, no phone | Replaced by the draft only after you publish it |
| SEO | Canonical https://www.poolthru.com, empty meta description | Canonical https://www.poolthru.com/, title + description set, LocalBusiness structured data, robots.txt + sitemap |
| Old URLs | /services, /about, /contact, … | Every old path 301-redirects to the home page (no 404s); the home page covers services, about and contact |
| DNS host | Google Cloud DNS (googledomains nameservers, now managed via Squarespace Domains) | Unchanged |
| Email | Google Workspace (MX smtp.google.com, SPF include:_spf.google.com) | **Unchanged.** No MX/SPF/TXT record is touched |
| Bare domain | poolthru.com → 301 → www.poolthru.com (Squarespace) | Keep a domain-level forward poolthru.com → www.poolthru.com at the domain provider |

Not invented: no reviews, guarantees, prices, licences, years in business or extra towns. "Poolthru LLC" is the
business name on record; to show "PoolThru Pool Care", the owner renames it in Settings → Business.

**Decision needed before publishing.** PoolThru's appointment mode is `at_business`, so the site and booking page
say "Come in at the booked time". A pool service normally visits the customer. Switching to "At the customer's
home or site" (Settings → Business) changes the booking flow to collect a service address. This is the owner's
choice; I have not changed it.

## 2. Review the draft (no production change)

- Local file: open `poolthru-preview.html` from the session scratchpad. It is rendered by the production engine
  with the inert preview links. A visit-mode variant, `poolthru-preview-visit-mode.html`, sits next to it.
- After the release is deployed (approval), the owner can review it privately in Dashboard → Website.
  Loading `website-draft.json` into PoolThru's **private draft** is a production write (**approval**). Nothing is
  public until the owner ticks the consent box and presses Publish.

## 3. Cutover (each step: approval)

Prerequisites: the release is deployed, migration 0009 is applied, and the hosting credentials are set
(`CF_API_TOKEN` with Pages:Edit, `CF_ACCOUNT_ID`, `CF_PAGES_PROJECT=getshowups`). The draft is published on
getshowups.com/p/poolthru-llc and approved.

1. Dashboard → Website → Use your own domain → `www.poolthru.com`.
2. At the domain provider, add TXT `_getshowups.www.poolthru.com` = `gsu-verify=…` (shown in the dashboard).
   Nothing about the current site changes.
3. GetShowUps verifies the TXT and attaches www.poolthru.com to hosting. Squarespace still serves the site.
4. **Cutover moment:** change the `www` CNAME from `ext-sq.squarespace.com` to `getshowups.pages.dev`. Do this at a
   quiet hour. Within minutes to an hour, www.poolthru.com serves the new site; the dashboard shows "Connected" only
   after the certificate is issued and an HTTPS check confirms PoolThru's site is being served.
5. Set the provider's domain forwarding: poolthru.com → https://www.poolthru.com (301). Leave the Squarespace
   subscription active for at least 7 days.
6. Check: https://www.poolthru.com loads the new site, an old URL (e.g. /services) redirects to /, email still
   arrives (send a test to the Workspace mailbox), and Google Search Console still sees the site (re-submit the
   sitemap).

## 4. Rollback (minutes)

1. Change the `www` CNAME back to `ext-sq.squarespace.com`. The Squarespace site returns as soon as DNS updates.
2. Optionally, Dashboard → Website → Disconnect domain. This removes the hostname from hosting; the website stays on
   getshowups.com/p/poolthru-llc.
3. Email is unaffected throughout, because MX was never changed.

## 5. Risks

- **DNS propagation:** expect a short window where some visitors still see Squarespace. This is harmless.
- **CAA records:** none were found. If the provider adds CAA, certificate issuance needs letsencrypt.org /
  pki.goog / ssl.com allowed.
- **Squarespace pages** not covered by the new site (Careers, Our App) redirect to the home page. If they matter,
  keep them on Squarespace under another subdomain or add them as sections later.
- **Cancellation:** the domain stays PoolThru's. To leave, point `www` anywhere else; the content export is in
  Dashboard → Website.
