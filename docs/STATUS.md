# Status, decisions, next actions

_Update at the end of every task. Newest first._

## Twilio: one subaccount per business, A2P through Twilio's APIs (2026-11-16) — feature/twilio-subaccounts; migration 0025 (NOT applied)

- Founder decision: ONE GetShowUps parent account, ONE Twilio subaccount PER business (Twilio's preferred ISV
  architecture). Reuses the Build 49 engine unchanged except where it talks to Twilio.
- server/followups/twilio.js: subaccount create/recover (stable FriendlyName, adopted after a lost response, only
  subaccounts of our parent), token sealed (AES-GCM, HKDF subkey, AAD business|SID), usage (provider records),
  close on account deletion. Sending: parent creds on `/Accounts/<sub>/Messages.json`; a business without an active
  subaccount never texts (`no_account`). Webhooks: verified with the token of the AccountSid Twilio names; a sender
  is accepted only from its own business's subaccount (`account_mismatch` otherwise). Dead `sendSms` (parent
  account) removed; the test-mode check now also runs at the provider call.
- server/followups/provisioning.js: both paths through Twilio's APIs, one confirmed + audited admin step at a time
  (/admin → Twilio setup): low_volume_standard (EIN: Secondary profile → A2P profile → brand SkipAutomaticSecVet →
  LOW_VOLUME campaign) and sole_proprietor (no EIN: Starter profile → sole-prop trust product → SOLE_PROPRIETOR brand +
  owner OTP, resend → SOLE_PROPRIETOR campaign). Submitting/paid steps need TWILIO_REGISTRATION_SUBMIT=true (off)
  AND an approval tick; unknown outcomes recorded and never resent; noncompliant evaluations stop before submitting;
  'approved' only when Twilio reports the campaign VERIFIED (Sync + hourly cron). Number bought in the business's
  subaccount and attached to its Messaging Service.
- Owner form: structured address, representative (name, title, position), industry; path derived from business type.
- Unverified until the first real run (not in Twilio's docs): a subaccount profile referencing the parent's Primary
  profile SID; failure stops before submission (docs/A2P_REGISTRATION.md "If the first real run fails").
- Tests: unit 518 (8 new), browser 88 (Twilio setup panel). Nothing real was created, submitted or bought.
- **Needs approval**: migration 0025; then docs/TEXTING_ACTIVATION.md §1 (Twilio upgrade, Primary ISV profile,
  secrets) and §2 per business. SMS_LIVE / FOLLOWUP_AI / MESSAGES_LIVE stay off.

## Texting onboarding: opt-in before approval, A2P registration prep (2026-11-16) — PR #51 (8a5bba3)

**Production then**: release e2cde29 (PR #50) + PR #51; migration 0024 APPLIED 2026-11-16 (founder approval):
4 tables + 5 indexes verified; existing leads/appointments/messages/outbox/opt-outs/consents unchanged (counts
identical). Production test on the sandboxed `gsu-journey-test` (fake example.invalid lead): conversation record
created, follow-ups scheduled, booking → stage booked, retry 409, wrong token / other business 404, confirmation
`test_mode` (not a test recipient), first follow-up `not_needed` after booking. That test lead + its 19 Nov 14:00 UTC
booking + calendar event remain (test business). Logs: cron 200, no errors. Switches: MESSAGES_LIVE off, SMS_LIVE /
FOLLOWUP_AI / TWILIO_* not set. No Twilio account configured, no registration submitted, no number bought.

- Fixed the circular dependency: the texting box needed provider approval, but carriers review the live opt-in BEFORE
  approving. Now offerSmsFor(): shown (and consent accepted) once the owner approved submitting the registration
  (status ready/pending/approved; rejected/suspended/kill switch hide it). Texts still need the provider's approval +
  own sender + SMS_LIVE. Consent can no longer be recorded through the API where the box isn't offered.
- /sms-terms/<id>: public opt-in evidence (both boxes, exact wording, unchecked, inactive), booking link, who sends.
  Website-form box now also links Privacy. Privacy policy: "or text the business first", HELP, 12-month inbox retention.
- Registration content shown to the owner and used for the campaign: description, message flow (every opt-in path,
  public URLs, both box wordings), 4 samples = the real templates with [variables] and real links (no "…").
- Twilio keyword handling: OptOutType (STOP/START/HELP) from Twilio wins; we never send a second answer to a keyword
  Twilio answered (previously START/HELP would have been answered twice under Twilio's default handling).
- docs/A2P_REGISTRATION.md: ISV path (Primary profile "ISV Reseller or Partner" → per-business Secondary profile →
  brand → campaign), brand type per business (EIN → Low-Volume Standard; no EIN → sole prop, API-only for ISVs, not
  supported by our manual flow yet), PoolThru checklist, fees (usage verified; registration fees ESTIMATES), review,
  pre-approval testing, controlled website-form acknowledgment test on gsu-journey-test.
- Decision pending (founder, before the 3rd business): Twilio prefers a subaccount per business; we run one account
  with a Messaging Service per business (supported, riskier). Subaccounts need per-business credentials (not built).
- Remaining dependencies, in order (each needs approval): Twilio account upgrade + secrets → GetShowUps Primary
  Customer Profile → PoolThru owner approves its registration in Follow-ups → Texting → admin submits brand +
  campaign (fees) → record pending/approved in /admin → buy number + Messaging Service → test recipients → SMS_LIVE.
  Customer emails stay test-only until MESSAGES_LIVE (approval). Assistant: FOLLOWUP_AI (approval).

## Post-Build-49 checks (2026-11-16) — fix/quiet-hours-order; no migration

- PoolThru /p/poolthru-llc 404: NOT the release. audit_log seq 53 `website.unpublish` by an owner session at 20:00:52
  UTC (two-click "Take website offline"), 10 min after publishing v7 and 51 min before b5a7f86 deployed. v7 intact;
  the draft holds unpublished edits (palette, hero focus), so Restore (overwrites draft) and Publish (puts them live)
  are owner decisions. Founder decision: leave it offline; nothing written.
- Fix: quiet hours deferred a text before the permanent skip checks, so a text that could never go (GHL owns texting,
  not ready, opted out) was postponed nightly instead of skipped; it also made a CI test fail between 21:00 and 08:00
  UTC. The deferral now runs last. Regression test with a fixed night clock. Only reachable after 0024 + Twilio.
- Runbook: production D1 is `getshowups-onboarding` (docs/TEXTING_ACTIVATION.md said ONBOARDING_DB, the binding).
- 0024 re-reviewed: 4 tables + 5 indexes, all IF NOT EXISTS, no ALTER/DROP/UPDATE/DELETE/INSERT; none exist in prod.

## Build 49: follow-up engine, two-way texts, A2P 10DLC readiness (2026-11-16) — PR #49 (b5a7f86); migration 0024 applied 2026-11-16

- One engine for every eligible business (server/followups/): source adapter (website_form, booking_page, sms; ready
  for google_ads/gbp/call) → consent → immediate acknowledgment (website forms) → conversation → booking → follow-ups
  stop. Reuses leads, messages (new kinds lead_ack, interested_followup, after_visit), the scheduler, Resend, opt-outs,
  consent, conversation_control, the audit log. New: lead_threads, thread_messages, followup_settings, sms_registrations.
- Texts only from the business's OWN sender with a provider-APPROVED registration + consent + SMS_LIVE (else test
  recipients only). Existing confirmation/reminder texts now follow the same rule (prod had no Twilio configured).
- Two-way texts: signed Twilio webhooks, MessageSid idempotency, forward-only delivery updates, fixed STOP/START/HELP/
  human/cancel handling, assistant on the included model (FOLLOWUP_AI, off) with strict checks and a fixed fallback.
- Dashboard Follow-ups tab: counts, inbox, conversation, takeover/hand back/reply/stop, pause, preferences, texting
  registration (details + explicit approval). Website forms and booking page offer the texting box only when ready;
  public /sms-terms/<id>. Admin: counts, failures, stuck work, spikes, costs, registrations, record provider status.
- Tests: unit 509 (19 new follow-up tests), browser Follow-ups journey on desktop + phone.
- 0024 applied 2026-11-16 (founder approval). Remaining activation: see the A2P onboarding entry above.

## Website Studio UX overhaul (2026-11-16) — feature/studio-ux; no migration, no paid calls

- The website preview is the editing surface: click text to type in place; click a button (text + destination) or a
  photo (choose, shape, focus point, description) for a small panel; hover/selected sections show a compact bar
  (name, ↑, ↓, ⋯ = settings / add below / duplicate / hide-show / remove with confirmation). Edit | Preview mode,
  Desktop | Phone, icon undo/redo (typing coalesced into one step), unobtrusive save status.
- Side panel: contextual (selected section's settings) + Sections (compact rows, drag to reorder, arrows, ⋯) · Style ·
  Photos · History. Concise section names (Hero, Services, Benefits, How it works, FAQ, Booking, Service areas…).
  "+ Add a page…" in the page menu.
- Website tab: a slim publish bar, then the editor (wider page); import + AI designer in one collapsible row above it
  (kept mounted so a designer conversation isn't lost).
- Rendering: hero photo heights capped (min(560px, 64vh); stacked 480px/56vh). AI designs that open a page twice get a
  soft `repeated_opening` revision; the editor can't add or duplicate a second opening. Stored content untouched.
- Tests: unit 490; browser 85 (in-place headline, button panel, price in place, add/hide/show/duplicate/move sections,
  brand colour, add page from the page menu, phone + Preview mode, reload persistence, undo/redo, keyboard menu,
  photo panel framing, history restore, publish/republish/restore, two-tab conflict).

## Website publishing for every eligible business (2026-11-16) — feature/publishing-on; no paid calls; no migration

- Publishing is standard self-service (no allowlist, no per-business flag): studioPublishAllowed is ON unless
  WEBSITE_STUDIO_PUBLISH === 'false' (emergency pause). No Cloudflare setting needed: the code release turns it on.
- Safety added: restore now requires confirmation like publish (UI asks first); every page must render before going
  live (422 render_failed, live untouched); version insert + live pointer in one D1 batch (all or nothing, tested by
  failing the store mid-publish); Publish is held while the Studio editor has unconfirmed edits.
- Unchanged: publish needs the owner (session, same-origin), explicit confirmation, a bookable business (calendar +
  hours) and active hosting; per-business data; audit (website.publish / website.restore events); versions + rollback;
  GetShowUps address /p/<id> and connected domains; no AI key needed to publish.
- Tests: unit 488, browser (editor journey now publishes, republishes and restores on the GetShowUps address).

## Website Studio closing pass (2026-11-16) — feature/studio-finish; no paid calls; no migration

- Production migrations 0021–0023 VERIFIED applied (read-only sqlite_master + pragma_table_info): all 8 tables/indexes
  present, columns identical to a fresh migration build, ai_model_registry has the 13 seeded rows. Studio is live for
  eligible businesses. No production migration needed or added.
- Photo framing: hero / photo-and-text / booking-banner photos take `imageFocus` [x,y] and `imageAspect` (validated,
  stored only when changed, rendered as object-position + aspect-ratio crop); composition photos use their existing
  focus/aspect. Editor: click the photo (or arrow keys) for the point to keep, pick a shape.
- Phone-sized photos: each owner photo can have a ≤800 px copy (made in the browser on upload, or "Make phone versions"
  for older photos); content.variants { photoId: smallId } (validated, own photos only); pages use srcset 800w/1600w;
  copies are public only with their photo (usedBy). PoolThru home on throttled 4G: 367 KB, LCP 2.2 s (was ~655 KB/3.6 s).
- Draft checkpoints (server/website-history.js): server copies of the draft in website_generations kind 'checkpoint'
  (no new table): on save at most every 10 min, on publish, before a restore; newest 20 kept per business; restore via
  the History tab (Studio + owner only; the restore itself is undoable). getGeneration ignores designer/checkpoint rows.
- Unused photos: "Remove unused photos" deletes only what nothing recoverable shows (draft, live, saved versions, AI
  undo, checkpoints: read as content, not text search); per business; 120 files incl. phone copies, 50 MB.
- R2: not needed yet. Production has 5 photos / 1.46 MB across 2 businesses (D1, ~10 GB capacity); per-site budget
  50 MB. Revisit at ~2 GB total media or ~40 sites near their budget (needs a bucket binding: approval).
- Tests: unit 487/487, browser 85/85 (photos/framing/history test desktop + phone), PoolThru acceptance 26/26 (local).

## Website Studio completion: direct editing, pages, forms, SEO, media (2026-11-16) — feature/studio-editor; no paid calls

- Editor (src/dashboard/SiteStudio.jsx) for AI-designed sites (Studio access): click anything in the live preview to
  edit that section (headings, text, buttons + destinations, photos + alt, services/prices/descriptions, FAQ, steps,
  highlights, gallery, contact form); section list (move, hide/show, duplicate, remove, add from 10 types); pages (add
  About/Services/one service/Service area/Contact/FAQ/Privacy from the business's own details, menu order, menu name,
  Google title/description, delete); look (background tone, brand colour, 7 approved font pairs, buttons, corners,
  footer); photos (upload ≤10 MB originals, resized in the browser; remove only if nothing recoverable uses it).
  No AI call for any of it. Preview = POST /api/dashboard/website/preview (validated like a save, nothing stored).
- Persistence: debounced autosave, server-confirmed status, retries with backoff, local copy of unsaved edits offered
  after a reload, undo/redo (50 steps), optimistic concurrency (baseUpdatedAt → 409 conflict with "load latest / keep
  mine"; saveDraft { expect }). One editor per draft (the older form is hidden for AI-designed Studio sites).
- Spec: sections `hidden` (left out of the site, dimmed in the editor; the first screen can't be hidden), contact
  `form` none|contact|quote, owner page cap 10 (the AI is still asked for ≤5), 160 KB spec.
- Forms (server/site-form.js, POST /api/site-form/<id>): plain HTML (no script), CSP form-action 'self' + GetShowUps,
  trap field, signed render time (3 s–24 h, HMAC, no storage), rate limits per IP and business, validateLead + createLead
  (the existing leads table, owner notices and follow-up scheduling; no second lead store), 303 back to the page with
  ?sent=1 / ?form=<reason> (result pages not cached).
- SEO: canonical per page, Open Graph + Twitter card with the page's photo, per-site favicon (logo or /site-icon/<id>.svg
  letter mark), LocalBusiness with confirmed hours + FAQPage JSON-LD, sitemap with every published page (+lastmod).
- Media (server/assets.js): 60 photos / 50 MB per website in D1 (2 MB row limit, 10 GB database: 250 MB needs R2 =
  bucket binding, production change with approval); quota error; delete refused while the draft, live site, any
  saved version or an AI undo uses the photo.
- Tests: unit 483/483 (conflicts, preview, hidden, forms incl. bots/expired/forged/cross-business tokens, sitemap, SEO,
  favicon, photo protection/quota, isolation); browser 83/83 (editor desktop + phone, keyboard reachability, two-tab
  conflict; desktop/phone runs use their own seeded businesses). PoolThru acceptance (real content and photos, LOCAL
  server with publishing enabled only there): 22/22 incl. form → lead stored, publish, booking links, second-business
  isolation. Production publishing remains off.

## Website Studio for every eligible business (2026-11-16) — feature/studio-access; no paid calls

- Root cause (PoolThru saw no Claude/OpenAI controls after #43): Studio was an internal pilot behind
  WEBSITE_STUDIO_ENABLED=true AND an explicit WEBSITE_STUDIO_BUSINESSES list; neither is set in production, so every
  Studio route was 404 and the dashboard hid the cards. Not a #43 code defect (the deployed bundle had the UI).
- Now (owner decision): server/website-studio.js studioAccess(env, session.customer): on by default
  (WEBSITE_STUDIO_ENABLED=false = emergency off), business active, hosting status 'active' (paid/trialing/past due or a
  never-billed pilot), and Studio's tables present (0021–0023; hidden, not broken, until applied: deploying needs no
  migration). The allowlist is gone. Session, same-origin, tenant scoping, rate limits and the AI allowance unchanged.
- No silent platform AI: the older writer used to treat a stored key marked invalid (or unreadable) as "no key" and fall
  back to the included GetShowUps-paid model. Now a stored key is used or its problem reported (invalid_key /
  ai_unavailable); the included model runs only when no key is stored (website-ai.js ownCredential, storedCredential).
- Wording: the "N of 400 AI changes left today" line gets a second line: with an own key "a GetShowUps daily safety
  limit, not your Anthropic/OpenAI credit … billed by them"; without one, "the daily limit of the AI writer included with
  GetShowUps". (400 = the testing tier: a platform admin signed in.)
- Business Review: capability website.studio (live / missing until 0021–0023 / disabled, plus the publish switch);
  WEBSITE_STUDIO_PUBLISH recorded on/off in change history. Publishing unchanged: off unless exactly 'true'.
- CI flake fixed (modes.test.js): it booked slots[0], which can start within a second (a slot on the hour booked at
  hh:59:59), then sent messages "1 s later" to an appointment that had started → confirmations correctly skipped. Now the
  first slot ≥10 min ahead (as automation.test.js slotAfter). Reproduced and verified with a shifted clock.

## Website Studio: stable service ids in AI-designed sites (2026-11-16) — PR #43; no paid calls; draft, NOT merged

- Defect (on main since the pilot, found in the release review): the AI design pointed at services by list position, so
  deleting the first service showed "Weekly Pool Care" with the one-time service's description. Now the design refers
  to `content.services[].id` (AI-designed content only; content without an AI design keeps its exact shape).
- Ids: kept if valid and unique; else inherited from the saved service with the same name (`prior`: save route, import
  apply), so a page or import that drops ids keeps descriptions; else a new random id (never a position, never reused).
- Backward compatible, no migration: drafts and versions saved before ids are upgraded at READ time, deterministically
  (s1, s2, … against the same stored list their positions were written for), so they show the right descriptions,
  compare equal draft vs live, and are never rewritten by reading. A pre-id page saving positions is read against the
  saved list. The model still sees positions in FACTS.services (servicesForModel converts at that edge only).
- Other positional references checked: photos (asset/stock ids), links (section ids, page slugs), redirects (paths) are
  already stable. Remaining best effort: an undo stored BEFORE this change resolves positions against today's list.
- Tests: delete first + middle, add, reorder, a page without ids, save + reload, pre-id draft + published version,
  model positions ↔ stored ids, import by name, dangling id dropped. The 3 new tests fail on the old code.

- Cap: actual settled spend in this test + the next request's worst case ≤ $0.50, checked before every request (the
  product's own limit can't express a combined $0.50: $1 minimum, per provider). GPT ran first ($0.057 + $0.059 =
  $0.116, revision included), then Claude ($0.068, no revision needed). Nothing blocked.
- `same_lead` triggered LIVE on GPT: its first answer kept "Less upkeep. More pool time."; the revision request carried
  the note and the saved design has a new headline ("Good days start with water."), lead photo, structure (one wide photo,
  words inside), fonts (Syne/Inter) and palette (graphite/mint); no soft issues left. Claude's answer was different on
  its own (collage, "Charleston pools, kept crystal clear", Syne/Inter, cobalt), so nothing triggered.
- `buried_photo` did NOT trigger live (neither answer layered a card over most of a photo): untested live; covered by the
  unit test built from GPT's earlier live layout.
- Visual inspection found one more renderer defect, fixed + regression test: a solid button in a dark ("ink") section
  took the section's light text colour (`.bg-ink a{color:inherit}` outranks `.btn`), so GPT's mint Book button read
  white-on-mint. Now `.bg-ink .btn:not(.ghost)` keeps the button's own label colour.
- Comparison sheet (full pages, desktop + phone, before/after per provider): scratchpad validation2/final-compare.png.
- Unit 474/474, browser 79/79.

## Website Studio: live re-validation for PR #43 (2026-11-16) — both providers pass; $0.497 spent; draft, NOT merged

- Claude compatibility call (approved, $0.40 cap, enforced in the harness as a worst-case-before-send guard): passed,
  1 request, $0.077. The compact 58-property schema compiles; the composition came back valid with no check issues.
  That call is Claude's turn 1 (same brief), counted inside Claude's $2.50 product limit.
- Three turns per provider (design → different direction → owner change request), approved $5 combined:
  Claude Sonnet 5.5 $0.077 + $0.153 (1 revision) + $0.062 = $0.292; GPT-6.1 Sol $0.051 + $0.095 (1 revision) + $0.059 =
  $0.205. Total $0.497. Every turn produced a valid design; no provider/schema errors.
- Both models now use the composition system: Claude type poster → full-bleed photo with the headline inside; GPT type
  poster with a large mark → three-photo collage with an overlapping headline card. Brand "PoolThru" everywhere.
- Visual inspection found renderer defects (fixed, regression tests): a full-width photo under words kept its 21:9
  proportion as a grid item (grew past the page edge as type grew; sat inside the margins on a dark band) → now a
  backdrop (design-blocks.js compositionRoles) that fills the section/content area; a photo beside a stack spread its
  extra height between rows (button far below its text) → two flexible spacer rows centre the stack; on phones photo
  boxes took their width from their height and overflowed the screen (GPT's page measured 10,003px, now 5,342px) →
  width:100%; footer "PoolThru: pool cleaning…" lost the brand but started lower-case, and "PoolThru. Pool care…"
  repeated it → fixed. The balance estimator follows the same roles; a ragged text stack is no longer a "hole".
- New soft checks (one revision): `buried_photo` (a photo mostly hidden under a layered card — GPT's revision left a
  sliver) and `same_lead` ("different" kept the previous headline or lead photo — GPT kept "Less upkeep. More pool time."
  and the hat photo). Both were applied to the saved live outputs offline, not yet with a live call.
- Remaining weaknesses: GPT leads with the same owner photo it likes best; below-the-fold sections are still mostly
  preset patterns (services rows, steps, area chips, CTA band); the collage's paragraph and button sit below a 900px
  desktop first screen (the nav Book stays visible); the poster's large top padding.
- Unit 473/473, browser 79/79, lint/build/Functions clean. Next: owner review of the screenshots; optional one more paid
  "different direction" turn per provider to see `same_lead`/`buried_photo` trigger their revision live.

## Website Studio: design quality pass for PR #43 (2026-11-16) — paid re-validation BLOCKED (Keychain), $0 spent

- Root cause of generic AI first screens: the prompt described composition options abstractly and nothing pushed back
  on the safe split. Now: four FIRST-SCREEN RECIPES in the exact token form (server/design-blocks.js RECIPES: editorial
  overlap, immersive full-bleed, type poster, collage; each validated + rendered by test/design-recipes.test.js and
  inspected visually with PoolThru's photos), craft rules (alignment, rows ending together, photo choice, a different
  direction leads with a different photo), and a soft check `conventional_first_screen` (new designs only, never owner
  revisions) that asks for the one revision.
- Balance check (server/design-checks.js layoutComposition/compositionBalance): estimated desktop layout → mostly_empty,
  empty_band (≥3 columns), misaligned (stacked edges off by one column; layered cards exempt). Showcases pass; the live
  GPT signature section is flagged. Soft → one revision.
- Brand: AI-designed sites show displayBrand() (legal suffix removed, the owner's own spelling from their reviewed text:
  "PoolThru"); footer names it once. Legacy renderers unchanged.
- Claude compatibility call (approved, $0.40 cap) NOT made: reading the key from Keychain timed out twice (an access
  prompt on the Mac waiting for Allow). No request sent. Next: owner clicks Allow, then the compatibility call, then
  the three-turn validation for both providers.
- Unit 470/470, browser 79/79.

- Claude Sonnet 5.5: STOPPED at turn 1. Anthropic refused the schema ("compiled grammar is too large"; $0, request
  req_011Ch64roW2E444i4ZRqLVbx). Fixed: Claude's compact schema is back to main's 58 properties (the size that compiled
  live): composition blocks ride in `items` (title = kind + place/look tokens), the design idea in `name`. NOT re-verified
  live (stop rule); needs one approved Claude call before merge.
- GPT-6.1 Sol: 3/3 turns ok, no revisions, $0.0437 + $0.0466 + $0.0568 = $0.147. Found and fixed: "size display" tokens
  reported invalid (now accepted); a 184-char design idea was dropped (now shortened); the "different" design was the
  first one mirrored with a serif (check now compares first-screen structure, so it would get the one revision).
- Visual verdict: clean, legible, booking prominent on phones, but generic: all three first screens are photo + headline
  side by side; the model used none of the overlap/scale/mark/treatment controls; below the fold is presets; the brand
  shows as "Poolthru LLC" (record name), footer repeats it. Not "professionally art-directed" yet.
- Centered nav fixed (logo centred, Book right, links below; phones: logo left, Book right) + regression test.
- Unit 466/466, browser 79/79. Next: owner review; prompt work for bolder compositions needs another paid run.

## Website Studio: composition section + design quality (2026-11-16) — draft PR, NOT merged; no paid calls

- PR #42 (hero/nav/phone headlines) merged and deployed (f8239b2, 05:02 UTC): PoolThru's live page hash unchanged,
  booking 160 slots.
- New: `composition` section type in v2 (server/site-spec.js + site-render-v2.js, string renderer kept): ≤10 blocks on a
  12-column grid; phone layout derived; readable overlaps; CSS from validated values only, sent only when used.
- Generic fallbacks: invalid choices and empty blocks are reported; server/design-checks.js decides (hard → one revision
  → error `ai_design_incomplete`, nothing saved; soft → one revision → saved). Raw answers redacted, kept 30 days.
- Art direction (`direction`), prompt guidance for compositions and phone order, "Show me a different direction".
- Fixes: CTA card on an accent background now readable; nav Book button ≥44px.
- Evidence: three directions with identical PoolThru info + photos (test/fixtures/design-directions.js) differ on
  desktop and phone, incl. as neutral wireframes; responsive checks pass at 320/390/768/1024/1440; saved AI designs
  render with identical page bodies (CSS: only the two fixes). Bundle +25 KB (+1.1%).
- Found by the browser test: the Claude path converted twice and dropped composition buttons silently; fixed
  (idempotent parsing, empty blocks reported) with a regression test.
- Unit 463/463, browser 79/79. Next: paid validation (approval) — Anthropic grammar size + real AI compositions.

## AI-designed sites: hero height, nav and phone headline fixes (2026-11-16) — draft, NOT merged

- Production pilot design (GPT-6.1 Sol): hero 1,054px tall on a 900px screen, 353px empty above the copy, headline at
  y=462. Cause: the hero's inner container inherited the section's min-height, so section padding was added on top,
  and "tall" ignored the nav. Fixed: one flex box, height measured below the 72px nav (svh), padding capped. Now 693px,
  headline at y=281. Phones unchanged (content-sized).
- One-page sites put the nav's Book button next to the logo (no links to push it). Fixed.
- Large type scales or wide display fonts ran headlines off a 390px screen (preferred fluid size ≈120px). Both ends of
  the fluid size are now capped by viewport width; overlong words may wrap. Desktop sizes unchanged.
- Diagnosis of "generic designs" and the architecture proposal: in the owner report (awaiting approval).

## Website Studio release candidate (2026-11-16) — `release/website-studio` (= #37–#40 + below), draft, NOT merged

- Production verified READ-ONLY (schema names from sqlite_master, no rows): every table/index/trigger of migrations
  0001–0020 exists (incl. both audit_log triggers); nothing outside the migrations; 0021–0023 absent. Production code:
  main e3af1fc, Pages deployment 1aff1e8f (from build.json + the commit's Pages check).
- No server-side fallback for own-key requests (owner decision): only the chosen/reserved model runs; usage is recorded
  and priced as that model even if a response names another. Regression test (one request, no `fallbacks`, no fallback
  beta header, Sonnet prices on an "Opus" response, refusal not re-run). Ads strategy (GetShowUps' key) unchanged.
- Internal pilot gate: WEBSITE_STUDIO_ENABLED + WEBSITE_STUDIO_BUSINESSES (server/website-studio.js). Tests: switch,
  routes 404, no key use, no hand-crafted site/redirects, published sites keep serving; browser: non-pilot sees nothing.
- Restore of an earlier AI-designed version (pages + booking links, live + draft): regression test.
- Rollback measured with production code on Claude's real PoolThru design: renders the older template from the same
  content (imported headline; booking link intact); extra pages (/p/<id>/services) show the GetShowUps marketing page
  (production's fallback, checked read-only); a dashboard save during rollback drops `site` and `redirects`.
- One merge = one deploy: merging #37–#40 one by one would put three ungated intermediate states in production.
- Unit 447/447, browser 79/79. Local journey re-run on the candidate (PoolThru in the local pilot): all steps pass.
- Preflight (read-only, 2026-11-16): `poolthru-llc` = PoolThru (real, not test-marked; its one owner account is NOT the
  GetShowUps owner's); `gsu-stripe-test-pools` = internal test business (test-marked, owned by the GetShowUps owner).
  PoolThru's live website (v5, not AI) renders byte-identically with production code and this candidate (our address and
  own domain); no booking/Ads/cron/messaging/billing/auth/domain code changes. D1 Time Travel bookmark recorded; production
  deployment 1aff1e8f confirmed via `wrangler pages deployment list`.
- WEBSITE_STUDIO_PUBLISH (off by default): AI-designed sites and Studio redirects can't be published or restored during
  the pilot (409 studio_publish_off; dashboard explains it; drafts and previews work). Unit + browser tests. 448/448, 79/79.

## Website Studio customer-journey validation (2026-11-16) — #38 → #40, draft, NOT merged; no paid calls

- Walked the whole PoolThru journey in a real browser, UI only, on a local build (throwaway DB; local stand-ins for
  Google sign-in/Calendar and for Claude, which replays Claude Sonnet 5.5's real saved PoolThru designs): sign in →
  Website → connect key → design → desktop/phone preview → revision → publish (local /p/poolthru-llc) → a customer books
  from the site's "Book a visit" on a phone → the owner sees it under Appointments. All steps work after the fixes.
- Found and fixed:
  - Auto dead end (#38, migration 0022 seed, unapplied): no model was 'tested', so a new owner's first request on the
    default Auto was refused. claude-sonnet-5-5 and gpt-6.1-sol (verified live 2026-11-15) are now 'tested'.
  - Data loss: the older "Create with AI" tools (Describe a change / three new designs / standard designs) build drafts
    without the AI design; keeping one silently dropped it. Hidden for AI-designed drafts, and the server refuses such an
    apply (409 designed_site, e.g. from an old tab). Regression test.
  - Dead controls on AI-designed drafts: style, colours, logo and Google fields saved but changed nothing. Hidden, with
    a note on what the remaining fields do (services/prices show directly; the rest is what the designer writes from).
  - The applied import kept its full review ("Use this in my draft") → one-line summary with "Review again".
  - Duplicate key panel ("Your own AI key") removed: the designer card holds key, model and limit.
  - Two identical "Publish website" buttons while confirming → one, plus "Not yet". Designer chips were Title Cased.
- Website tab after a design: 3,802 px (was 5,737). Unit 444/444, browser 79/79 (designer + import specs updated).
- Not changed (noted): the older "N of 40 AI changes left today" allowance also counts designer turns but is now only
  shown before an AI design; business name shows as "Poolthru LLC" (owner can rename in Settings).

## Live A/B test diagnosis (2026-11-15) — #38 → #40, draft, NOT merged; no paid calls since

- Test run (approved): Claude Sonnet 5.5 → HTTP 400, 0 tokens; GPT-6.1 Sol → HTTP 429 insufficient_quota /
  credit_balance_exhausted ("no credits remaining"), 0 tokens. $0 charged. No designs, so no revisions. Keys deleted.
- Claude root cause (ours): the designer's strict schema had 29 union-typed (nullable) parameters; Anthropic's
  structured outputs allow 16 and return 400 "Schema is too complex for compilation". Not billing (Anthropic billing is
  402 billing_error). The provider's message was not captured on that call; the cause is established from the schema
  and the documented limit. Fixed: no unions ("not used" = ""/[]/-1/0/empty button, mapped back by fromStrict before
  validateSpec, proven equivalent by test). Regression test for both schemas (test/schema-limits.js).
- OpenAI root cause (account): no API credit. Our bug: only code === 'insufficient_quota' counted as billing, so it was
  shown as a rate limit. Fixed: openAiError/claudeError → provider_billing (402, released, not retried); provider
  status/type/code kept on events/logs (identifiers only).
- Next: fund the OpenAI API account; re-run the same approved test (approval needed).
- Second live run (keys recovered into Keychain, read with --keychain): Claude 400 "The compiled grammar is too large …
  Simplify your tool schemas" (req_011Ch5gsxM43xB4hLPaicRSF) — so removing unions was necessary but not sufficient.
  OpenAI 429 credit_balance_exhausted again (the key's organization has no credit). $0, 0 tokens.
- Fix A (owner-approved): choices are described strings, not enums (18 enums → 1: section type). validateSpec already
  enforces every list with a safe default (test). Grammar size can't be measured locally; needs a live call to confirm.
- Third live run: GPT-6.1 Sol design + revision succeeded (7,781 in / 5,993 out tokens, ≈$0.0755; nothing removed by
  validation). Claude still 400 "compiled grammar is too large" (req_011Ch5hhHLNWBx7VbHCWkrxZ).
- Option B (owner-approved): Claude gets a compact section shape (13 fields instead of 28; 58 properties instead of
  79): style/option tokens, one image list, one button list, FAQ via title/text. fromCompact() → standard shape →
  unchanged validateSpec; toCompact() for revisions. Round-trip test: every section type and control comes back
  identical. OpenAI keeps the standard schema.
- Renderer: wide sections now share the header/footer content edge (were 160px wider → 20px vs 80px at 1440).
  Measured in Chrome: 80px = header at 1440; mobile unchanged (20px), no horizontal overflow.
- Fourth live run (Option B, Claude only, approved): Claude Sonnet 5.5 design + revision both succeeded. Design 6,060 in /
  5,345 out ≈ $0.0656 (validation removed one too-long SEO description); revision 9,896 in / 3,536 out ≈ $0.0552 (nothing
  removed). Total ≈ $0.121 (our estimate from list prices). Booking link in the first screen of every page, desktop and
  phone. Artifacts and the side-by-side comparison with GPT are local only (scratchpad demo-live4).
- Renderer: full-width sections had NO gutter (text at 0px; header at 120px desktop / 20px phone), found on Claude's
  full-width overlay hero; every section type had it. Fixed: `.w-full .wrap` padding = the container edge, min 20px.
  Backgrounds and overlay photos stay edge to edge. Measured in Chrome at 1440/1024/390, all 6 hero layouts and every
  section type: text at 120/20/20 = header; no overflow. Regression test.
- e2e automation.spec "can't make it … picks a new time" (was failing in the evening): test-fixture race, not a product
  bug. The booking page lists one day at a time; from 20:00 to 21:00 New York (01:00–02:00 UTC in winter) only one slot is
  left today, so this test's "last slot" and the parallel resume test's "first slot" (same business) were the same slot
  and the double-booking guard rightly refused one ("That time was just taken"). Failures were at 01:12–01:14 UTC. Fixed
  in the test: book on the last offered day. Product unchanged.

## Website Studio: own-key models discovered per account, Auto, hard limit (2026-11-15) — #38 → #39 → #40, draft, NOT merged

- Both providers end to end, tested with mocks: connect key → model list from the customer's account → design → revision
  → publish (Claude streaming + OpenAI strict json_schema). No real provider call made yet.
- Models: discovered with the customer's key (free `GET /v1/models`); Anthropic filtered by
  `capabilities.structured_outputs`, OpenAI by text-model family rules (no audio/image/embedding/realtime/dated snapshots).
  Catalog stored per key, refreshed when older than a day or on "Check for new models". `ai_model_registry` (0022, editable
  without deploying) holds verified prices (2026-11-15), quality rank, status tested/supported/blocked and the model's own
  output ceiling. Unpriced new models are shown but not selectable (spend must be boundable).
- Selection kept; a model the account stops offering is reported and refused, never swapped. Auto (default) uses only
  `tested` models, best quality within the limit, never moves to a more expensive model. **No model is `tested` yet**:
  until the approved real demo marks some, owners pick a model by hand.
- Hard monthly limit per key (default $10, owner $1–$1,000): month-to-date spend from `ai_key_usage` (every own-key call,
  failed ones too; tokens only) + this request's worst case (measured prompt, the output cap actually sent) must fit, else
  refused before sending. SDK retries off for own-key calls.
- Fixed: GPT-4o / GPT-4o mini output ceiling 16,384 (asking for more would have been a 400).
- Next: approval for the real two-provider PoolThru demo (estimate in the PR thread / summary), then mark the demoed
  models `tested` in the registry.

## Integration checkpoint (2026-11-14) — PRs #24–#28, all draft, CI green, NOT merged or deployed

**Verified now:** production deployment 0020f305 (main d426fef); production has migrations through 0014 (0015–0017
absent). PR heads: #24 66a1c5c, #25 1447980, #26 8d23a95, #27 3becc96, #28 ab27c29: `verify` and Cloudflare Pages
checks pass on each; no failures. Local on #28: 375 unit, 72 Playwright, lint, build, Functions compile.

**business-review.patch (other agent):** not the source of #28 (both built independently; patch based on d426fef).
Four ideas adopted in commit ab27c29: (1) health as a separate axis + 4 s check timeout (server/ops/review.js,
src/admin/Review.jsx); (2) payment-recovery email, one per invoice per owner via the outbox/launch gate
(server/billing-recovery.js, server/stripe.js); (3) per-capability event drill-down (functions/api/platform/audit.js
`?capability=`, Review.jsx); (4) docs/DATA_REQUESTS.md note pointing business deletion at the workflow. Everything
else in the patch duplicated existing systems or contradicted owner decisions and was not merged. A scan of #28 finds
the patch's tables/modules (audit_events, lifecycle_states, deletion_requests, shutdownAdvertising, 0015_operations_core)
only in docs/OPERATIONS.md §7. One module per system (see CLAUDE.md "Release state").

**Migrations:** 0001–0017 unique and ordered. 0015–0017 applied twice to an exported copy of the production schema
(schema only, read-only export): idempotent, integrity ok, 0 FK violations, audit_log UPDATE/DELETE blocked, no name
clashes. Still to verify in production after applying: the two audit_log triggers exist and refuse a change.

**Scalability (measured at 10/100/1,000 synthetic businesses):** admin list 2 D1 + 1 KV, Business Review 92 + 3,
one business 43 + 2 (all independent of size after fixes; before: 472/918/513 queries and 1,000 KV reads each).
Fairness fixes for the ads hold sweep and recovery expiry; cron batches 25 recovery / 2 deletions per run.

**Release order (approval required for every step):** #24 → apply 0015 → #25 → apply 0016 → #26 → #27 → apply 0017 →
#28, then read-only checks (docs/OPERATIONS.md §3). Ship as a set (the scalability fixes live in #28).
**Rollback:** Cloudflare Pages → Rollback to 0020f305 (or `git revert -m 1` per merge); never drop the new tables or
edit audit_log; switches off stops new work (deletion has no undo).

**Decisions open (owner):** retention policy and deleting the Stripe customer (docs/DATA_RETENTION.md); retention
schedule after day 90 (until then canceled accounts' data is kept indefinitely); enabling ACCOUNT_DELETION_ENABLED;
privacy/FAQ wording; Google confirmation of the automatic pause (safety stop) before real spend; whether /admin should
open on Business Review; optional off-Cloudflare anchoring of the audit head hash.
**External blockers:** Google Ads API access (Cloud project at Test level), Google OAuth verification (sensitive scopes,
under review), Twilio account + A2P 10DLC for texts, live Stripe keys/price/webhook (and STRIPE_LIVE_ENABLED approval),
MESSAGES_LIVE approval, Cloudflare API token for own domains, Workers AI binding approval.
**Production verification after release:** /admin/review loads and shows "Migrations: 17 of 17 applied", audit log
intact, a reconciliation result (Stripe test mode, read-only), daily checkpoint appears within 24 h; PoolThru page and
booking smoke as in the last release; no business with "Ads still running while on hold".
**Not built (next, after release):** one-person data erasure (lead asks to be forgotten; manual today), incident
acknowledgement/notifications in Business Review, first real conversation provider, splitting the cron if busy runs
approach the D1 query limit, batching audit writes at high volume.

## Business Review + review fixes to #24–#27 (2026-11-14) — branch feature/business-review (stacked on #27), NOT deployed

Review fixes pushed to each PR: #24 no budget increases on hold, disconnect-on-hold must pause first, unreachable
(orphaned) campaigns escalated + cleared only by audited confirmation; #25 standard events (capability, resource,
outcome, correlation id; free text fingerprinted; docs/AUDIT.md limits); #26 unpublish at lockout, unreachable ads block
deletion until confirmed, stuck escalation, staff-log free text erased; #27 day 90 records expiry only, separate
retention schedule switch, retention policy rewritten (draft), webhook idempotency test.
Business Review (/admin/review): capability registry + catalog (server/ops), generic engine (statuses from config +
production evidence, dependencies, open failures, incidents, approvals, change history from dist/build.json + cron),
Platform and Business views. Conversation providers extension point + control lock (migration 0017). docs/OPERATIONS.md.
Tests: 369 unit, 72 Playwright (incl. a never-seen capability rendering from data alone; 320/390 px no overflow).

## Lifecycle, 90-day recovery, billing reconciliation (2026-11-14) — branch feature/lifecycle-reconcile (stacked on #26), NOT deployed

server/lifecycle.js (stage view; admin "Lifecycle" card), 90-day recovery for canceled billed accounts (owner Billing card
shows the date; admin attention recovery_ending/ended; after it the cron starts deletion only when deletion is enabled;
never pilots/test businesses). server/reconcile.js: Stripe ↔ records daily + on demand, read-only, all difference types,
audited runs, admin resync (audited; live mode refused). No migration. Tests: 354 unit, 70 Playwright. In production the
daily reconciliation would read Stripe test mode (2 subscriptions) once deployed.

## Account deletion workflow (2026-11-14) — branch feature/account-deletion (stacked on #25), NOT deployed, OFF

Owner policy 2026-11-14: permanent, no undo window, no founder approval; durable/retryable/audited; retained records
documented (docs/DATA_RETENTION.md, DRAFT for approval). Migration 0016 `account_deletions`. server/deletion.js steps:
lockout → ads (pause + read back) → billing (Stripe canceled now + confirmed, customer deleted) → integrations → data →
verify; cron retries with backoff; admin status + retry; deleted ids never reused, left out of metrics ("Deleted
accounts" in /admin). Owner UI: Settings → Delete account (typed business name). Gate: ACCOUNT_DELETION_ENABLED
(unset in production; set only in the local e2e server). Guard test: every table with a customer column is erased or
documented as retained. Revoke now goes through googleApi() (mockable in e2e; production URL unchanged).
Tests: 349 unit, 70 Playwright (owner deletes in the browser; admin sees the record). Found + fixed in e2e: the admin
detail crashed for deleted rows (missing createdVia).
Next: 90-day cancellation recovery → Stripe ↔ records reconciliation.

## Permanent audit log (2026-11-14) — branch feature/audit-log (stacked on #24), NOT deployed

Migration 0015 `audit_log` (CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS only; the release test now exempts exactly the
pure `BEFORE UPDATE|DELETE … RAISE(ABORT)` guard triggers). Hash chain + append-only triggers; no personal data
(emails → refs). Producers: admin audit(), ad state changes, Stripe billing (status, cancellation scheduled/withdrawn,
payment failed/succeeded), website publish/unpublish/restore. Cron: daily chain verification checkpoint. Admin: Audit
log card (chain status, newest entries, JSON export); customer detail reads audit_log (falls back before 0015).
Apply 0015 before deploying (until then appendAudit logs `table_missing` and the action proceeds).

## Ads safety stop (2026-11-14) — branch feature/ads-billing-hold, NOT deployed

Defect: running campaigns kept running after a failed payment, an ended subscription, or an admin suspension (only
launch/resume checked billing). Fix (owner decision 2026-11-14): server/ads/holds.js derives a hold from records and
pauses every running campaign on its platform, then reads it back from Google; launch/Start refused (`ads_on_hold`).
Triggers: Stripe webhook (waitUntil after the receipt), admin suspend (inline; counts in audit + admin UI), cron sweep
every 5 min (retries). Billing holds only for billed businesses (PoolThru exempt). No migration. Tests: 333 unit
(+7), 69 Playwright (+1: admin suspension pauses a running test-account campaign; owner notice; Start refused;
reactivation restarts nothing). All Google calls mocked; no production Ads change. Compliance doc: open item 4 (confirm
the pause-only safety stop with Google before real spend).
Next: permanent audit log → deletion workflow (gated) → 90-day cancellation recovery → reconciliation → admin views.

## Released 2026-11-14: PRs #17, #18, #19 (merge commits 90e9057, be8224a, feb34f1)

Production deployment **14afca51** (feb34f1); intermediate a5b3c698 (#17), e5f794a1 (#18). Rollback target:
f0e4ebad (dcc15f1) via Cloudflare dashboard → Deployments → Rollback, or `git revert -m 1` of the three merges.
Before: combined suite 317/317 unit, 68/68 Playwright; main tree identical to the tested merge. After (read-only
production smoke): cancelled sign-in from /admin → /admin, from /dashboard/ads → /dashboard, external `next` → /dashboard;
/api/platform/me and /api/dashboard/me 401 signed out; PoolThru booking API 200 (160 slots, at_customer); homepage
sections incl. simulation, controls, labels, no unsupported live claims, honest meta; /admin shows the login error;
deployed admin code renders test-mode billing as "Test mode (no revenue)". Secret names unchanged; migration 0013 NOT
applied; no live billing, messaging or ads switched on. Not verified live: the signed-in admin metrics view (needs the
founder's Google sign-in).

## Launch readiness audit (2026-11-14) — branch feature/launch-readiness, NOT deployed

Production = `main` dcc15f1. Open PRs: #17 (sign-in routing, CI green, reviewed safe to merge), #16 (journey runner).
Read-only production checks only (business ids, email domains, counts, key presence; no customer data printed).

**Accounts and tenants (verified from production records):**

| Identity / tenant | Intended role | Actual today |
| --- | --- | --- |
| Developer account (Flora Summit domain) | GitHub, Claude Code, infrastructure only | Also the only member of the test business `gsu-stripe-test-pools`. No code dependency (only the GitHub repo name). |
| Founder account (getshowups.com) | Platform admin (`PLATFORM_ADMIN_EMAILS`) | Admin; member of no business. Also the Google account behind the test business's Calendar and Ads connections (chosen on Google's screen during the OAuth video). |
| `poolthru-llc` | First real tenant | Owner on the poolthru.com domain; not test-marked; on-site (`at_customer`); Calendar + Google Ads connected; 1 paused + 4 removed campaigns; never billed (a stale `incomplete` placeholder row from 2026-11-10, no Stripe subscription). |
| `gsu-stripe-test-pools` | Test tenant | Test-marked; Calendar + Ads connected; 1 paused test-account campaign; Stripe test subscription. |
| `toys-for-us` | ? | Self-serve, gmail.com owner, **not** test-marked, Stripe test-mode "active" subscription, Calendar connected. Owner to confirm whether it is a test (then mark it as test in /admin). |

**Developer account off the test tenant (safest path, needs approval):** keep the business and its history; owner
picks a dedicated demo Google identity (not the founder or developer account); admin invites it to
`gsu-stripe-test-pools` from /admin (existing audited invite-to-existing-business); after it signs in, remove the
developer membership with one approved D1 statement (no remove-member feature exists; deliberately not built). Calendar
and Ads connections stay as they are (they belong to the business, not the member) until the owner chooses to reconnect.

**Fixed on this branch:** platform metrics no longer report Stripe test-mode subscriptions as revenue. Until
`STRIPE_LIVE_ENABLED=true` every subscription is test mode (the webhook refuses live events), so MRR/ARR/paying/revenue/
churn are null with `billing.mode: 'test'` and a test-subscription count; the console says "Test mode (no revenue)".
Live/test is now recorded per subscription and payment (branch feature/billing-livemode, stacked on this one: migration
0013 `subscription_modes`, new table only; webhook stores `event.livemode`; live revenue counts live-marked records only;
missing table → webhooks still succeed, nothing counts). Apply 0013 on production (approval) before STRIPE_LIVE_ENABLED.
The main metrics row shows job completion instead of the always-empty show-up rate when only on-site data exists.

**Verified already implemented (no change needed):** on-site outcomes (visit happened, job completed, self-reported
value), paused-only campaign creation + read-back + budget ceiling + no automatic increases, idempotent checkout (no
duplicate subscriptions), pilots never billed, messages gated to test recipients unless `MESSAGES_LIVE`, scopes match
the OAuth submission (docs/GOOGLE_OAUTH_VERIFICATION.md).

**Readiness:** sign-in/admin routing — ready after PR #17 deploy; self-serve signup + Stripe — ready in test mode,
live billing blocked on approval; Calendar booking — live for PoolThru; on-site outcomes — ready; Google Ads — sandbox
only (Explorer access; live launch switch off; PoolThru live ads would also need a billing decision); messaging — test
recipients only (MESSAGES_LIVE off; SMS not configured); founder console — ready for a pilot (metrics now honest).

**Next actions:** approve PR #17 merge/deploy; this branch's PR; decide toys-for-us test mark; pick demo identity for
the test tenant; live billing plan (livemode column first); wait for Google OAuth verification.

## Current state (2026-11-08)

- Marketing site live at getshowups.com; Book a Demo embeds Google Calendar appointment schedule.
- Google Calendar OAuth onboarding live: single-use invites (D1), encrypted refresh tokens (KV).
- Customer **poolthru** connected; production health check `GET /api/admin/google-health?customer=poolthru`
  returned `healthy` (token refresh 200, freeBusy 200) on 2026-11-08 at deploy e780355.
- Development accelerator: `npm run verify`, `npm run verify:all`, GitHub Actions CI, Playwright smoke tests.
- Launch release incl. admin console, invitations, billing prep, analytics: **built and tested locally, not deployed**.

## In progress

## Product roadmap (source of truth; set 2026-11-10)

One product: Advertising → Website → Lead → (optional) Qualification → Booking → Confirmation → Reminders →
Show-up → Reporting. $499/month founding plan; ad spend separate; no guaranteed results. Priorities: real paying
customer first, then a complete simple experience, automation, low cost, reliability. Milestones in order (each:
inspect, build only what's missing, test, safe preview, report blockers, stop for approvals):

- **A. AI website generation**: built on branch release/ai-websites (see below). Needs: AI binding approval + deploy.
- **B. Live Stripe payments and the full paying-customer journey**: code exists (sandbox verified). Needs: live keys,
  live price, STRIPE_LIVE_ENABLED, one real payment test (approval).
- **C. Lead capture, optional qualification, follow-up**: booking, outcomes and email automation exist
  (MESSAGES_LIVE off). To do: direct vs qualify vs route-to-human setting and an industry playbook (PoolThru first).
  Evaluate GHL conversations before any custom messaging. SMS needs A2P registration. Rescheduling/cancel links and
  missed-call follow-up (telephony) are still missing.
- **D. Google Ads**: OAuth, accounts, plan drafts, budget approval, paused-campaign creation, optimizer and
  attribution exist behind ADS_ENABLED / ADS_LIVE_LAUNCH. Needs: Explorer/Basic access on the Google Cloud project (developer
  tokens were sunset 2026-09-09), OAuth verification for the adwords scope, a real test account; then spend → leads → bookings → show-ups reporting.
- Onboarding target: sign up/pay → confirm details → keep or generate website → calendar → (optional) Google Ads →
  direct booking or qualification → review. Dashboard answers leads, booked, showed, spend, attention.




### Milestone B: Stripe sandbox journey COMPLETE (2026-11-11, production, Stripe TEST mode)
- Real run on production with an isolated test business (gsu-stripe-test-pools, owner@example.com (test owner)):
  Get started → Google sign-in → business name → $499/month Stripe test Checkout (abandoned → same session
  resumed; owner entered test cards) → signed webhooks (checkout.session.completed, customer.subscription.created,
  invoice.paid; each once) → subscription active → details/services/calendar/hours/website → onboarding complete
  → dashboard → portal cancellation (customer.subscription.updated → cancel at period end, access until Dec 11).
- Verified: paid steps locked before payment; second checkout refused (409 use_portal); webhook idempotency;
  tenant isolation from PoolThru; PoolThru billing exemption and data unchanged. STRIPE_LIVE_ENABLED off.
- Email: 4 automated emails delivered to the test recipient's Inbox via Resend (MESSAGES_LIVE still off).
- Cleanup: test website unpublished (was published during onboarding); test business calendar record deleted
  (it had connected PoolThru's Google account (owner@poolthru.example); the shared Google grant was NOT revoked; PoolThru's record unchanged).
  The test business remains (active test subscription, ends Dec 11); reconnect only to a separate test calendar.
- Fix LIVE (99be975, deployment 72b6fb33): public booking now requires an active plan (same rule as the public
  website: pilots exempt, paid/past_due yes, canceled within the 14-day grace, unpaid never).
- Remaining before live billing (owner): Stripe live activation; live $499/month Price; live webhook (6 events:
  checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid, invoice.payment_failed)
  + customer portal; live STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET set by the owner; then (approval)
  STRIPE_LIVE_ENABLED=true + founding plan price update + one real payment and refund. Google OAuth consent
  screen "In production" (status unconfirmed; console needs the owner's password). A declined test card was not
  observable server-side (declines create no records by design).

### Google Ads sandbox (2026-11-11): built on feature/ads-overview, NOT deployed (needs approval)
- Test-account guard: without ADS_LIVE_LAUNCH, create (paused), resume and budget changes only on an account
  Google reports as a test account (customer.test_account, re-read before each change; unknown → refused).
  Pausing never blocked. Read-only GET /api/ads/google/campaigns (status, budget, 30-day metrics). Owner budget
  changes within the approved ceiling. Test-account data labelled on the Ads screen and Overview.
- **Verified against Google's real API (2026-11-12, local run, test accounts only)**: Cloud project 380394286094
  (Test access; production OAuth client's project, confirmed from the public client id), separate local Desktop OAuth
  client in that project, no developer token. Test manager 554-785-3090 and test client 642-666-3252 (under it):
  customer.test_account = true for both; status CLOSED, which Google documents as normal for test accounts.
  The app's real adapter (server/ads/google.js), 12/12 PASS: test-account guard, geoTargetConstants:suggest (ZIPs),
  create PAUSED Search campaign in one atomic mutate, read back (direct GAQL + app searchStream), relaunch returns the
  existing campaign (no duplicate), enable, pause, daily budget $10 → $15, final state PAUSED. Test campaign
  24455347866 "GSU lifecycle TEST [gsu:lcmwe636hv]" left PAUSED in the test client (test accounts never serve/charge).
  Not live-verified: daily metrics (test accounts have none), production OAuth client + deployed callback, real accounts.
- 2026-11-11: Google sunset developer tokens on 2026-09-09 (access is per Cloud project; the header is ignored
  now and will be rejected in a future version). We no longer send it. The GOOGLE_ADS_DEVELOPER_TOKEN secret
  stored in production on 2026-11-11 is unused and can be deleted later (with approval).
- Per-business flag (2026-11-12): Ads needs ADS_ENABLED=true AND the business id in ADS_BUSINESSES (no wildcard;
  unset = nobody). Applies to every Ads route, both OAuth callbacks, me.features.ads, Overview and onboarding
  readiness. Cron metrics sync / optimizer still act on already-launched campaigns (read + pause only).
- Sandbox UI (2026-11-12, not deployed): the Ads page follows Your business → Connect your ad account → Review your
  campaign → Approve your monthly ad budget → Launch (approve → create paused → start). Accounts are found
  automatically (listAccessibleCustomers + customer_client hierarchy of each accessible manager, managers left out);
  the owner clicks one; the server works out the manager path (login-customer-id) and never sends manager ids to the
  browser. One choosable account → auto-selected in the callback. Without ADS_LIVE_LAUNCH only accounts Google flags
  as test accounts are offered or accepted (others counted, not shown; POST 409 test_account_required). Created
  campaigns get a daily-budget control and "Check on Google" (live status + budget read-back). Images moved under
  "More options"; the Meta row is hidden until Meta is configured. Browser test covers connect → choose → approve →
  create paused → start → pause → budget → read-back against a stateful MOCK Google Ads stand-in.
- Deployed 2026-11-13 (approved): main fast-forwarded 99be975 → 4355bb5 (Pages deployment a2a02e07). Backup
  ~/getshowups-backups/prod-20261113T011808Z-pre-ads-sandbox.sql (restore-tested, 44 tables). ADS_ENABLED=true and
  ADS_BUSINESSES=gsu-stripe-test-pools set before the push (verified the old deployment stayed 404). ADS_LIVE_LAUNCH,
  STRIPE_LIVE_ENABLED, MESSAGES_LIVE unset. Smoke checks passed; PoolThru rows identical across 40 tables. No migrations.
  Rollback: delete ADS_ENABLED + redeploy, or roll back to deployment 72b6fb33 (99be975).
- Sandbox polish (branch feature/ads-sandbox-polish, NOT deployed): Google/Meta sign-in now returns to the Ads tab with a
  visible result (connected, cancelled, timed out, access not granted, production account refused, …) instead of the
  Overview with nothing shown; "Testing mode" note (test accounts only, nothing charged); account-list errors get Try
  again; reconnect/error texts no longer mention typing account or manager IDs. Browser test now also covers a
  production-only Google sign-in (refused, clear message, recover by reconnecting), server refusal of non-test /
  manager / production / unknown account ids, duplicate create prevention, cross-business isolation, 360px width.
  Real-API check of the discovery code against the sandbox is pending an owner sign-in (read-only script prepared).
- Test-business isolation: DEPLOYED 2026-11-13 (8ac2392, deployment 482358a5; migration 0012 applied before deploy,
  integrity ok, PoolThru identical). gsu-stripe-test-pools NOT yet marked (needs the admin signed in to /admin).
- Sign-in routing fix (2026-11-14, PR #17, NOT deployed): admins were sent to /dashboard customer onboarding unless
  they started at /admin; errors and deep links lost their destination. Now: admin-only → /admin from anywhere,
  /dashboard shows an admin notice, errors return to the starting area, dashboard deep links survive, "No platform
  access" links to the dashboard. Allowlisted destinations only.
- Ads review UX: DEPLOYED 2026-11-13 (dcc15f1, deployment f0e4ebad): one owner step "Approve and create (paused)" when the account
  is connected (Start stays separate); "Where: people in ZIP …"; every result tile says where its number comes from.
- Google Ads conversion feedback: DEPLOYED OFF 2026-11-13 (9565e99, deployment 6281da42): conversion actions via the
  Google Ads API at campaign creation; Data Manager events:ingest uploader (lead/booked/completed, deduped, retries);
  encrypted 90-day click ids; privacy text. Turning it on needs approval (new sensitive scope + OAuth verification).
- Google Ads connection management: DEPLOYED 2026-11-13 (207af88, deployment 0b341010): Disconnect (pause-first or
  leave-running, honest notice, no revoke), guided setup when a sign-in has no Ads account, payment status from Google,
  in-app data-use disclosure, privacy policy now describes Google Ads use.
- Google Ads verification + safety + compliance gate: DEPLOYED 2026-11-13 (60e94fe, deployment 0e4a154a): read-back of created
  campaigns (after creation + daily), Google state reconciliation, account-switch approval reset, lower-budget
  enforcement on running campaigns, Maximize clicks bidding, accurate charging wording, optimizer recommend-only by
  default (policy). docs/GOOGLE_ADS_COMPLIANCE.md: verified Google facts + our Test-level status + launch blockers.
- First PoolThru sandbox campaign (2026-11-13): NOT created. The owner approved a $500/month budget and ran Check (no
  spend), but never approved the campaign itself (draft umfJ…, no approver), and its daily budget ($20) is above the
  approved ceiling ($16.44/day). Creating it needs the owner to set ≤ $16.44/day and press Approve, then Create. Audit
  fixes on branch feature/ads-campaign-quality: towns split on commas (keywords were "… charleston mount pleasant"),
  owner exclusions → negative keywords, near-me/local keywords, campaigns target people located in the ZIPs (PRESENCE).
  Next missing piece: conversions back to Google (store gclid per lead, a conversion action, upload booked/completed).
- Ads connection status polish: DEPLOYED 2026-11-13 (1eae80e, deployment a144ea2c).
- Ads connection status polish (details): four states in words +
  icon (✓ Connected / • Choose an ad account / ! Reconnect required / ○ Not connected); primary button only for Connect
  or Reconnect required, otherwise a muted secondary Reconnect link; "Test mode" badge note + "Test account · no spend"
  badge; duplicate-draft notice neutral (was the red error style), "Google Ads is connected" success in green.
- Campaign review: DEPLOYED 2026-11-13 (f95717e, deployment c2e89690). Root causes found in PoolThru's data:
  services saved as one comma-joined item → template headline cut to "Weekly pool cleaning, Pool mai"; two identical
  drafts 12.5 s apart = "Draft my plan" clicked twice (no guard). Launch was already duplicate-safe (atomic claim +
  tagged-name lookup on Google). Fix: services split on commas/newlines; whole-word headlines; one open draft per
  platform (atomic, before any AI cost); review UI with preview, budget summary, per-field counters/inline errors,
  explained Check/Approve/Create, confirm steps for Create and Remove. PoolThru's existing 2 drafts are kept (notice).
- Google Ads account selection UX: DEPLOYED 2026-11-13 (d466e3c, deployment 7c7c96e6).
- Google Ads account selection UX (details): Google sign-in and
  the chosen Ads account shown separately; selected account shown once with a checkmark; Change account only when
  another eligible account exists; exactly one eligible + nothing chosen before → selected automatically (not after a
  test-business unmark reset). Frontend + e2e mock scenarios only; server rules unchanged.
- Website URL input: DEPLOYED 2026-11-13 (3f870cf, deployment e2122dce). server/url.js normalizeWebsiteUrl()
  for every business; Ads profile website accepts example.com / www / http / https (https default), refuses unsafe.
- PoolThru Ads sandbox: DEPLOYED 2026-11-13 (c46662a, deployment 8b69546f; ADS_BUSINESSES = gsu-stripe-test-pools,
  poolthru-llc). Owner connect (step 6) pending.
- PoolThru Ads sandbox prep (2026-11-13, branch feature/ads-sandbox-pilot, NOT deployed): sandbox launch/resume on a
  verified Google Ads test account no longer requires a GetShowUps subscription (pilots are never billed); live keeps
  the rule. Enabling PoolThru = add poolthru-llc to ADS_BUSINESSES (secret) + redeploy (approval). PoolThru stays a
  REAL business (never marked test); ADS_LIVE_LAUNCH off keeps it on test accounts only.
- Admin console layout: DEPLOYED 2026-11-13 with PR #5 (0f6e2dd, deployment 7205a098).
- Admin console layout (2026-11-13, branch feature/admin-test-businesses-section, NOT deployed): the Customers list
  shows real businesses only; marked businesses appear only under a separate "Test businesses" section (frontend only,
  same API/metrics). Admin e2e MRR check made race-safe (selfserve.spec can add a real $0 subscription in parallel).
- Test-business isolation (2026-11-13, branch feature/test-business-isolation, NOT deployed): migration
  0012_test_businesses.sql (new table only; dry-run on a production copy: applied twice, integrity + FK ok, PoolThru
  identical). Admin marks/unmarks in the console (confirm + audit). Marked: Test tag, out of customer counts / MRR /
  rates; Google Ads test accounts only even with ADS_LIVE_LAUNCH; only MESSAGE_TEST_RECIPIENTS even with
  MESSAGES_LIVE (lead messages, outbox, SMS, GHL workflows); Stripe checkout/portal refused with a live key. Unmark:
  records created up to that moment stay sandboxed; Ads connections reset to "choose an account". Business
  structure: PoolThru (real pilot) and GetShowUps (real pilot) never marked; gsu-stripe-test-pools to be marked after
  deploy. Order: migrate BEFORE deploy (the overview reads the table; other paths fail closed).
- Production OAuth (2026-11-12, owner): Ads callback URI registered on the production Web client (verified by a
  no-sign-in authorize probe), adwords scope listed, consent screen In production / External, user cap 3/100.
- Single-business pilot still needs (each an approval): deploy PR #1 (migrations: none new);
  ADS_ENABLED=true + ADS_BUSINESSES=<pilot id>; a test connection first. Real (non-test) accounts additionally need
  Explorer/Basic access on the Cloud project and ADS_LIVE_LAUNCH=true + an owner budget approval before any spend.

### Ads Overview (2026-11-11): built on feature/ads-overview, NOT deployed (needs approval)
- Overview "Advertising" row when ADS_ENABLED: ad spend, clicks, leads from ads, bookings, show-ups, cost per
  booking, cost per show-up (server/ads/campaigns.js adSummary). Real data only: spend/clicks from
  ad_metrics_daily (null until recorded), leads from lead_attribution for the business's own campaigns, test
  leads excluded; costs null without spend or a denominator ('—' in the UI).
- Website → booking attribution: the website already carries utm_*/gclid onto booking links; now covered end to
  end (ad click on /p/:id → booking link → lead credited to the campaign). No Google Ads API calls.

### AI website usage policy (2026-11-11): LIVE (e3f4ebe, deployment 378c4c67; migration 0011 applied)
- Was: rate rule websiteGenerate 10/day per business (UTC-midnight window) shared by generations AND revisions,
  counting failed attempts; plus 40 AI results per rolling 30 days. Every 429 showed "several versions today".
- Now (server/ai-usage.js, table website_ai_usage): per business per UTC day, only successful AI results count.
  testing (platform-admin sign-in or AI_TESTING_BUSINESSES) 200 generations / 400 revisions; paying (hosting
  active incl. pilots) 20 / 40; not yet paying 5 / 10. 30-day AI cost ceiling $10 / $2 / $0.50 (measured avg
  $0.0005 per AI result). Burst guard websiteAi 30 attempts / 10 min. Manual edits unlimited. The dashboard
  shows "N of M left today · resets at <local time>" and specific limit messages.

### Dashboard preview showed an unkept revision (2026-11-11): LIVE (e94c0e8, deployment 0f8e2bac)
- Cause: Website tab kept a "Describe a change" revision pinned in the Preview after "Start over with three new
  designs" (the revision box unmounted without clearing it), so the preview showed a design that was not the
  draft while Publish sent the draft. Not caching, stale data or a renderer difference: generation option,
  saved draft, preview and live site were verified byte-identical in production.
- Fix: the pending revision is cleared on start-over and on apply; an unsaved revision is labelled
  "New version · not saved yet" and publishing waits until it is kept or discarded. Regression: website.spec.js.

### Website images and headlines fix (2026-11-10): LIVE (f1a2128, deployment 7ec4f896)
- Cause: PoolThru has no business_profiles row in production → industry null → stockFor() fell back to generic
  home- photos (house, kitchen, living room); a ZIP-only area ("ZIP codes 29403") was given to the AI as the area.
- Fix: industryKey() from industry → service names → description → name; each industry has only its own photos,
  palettes, names and art direction; unknown industry → no stock photo (text-led). Stock refs outside the
  business's industry are rejected on generate and revise. Headlines: brand (legal suffix dropped) + service + city;
  ZIP codes rejected unless the owner asks; ZIP-only areas aren't shown as copy.
- Existing drafts and published sites are not modified (PoolThru's live site keeps its current design until a new
  one is generated and published). Tests: test/website-images.test.js (pool, cleaning, lawn, trades, unknown).

### AI website design upgrade (branch release/ai-design, NOT deployed; awaiting visual approval) (2026-11-10)
- The AI now makes structured design decisions, not just copy. One request (Mistral Small 3.1 on Workers AI)
  returns the copy plus three designs chosen from a safe design system (server/site-design.js): palette (8,
  AA-checked, 2 dark), typography (5 self-hosted OFL pairings), hero layout (split / immersive / stacked /
  typographic), services (cards / numbered rows / tiles), about (split / statement band / plain), shape, section
  order and photo placement. The server forces the three to differ (hero, palette, fonts) and repairs any invalid
  choice. No AI-written HTML/CSS/JS.
- Photos: the owner's uploads first (the main photo always wins), otherwise a curated CC0 stock library of 20 photos
  in 5 industry groups (public/site-stock, 1600 px + 900 px versions, licence records in server/stock-photos.js).
  The "Our work" gallery shows only the owner's photos.
- Revisions: "Describe a change" (free text or suggestions such as "Make it more modern" or "Use my photos") → one
  request → a pending version shown in the preview → Keep this / Go back. The draft and live site change only when
  kept and published.
- Existing sites: content without a design renders through the original renderer unchanged (PoolThru live and
  draft are unaffected until the owner chooses a design).
- Measured with the real model through the app (local workerd): create 12.5–14.3 s, 817 in / ~530 out tokens,
  $0.00058; revise 6.5–9.6 s, ~1,240 in / 320–383 out tokens, $0.00061–0.00065. Limits: 10/day plus 40 per
  30 days per business; edits, previews, design switches and visits never call the model.
- Known limitation: the copy can still contain vague, unverifiable phrasing ("our dedicated team", "you can trust")
  that passes the claims and number filters. The owner reviews everything before publishing.
- Tests: 265 unit (website-ai.test.js 13), 55 Playwright (design picker, revision keep, owner photo on the public
  site). Screenshot review gallery generated locally from the running app (session scratchpad, not committed).

### Milestone A: AI website generation (branch release/ai-websites, NOT deployed) (2026-11-10)
- Flow: Create my website → one Workers AI request (Mistral Small 3.1 24B) → choose a design from 3 side-by-side
  previews of the stored result → private draft → large desktop preview with a phone toggle → simple editor and
  photos → publish. Onboarding also offers "I already have a website" (keeps it; booking link shown at the end).
- Model choice (real Workers AI evaluation, 3 business profiles, 2 prompt rounds): mistral-small-3.1 had 3/3
  valid JSON, ~5 s and the best copy. llama-3.3-70b: valid JSON but flat copy and 9x the output price. llama-4-scout:
  11–21 s. gpt-oss-120b and qwen3/3.8: unreliable JSON. Through the app on local workerd with the real model: 2/2
  ai, 3.8–4.8 s, ~440 in / ~230 out tokens, $0.00028 per generation, 0 fields rejected.
- Safety: facts only from records; the claims filter plus the invented-number check, falling back to the template
  per field; never changes the draft or live site without the owner applying or publishing.
- Migration 0010 (additive): website_generations (content, tokens, cost_micros, latency, rejected fields).
- Tests: 259 unit (website-ai.test.js +7), 55 Playwright (generator flow, AI stand-in that also checks the filter).
- Needs approval: the Workers AI binding `AI` on the Pages project (production), migration 0010, deploy.

### Managed websites + simpler dashboard (branch release/managed-websites, NOT deployed) (2026-11-10)
- Website engine: one server-side renderer (server/site-render.js) for /p/:id, connected domains and the owner's
  private preview. Script-free HTML with a strict CSP, mobile-first, SEO tags + LocalBusiness JSON-LD. Three styles,
  seven accent colours, logo/hero/gallery images, services with prices/descriptions, about, area, facts, search text.
  Every text goes through the claims filter.
- Content model: websites (private draft) + website_versions (every publish kept; restore = rollback).
  Unpublish keeps the content. A business's published legacy landing page stays live as version 1 when it first
  saves. The old landing API and React page were retired (one system).
- Images: browser-resized, byte-sniffed JPEG/PNG/WebP ≤ 1 MB, 30 per business, stored in D1 (no new
  infrastructure). Public only while a live version uses them.
- Hosting follows the plan: pilots are always hosted. Self-serve sites are hosted while paid (including past_due),
  then for 14 days after the paid period ends, then show "unavailable" (content kept; resubscribing restores).
- Domains: TXT ownership proof (_getshowups.<host>) → attach via the Cloudflare Pages domains API → CNAME → certificate
  + HTTPS check → Connected. Hostnames are globally unique; nothing is attached before proof; apex domains are steered
  to www with a forward. Middleware routes connected hosts; other paths redirect. Cron re-checks (bounded). Owners can
  disconnect, which detaches it while the content stays. **Live provider not configured** (needs CF_API_TOKEN /
  CF_ACCOUNT_ID / CF_PAGES_PROJECT, approval). Until then a verified domain waits in "verifying" and admin is flagged.
- Dashboard: Overview (website status, 3 stats, one next step, outcomes to record, upcoming), Appointments,
  Website, Settings. No internal counters; reminders read "activating soon". Billing appears only for billed businesses.
- PoolThru billing alert fixed at the root: an abandoned checkout had left an 'incomplete' placeholder (no
  subscription) and readiness treated it as a plan to fix. Billing now applies only to self-serve signups or real
  subscriptions, and checkout is refused for pilots (no placeholder rows). No financial records were changed.
- Attendance: showed ↔ no-show ↔ "not sure yet" (clear), always correctable. An Undo follows each mark.
  appointment_changes keeps the history, and counts come from the current status (no double counting).
- Test data: leads from @getshowups.com, platform admins or the business's own users count as tests automatically,
  and owners can mark or unmark them (test_marks). Tests are listed with a "Test" tag and excluded from dashboard and
  admin metrics. Nothing is deleted. PoolThru's 2 existing internal test bookings are excluded with no data change.
- Migration 0009 (additive): websites, website_versions, website_assets, website_domains, appointment_changes,
  test_marks, onboarding_marks.
- Onboarding: … hours → website (generated, edit + live preview) → address (GetShowUps / own domain / buy) →
  preview & publish (consent; or keep private) → done.
- PoolThru pilot: draft in docs/poolthru/website-draft.json; review and cutover plan in docs/poolthru/MIGRATION.md.
- Release verification (2026-11-10): fixed onboarded self-serve businesses being sent back into setup, a
  domain status that could get stuck at "Securing" when the HTTPS check can't reach the domain, and readiness
  counting test bookings. 0009 was verified on a fresh production export. Real image upload is e2e-tested on workerd.
  Local PoolThru preview: `npm run preview:poolthru`. Runbook: docs/RELEASE-managed-websites.md.
- Tests: 252 unit, 55 Playwright. Mocked: DNS, hosting provider, HTTPS probe, Stripe, Google. Not live-verified: the
  custom-domain provider calls.

### Customer-ready MVP: self-serve signup → checkout → guided onboarding (local, NOT deployed) (2026-11-10)
- Homepage: one Get started path (/dashboard?plan=founding), Sign in for existing customers, honest copy (no AI
  texting / missed-call / simulation claims; SMS and ads labelled coming soon), founding plan $499/month, no trial,
  ad spend separate. Meta descriptions updated.
- Account: Google sign-in (existing auth; Google-verified email, no passwords). Plan survives the OAuth round trip.
  Business name only, then checkout; one business per account.
- Billing: Stripe customer created first (idempotency key), duplicate-subscription guard against Stripe, open-session
  resume, cancel/decline handled, access follows the signed webhook; existing businesses unaffected.
- Onboarding (resumable, server-derived): details (phone, industry, towns, ZIPs, description, mode, timezone) →
  services (suggested, with prices) → calendar (existing OAuth; live health check, reconnect) → hours → landing page
  (draft from profile, live preview, publish only with explicit consent) → availability check → launch checklist.
- Dashboard: Next step card (readiness), plan-ended notice; admin attention flags: checkout_abandoned,
  cancel_scheduled, subscription_ended.
- Migration 0008 (additive): self_signups, business_profiles. Tested on the latest production backup: 2 new tables,
  33 existing unchanged, integrity ok; PoolThru has no self_signups row.
- Tests: 233 unit, 54 Playwright (selfserve.spec: full journey on desktop and phone with a local Stripe stand-in that
  sends Stripe-signed webhooks). Real Stripe sandbox: customer-first checkout, resume, duplicate guard all PASS.
  e2e mock calendars are now per business (fixed cross-spec slot races at the root).
- Needs approval: deploy + migration 0008; then a production sandbox journey with a temporary test business.


### Launch completion: release candidate on branch release/ads-mvp (2026-11-09), NOT pushed or deployed
- Production D1 backup taken (read-only export, 39 rows, kept locally in the session scratchpad, not committed).
  Migrations 0006 + 0007 applied twice to a restored copy: 12 new tables, all 21 existing tables byte-identical,
  integrity ok.
- Release switches added so deploying changes nothing customers see: ADS_ENABLED, GHL_ENABLED (plus the existing
  ADS_LIVE_LAUNCH, MESSAGES_LIVE). With all of them unset, the only visible change is the landing page card in Settings.
- Landing page: /p/:id from one template (headline, intro, services, area, owner-confirmed facts), the claims
  filter is shared with ads, and the owner publishes. Public only while published AND the business is bookable.
  "Book" opens the existing /book/:id with utm parameters kept. Ads drafts point to it once published.
- GoHighLevel Settings card (GHL_ENABLED only).
- Tests: 223 unit tests, 53 Playwright tests (landing.spec added).
- Release plan, each step needs approval: push branch (CI) → merge to main (auto-deploys) → apply 0006 then
  0007 on production → smoke checks (/, /dashboard, /book/poolthru-llc, /api/dashboard/ads → 404, /p/poolthru-llc → 404 until published) →
  PoolThru: publish landing page, one live test booking.


### Advertising engine: built and tested locally, NOT deployed, no live ad calls (2026-11-09)
- Migration 0006 (new tables only): ad_profiles, ad_budget_approvals, ad_connections, ad_campaigns, ad_metrics_daily,
  ad_actions (audit + idempotency), ad_creatives, ai_usage, lead_attribution, ghl_links, meta_lead_events.
- Campaign spec (server/ads/spec.js) is the only input adapters accept: platform text limits, ZIP geo, https URL,
  and an unapproved-claims filter (guarantees, discounts, credentials, superlatives, reviews, before/after, speed).
- AI planner (server/ads/strategy.js): claude-opus-5-5, structured JSON output, refusal fallback, cost recorded against
  a $20/month per-business AI cap. Output is filtered, then drafts are validated. Without ANTHROPIC_API_KEY a
  labelled starter template is used (this is what e2e exercises).
- Spend guardrails: owner approves a monthly ceiling (checkbox), and approved campaigns' combined daily budgets can't
  exceed it. Editing an approved campaign returns it to draft. Live create/resume requires ADS_LIVE_LAUNCH=true
  (operator switch, needs approval), an approved campaign, budget room, monthly spend under the ceiling, and an active
  or trialing subscription once Stripe is configured. Campaigns are always created PAUSED; the owner presses Start.
- Non-spending path: "Check (no spend)" = Google validateOnly / Meta dry run.
- Optimizer (server/ads/optimizer.js, cron): deterministic; pauses on monthly ceiling, overspend or a missing approval;
  alerts on stale data or missing tracking; recommends budget cuts. Never raises spend, never resumes. Idempotent
  per campaign/rule/day, and an owner resume overrides it for that day.
- Adapters: Google Ads v26 (server/ads/google.js + /api/ads/google/*), Meta v27 (server/ads/meta.js +
  /api/ads/meta/* incl. lead webhook), creatives (OpenAI images, Runway video, R2 AD_ASSETS, quotas). All mocked in
  tests. Payload shapes marked UNVERIFIED in the code need a sandbox/test account.
- GoHighLevel (server/ghl.js): one-way copy of contacts and pipeline stage; GHL can own SMS (then our SMS is skipped
  as ghl_sms); workflow enrollment respects the message test gate. docs/DATA_OWNERSHIP.md.
- Attribution: ad links carry utm_campaign=<our campaign id>; booking-page leads are attributed only to the same
  business's campaign. Results: spend, qualified leads, booked, completed jobs, reported job value, cost per
  booking and per completed job (null when unmeasurable); verified payments and incremental revenue not measured.
- Pricing copy: proposed $499/month (labelled proposed). Billing uses the existing Stripe plan infra; it needs a
  $499 Stripe Price id.
- Tests: 217 unit tests (ads 21, ads-google 20, ads-meta 22, ghl 14) and 51 Playwright tests (ads.spec 3). Fixed a
  cross-spec slot race in modes.spec.
- Needs approval, in order: migration 0006 on production → deploy → Google OAuth redirect URIs + adwords scope +
  Ads API access → Meta app + App Review → ANTHROPIC_API_KEY / OPENAI_* / R2 bucket → GHL PIT → Stripe $499 Price
  → ADS_LIVE_LAUNCH=true (first real spend).


### Appointment modes: at_business / at_customer (local only, not deployed)
- [x] Migration 0005 (additive): service_settings, lead_addresses, appointment_outcomes
- [x] Business setting "Where do appointments happen?"; existing businesses stay at_business
- [x] at_customer: validated US service address; ZIP from the address drives service area; address on the
  Google Calendar event location; kept out of logs, events, and platform admin views
- [x] Mode-specific booking page, confirmation/reminder/rebook emails, confirm page, dashboard labels
- [x] Outcome model: visit happened (showed/no_show) separate from work completed; optional reported job value
  labelled as association, never as revenue caused by GetShowUps; platform shows incremental revenue as not measured
- [x] Tests: modes.test.js (14) + modes.spec.js (5); at_business regression suites unchanged
- Needs approval: run 0005 on production, deploy, set PoolThru (poolthru-llc) to at_customer.

## In progress

### Revenue engine (Level 2): built and tested locally, NOT deployed (2026-11-09)
- Lead follow-ups (+15 min, +24 h) with a signed "pick a time" link that resumes booking for the same lead.
- Booking confirmation + reminders (24 h, 2 h) with a signed "confirm I'll be there" link → appointment_confirmations.
- No-show: reopens the lead and sends a rebook invitation after 30 min (skipped if the owner corrects the outcome).
- Email via Resend (code existed; reused). SMS via Twilio (new; consent checkbox shown only when configured).
- Scheduler: workers/scheduler cron (every 5 min) → POST /api/cron/run (CRON_SECRET). Also runs onboarding follow-ups.
- Dashboard: Leads, Booked, Booking rate, Confirmed, Showed, No-shows, Show rate, Messages sent; automation card + toggle.
- Migration 0004 (new tables only). Privacy policy + DATA_REQUESTS.md updated for messages/SMS.
- Launch gate (fails closed): without MESSAGES_LIVE=true, messages go only to MESSAGE_TEST_RECIPIENTS (a secret);
  others are skipped as test_mode (lead messages) or held pending (account outbox). Dashboard shows "in testing".
- Tests: 127 unit (12 new in test/automation.test.js) + 39 Playwright (4 new). No live message has been sent.
- To go live (each needs approval): migration 0004 → deploy → Resend domain + RESEND_API_KEY/EMAIL_FROM →
  CRON_SECRET on Pages + scheduler Worker deploy → (later) Twilio + A2P 10DLC approval.

### Launch release (awaiting approval — see docs/LAUNCH.md)
Everything below is **local and tested**, not in production.
- [x] Self-service onboarding, PoolThru linking, booking page, appointment engine, results dashboard
- [x] Hardening: rate limits, Google timeouts, idempotent event creation, stale-reservation recovery
- [x] Platform console `/admin`: customers, signup dates, sources, onboarding, calendar health (live check),
  booking activity, subscription/account status, attention flags, search, detail, audit trail
- [x] Onboarding ops: self-service, admin invitation, admin-assisted setup (one data model); expiring single-use
  invitations bound to one Google email; resend/revoke; follow-ups queued (email delivery not configured)
- [x] Billing prepared (inactive until Stripe keys + plans): Checkout with one-time trial, portal for
  upgrade/downgrade/cancel/reactivate, signed idempotent webhooks, out-of-order protection, statuses
  trialing/active/past_due/canceled + manual suspension (booking paused, billing still reachable)
- [x] Analytics events (deduplicated) + growth metrics: activation, first booking, conversion, show-up,
  retention, MRR/ARR/paying/trialing/revenue/churn from billing data; CAC/LTV/gross margin shown as unavailable
- [x] Tests: 108 unit/integration + 33 Playwright
- Not done: email provider, Stripe account/plans, public Google app verification, cancellation/reschedule,
  session/invite purge job, cron (follow-ups run when the admin console loads).

- 2026-11-09 00:53Z: launch release `9c1bcef` LIVE (deployment 2c7f07ff). D1 migrations 0002/0003 applied (14 tables);
  pre-release backup: Time Travel bookmark 0000000b-00000000-0000511e-1d9da13728f07191fe8dfeb5f824b61a + local export.
  New Google client active for sign-in/connect; PoolThru health `healthy`, `oauthClient: legacy`.
  Privacy requests: manual runbook in docs/DATA_REQUESTS.md (contact brandon@getshowups.com).
  2026-11-09: PoolThru on new client (M4 done). Canonical customer = `poolthru-llc` (self-serve duplicate of `poolthru`).
  Test booking verified + cleaned up; /admin verified. /privacy live; Google app In production; grant-safety fix
  (4b8c48f); poolthru-llc reconnected on production token; legacy fallback code removed (5f04af9).
  Next: after 2026-11-16 01:00Z verify poolthru-llc health, then remove legacy credentials (checklist in LAUNCH.md).

## Decisions

| Date | Decision | Why |
| --- | --- | --- |
| 2026-11-08 | No root wrangler config; bindings stay in the Cloudflare dashboard | A root config would override production bindings |
| 2026-11-08 | E2E runs real Functions on local workerd with fake creds; Google mocked; all external network blocked | Real runtime coverage without secrets or live calls |
| 2026-11-08 | CI uses no secrets; previews have no bindings | Safe for untrusted PRs |
| 2026-11-08 | D1 for invites, KV for encrypted tokens | D1 gives atomic single-use; KV is eventually consistent |
| 2026-11-08 | Scopes `calendar.events.owned` + `calendar.freebusy` | Least privilege, verified against Google docs |
| 2026-11-08 | Admin API = bearer `ADMIN_API_TOKEN` (stored in macOS Keychain `getshowups-admin-api-token`) | Simplest secure option until customer login exists |

## Known issues / gaps

- A direct link to `getshowups.com/#book-demo` does not scroll to the section (React renders after the
  browser's fragment scroll; the lazy calendar iframe then stays unloaded until scrolled). Low impact.
- `src/config/ghl.js` exports `isBookingConnected`/`isLeadFormConnected`, currently unused.
- No customer login yet; admin token is a single shared secret.
- GoHighLevel: only the `VITE_GHL_*` embed hooks exist. **No GHL account/API connection has been verified.**

## Next actions

1. **Customer dashboard & onboarding for PoolThru** (feature card to be written at PLAN step):
   login → connect Google Calendar → connection status → submit test lead → view availability → see bookings.
   First step: verify what GHL access actually exists before choosing CRM/SMS build-vs-reuse.
2. Then: lead capture → qualification → booking → reminders → show-up tracking.

## 2026-11-15: customer journey gaps (draft PRs #32 → #33 → #34, stacked; NOT merged/deployed)

- #32 Owner notices (new booking / customer cancellation / lead unbooked after 10 min) + customers cancel and pick a
  new time from their email link. Migration 0018 (indexes, optional).
- #33 What customers should know (before-the-appointment + cancellation notes) on the booking page and in the
  confirmation / day-before reminder. Migration 0019 (public reads fail soft without it).
- #34 Resend delivery feedback: signed webhook; permanent bounce/complaint → address suppressed, owner asked to call.
  Migration 0020 + Resend endpoint + RESEND_WEBHOOK_SECRET (approval).
- Evidence: local only (verify:all 390 unit / 74 Playwright on #34's tip). Nothing live-verified yet.
- Next: approve merge/deploy in order #32, #33, #34 with migrations 0018–0020; then Stripe live + MESSAGES_LIVE
  per docs/LAUNCH_READINESS.md (PR #29).
