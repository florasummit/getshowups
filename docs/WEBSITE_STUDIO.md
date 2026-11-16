# Website Studio

Status as of 2026-11-16: one release candidate (`release/website-studio`, PRs #37–#40 combined), not merged or deployed.
**Available to every eligible business** (owner decision 2026-11-16; before, an internal pilot listed in
`WEBSITE_STUDIO_BUSINESSES`, which is no longer read). Eligible = signed-in member of an active business whose website
hosting is active (paid, trialing, past due, or a never-billed pilot like PoolThru), while Studio isn't switched off
(`WEBSITE_STUDIO_ENABLED=false` is the emergency off switch) and its tables exist (migrations 0021–0023: until they are
applied, Studio stays hidden instead of failing). Business Review shows this as capability `website.studio`.
Everyone else keeps today's website tools; their dashboard and onboarding don't show the import, the AI designer or
the AI-key controls, and those routes are 404. Manual editing never needs a key.
AI work runs on the business's own Claude or OpenAI key. A stored key is never replaced by the included GetShowUps-paid
model: an invalid, revoked or unreadable key is reported (`invalid_key`), out of credit is `provider_billing`.
Own-key requests never use Anthropic's server-side fallback: only the chosen/reserved model runs and is priced.
`WEBSITE_STUDIO_PUBLISH` stays unset: AI-designed sites (and imported old-address redirects) can be previewed but not
published or restored live.

**Composition + design quality (2026-11-16, draft PR):** a `composition` section (blocks placed on a 12-column grid,
phone layout derived) for the first screen and signature moments; invalid AI choices are reported, not silently made
generic; design checks with at most one automatic revision (an unusable answer is an error, never a stand-in); raw
answers kept redacted for 30 days; "Show me a different direction" (a fresh design that must differ; undo returns).

## Customer journeys

All four journeys share one draft, editor, renderer, publishing flow, version history and hosting.

| Journey | How | Needs AI key? | Needs domain? | Tested |
| --- | --- | --- | --- | --- |
| 1. Create from scratch | Setup → *Create a new website* (or Website tab). Written from the business details: the included AI within its allowance, the owner's own key, or the template text | No | No | unit + Playwright (self-serve journey) |
| 2. Redesign an existing website | *Bring my current website* → import → review → **suggested fixes** → draft → designs / ask for changes | No | No | unit + Playwright (import, fixes) |
| 3. Start from a design | Setup → *Start from a design*; Website tab → *Choose one of our standard designs (no AI)*. Three professional layouts, no model call, no allowance used | No | No | unit (no model call, allowance unchanged) + Playwright |
| 4. Skip the Website Studio | Setup → *Skip for now*: booking link only; website, address and publish steps complete; create a site later from the Website tab | — | — | unit (steps done, no site created, Website tab still offers the draft) |

- Every site publishes to `getshowups.com/p/<business>`; a custom domain is optional and can be added later.
- Website creation is never forced, and domain and AI are independent capabilities.
- Publishing a new version never touches the domain.

"Compatible design format" means our own design system: palettes, fonts, layouts and sections. Arbitrary HTML, CSS or code imports are not supported, by design.

## What is implemented, tested, missing

| Capability | Status |
| --- | --- |
| Import an existing public website (robots, same site, public hosts only, caps), extraction, review flags | Implemented + tested (unit, Playwright, live trial on poolthru.com) |
| Suggested fixes: typo from the site's own spelling; unrelated template text left out (never rewritten) | Implemented + tested |
| Squarespace photos stepped down to a web size when too large | Implemented + tested |
| Apply to the PRIVATE draft (claims filter per field, photos only from that import) | Implemented + tested |
| Bring-your-own Claude / OpenAI key (validated, encrypted with AAD, last 4 only) | Implemented + tested (mocked providers; no real key used) |
| Old-site redirects on a connected domain (fixed targets, live version only) | Implemented + tested |
| Bare-domain guidance (www connected, apex forwarded at the provider) | Implemented (UI copy), not separately tested |
| Template / standard-design path (no AI) | Implemented + tested |
| Multi-page sites (separate service pages) | **Missing**: one page with sections and anchors |
| FAQ / testimonials / before-and-after components | **Missing**: testimonials are a claims risk and need a verified-source design |
| Side-by-side version comparison | **Missing**: restore of earlier versions exists |
| Managed AI credits / paid allowances | **Missing** (design only); no paid usage activated |
| DNS automation via provider APIs | **Missing**: manual records with mistake detection (doubled host, wrong value) |
| Import of the business's own privacy policy page | **Missing**: the site links to the GetShowUps privacy page |
| Images in R2 instead of D1 | **Missing**: required before scale (below) |
| Cloudflare for SaaS custom hostnames | **Missing**: required beyond the Pages domain cap (below) |

## Hosting cost and scaling (Cloudflare prices as published on 2026-11-15)

### Facts (from Cloudflare docs)

| Item | Published |
| --- | --- |
| Workers Paid | $5/month minimum; 10M requests and 30M CPU-ms included; then $0.30 per million requests and $0.02 per million CPU-ms. Pages Functions are billed as Workers; static asset requests are free and unlimited |
| D1 | 25B rows read and 50M rows written per month included; storage 5 GB included, then $0.75/GB-month. **Max database size 10 GB, which cannot be increased.** Max row/BLOB 2 MB |
| R2 | $0.015/GB-month; Class A $4.50/M; Class B $0.36/M; free tier 10 GB, 1M A, 10M B per month; **egress free** |
| Pages custom domains | **Per project: Free 100, Pro 250, Business 500, Enterprise 500** (more by request) |
| Cloudflare for SaaS | 100 custom hostnames included (Free/Pro/Business); $0.10 per additional hostname ("billed according to your plan"; the period isn't stated on the page; assumed monthly below); max 50,000; pending hostnames count until deleted |
| SaaS + Worker | A `*/*` Worker route on the SaaS zone serves custom-hostname traffic; customers CNAME to the zone's fallback origin (an originless record, e.g. `AAAA 100::`) |
| Apex (bare) domains on SaaS | Apex proxying / BYOIP is an **Enterprise paid add-on** |

### Assumptions (per customer website, per month)

- 4,000 dynamic requests (site HTML, booking API, images through Functions).
- 5 ms CPU per request and about 30 D1 rows read per request.
- About 3 MB of images on average (current cap: 30 images × 1 MB = 30 MB worst case).
- AI on the customer's own key costs us $0. The included model is bounded by the existing monthly cost ceiling, so it's excluded here.

### Estimate

| Sites | Requests | CPU | D1 reads | Image storage | Custom hostnames | **Monthly** |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 40k (incl.) | 0.2M ms (incl.) | 1.2M (incl.) | 30 MB | in Pages (≤100) | **≈ $5** |
| 100 | 0.4M (incl.) | 2M ms (incl.) | 12M (incl.) | 0.3 GB | in Pages (limit reached at 100 on Free) | **≈ $5** |
| 1,000 | 4M (incl.) | 20M ms (incl.) | 120M (incl.) | 3 GB → R2 free tier | SaaS: 900 × $0.10 = $90 | **≈ $95** |
| 10,000 | 40M → +$9 | 200M ms → +$3.40 | 1.2B (incl.) | 30 GB R2 → $0.30 | SaaS: 9,900 × $0.10 = $990 | **≈ $1,010** |

At $499 per customer per month, infrastructure stays well under 1% of revenue. Custom hostnames dominate the cost; beyond about 5,000 hostnames, negotiate Enterprise pricing.

### Architecture for 1,000+ customer domains

1. **Images → R2 before about 300 sites.**
   - Why: D1 is capped at 10 GB per database and the cap can't be raised. At the worst-case 30 MB per site, images alone reach 10 GB at about 333 sites, and they compete with the booking data.
   - How: move `website_assets.bytes` to an R2 bucket (key `<business>/<asset id>`), keep the metadata row in D1, and serve through the existing `/site-assets/<id>` route with the same published-only rule.
   - Cost: egress is free, so this costs about nothing at this scale.
2. **Custom domains → Cloudflare for SaaS before 100 domains** (the Pages cap on the Free plan; 250 on Pro, 500 on Business).
   - **Setup:**
     - a SaaS zone (a dedicated one such as `getshowups-sites.com` keeps customer traffic and settings apart from `getshowups.com`);
     - a fallback origin `sites.<zone>` with an originless record;
     - a `*/*` Worker route to a Worker that runs the same site-serving code as `functions/_middleware.js`, with the same D1 and R2 bindings.
   - **Customer DNS:** `www` CNAME → `sites.<zone>`, instead of `getshowups.pages.dev`.
   - **What stays the same:**
     - our TXT ownership proof stays first;
     - after proof we create the custom hostname through the API, and certificate validation is automatic once the CNAME points to us;
     - the existing "connected" rule stays: DNS points to us, the hostname is active with a certificate, and an HTTPS probe passes.
   - **Migration:** existing Pages custom domains keep working; new domains go to SaaS. Moving an existing domain needs the customer to change one CNAME (announce it, never force it).
3. **Bare domains** stay "www + forwarding at the provider". Apex proxying is Enterprise-only, so revisit it if Enterprise is adopted.
4. **One app, one database:** shared multi-tenant rendering; no per-customer Workers or deployments.
5. **Per-tenant safeguards (existing):**
   - assets: 30 images, 1 MB each;
   - versions: kept, nothing deleted;
   - AI: daily limits per business plus a monthly cost ceiling for the included model;
   - imports: 6 per hour;
   - rate limits on public pages;
   - the claims filter on every published word.

   **To add with SaaS:** WAF rate-limiting rules on the SaaS zone, and an alert on custom-hostname count against the plan.

## Security review (this work)

- **Import:**
  - SSRF: public hostnames only, via `normalizeWebsiteUrl` on every hop, including redirects;
  - robots.txt honoured; no cookies or JavaScript;
  - size and time caps; same-site pages only; photos only from the import that found them;
  - imported text is treated as data: an injected "5-star review" heading is refused by the claims filter (tested).
- **AI output:** model output never becomes markup. It's JSON choices from our design system plus prose that passes the claims filter, the invented-number check and design repair.
- **Keys:**
  - AES-GCM under an HKDF subkey, with AAD = business + provider;
  - validated before storing; never returned, logged or rendered;
  - dead keys are marked invalid.
- **Isolation:**
  - every route takes the business from the session;
  - imports and keys are checked against the business id;
  - redirects only from that business's live version on its own verified domain.
- **Fixed-target redirects:** no open redirects; targets are a fixed list, never URLs.
- **Fixes:** never applied without the owner's tick; corrections come only from the owner's own site.
