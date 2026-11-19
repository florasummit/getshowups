# Website Studio improvement plan (2026-11-18) — for approval, nothing built yet

Follows docs/STUDIO_QUALITY_REVIEW.md. Priority = the highest-impact design-quality issue: **most new customers get a
thin, generic first screen and a sparse page** (review findings 1, 3 and 5). Imagery (finding 2) and section editing
(finding 4 / proposal 3) come after, in that order.

## Rule for every phase: published sites do not change

- Live sites render per request. Every phase must leave `test/render-golden.test.js` byte-identical for all existing
  fixtures (`test/fixtures/render/*.json` are never regenerated). New behaviour gets NEW fixtures + goldens.
- New fields and section variants render only when present in stored content, so existing content cannot pick them up.
- The starter runs only for a business without a site (or adds missing pages, never replaces): existing drafts and
  live versions are untouched. Nothing is published automatically.
- `test/e2e/site-layout.spec.js` (desktop + phone: no sideways scroll, headline + booking on the first screen) runs on
  every new fixture.

## Phase 1 — conversion-first starter site (highest impact; proposed first PR)

Scope: `server/site-starter.js` (data only, uses section types that already exist: hero, services, steps, faq, area,
contact, cta) plus one small validator/renderer addition. No migration, no AI, no cost.

| Section (home) | Content, from records only | Shown when |
| --- | --- | --- |
| Hero | headline, intro, **area line**, **"Book online" + "Call (xxx)"** side by side | always (Call only with a phone on record) |
| Services | cards with the owner's descriptions and prices | services exist |
| How booking works | 3 steps that describe what the product does TODAY (pick a service → pick a time → you're booked; the confirmation-email step only while messages are live) | always |
| Hours & area | booking hours + towns / ZIPs; "we come to you" only for `at_customer` | hours or area exist |
| FAQ | owner's own policies (before the visit, cancellation), appointment mode, area — word for word | at least one record |
| Final CTA | Book online | always |

The one code addition: a **`call` button target** (`{ target: 'call' }`) whose number comes from the business record at
render time (never from the spec, never AI), rendered as `tel:` link; dropped when no phone is on record. Validator
accepts it; renderer emits it only when used, so existing goldens stay identical. Phone layout rule for the new hero:
both buttons in one row (wrap together), photo after them.

Acceptance: new fixtures for 6 industries × (photo / no photo) with goldens; first-screen check extended to "phone
visible when on record" and "Book + Call adjacent on phone"; all existing goldens unchanged; claims/number filters
still applied; before/after screenshots per industry attached to the PR.

Size: about 1 PR, medium. Risk: low (new sites only).

## Phase 2 — onboarding produces the Studio format

Onboarding's "Create a new website" step uses the Phase 1 starter (content.site) instead of the older
`content.design` generator for NEW businesses, so every new customer gets the same editor, section controls and later
improvements. Existing `content.design` sites keep rendering with `site-designed.js` unchanged (goldens). Optional AI
prose (owner's key) fills the same structure through the existing pipeline. Needs: onboarding website step + e2e.

## Phase 3 — imagery that fits

Text-led hero variant that looks intentional when no fitting photo exists (service chips + accent panel; new-only
variant). Per-trade CC0 photos (≈12, vetted like the current library: no people, no logos) — sourcing needs your OK
on the list. Onboarding asks for 3 own photos (owner photos always beat stock).

## Phase 4 — "Improve this section" + composition phone order

One-section AI rewrite (other sections byte-identical, asserted), owner's key; and the phone-order fix for AI
compositions (PoolThru split buttons). The phone fix changes how existing compositions render → it ships only behind
renderer versioning (old versions keep old CSS) or with your explicit approval of the golden diff.

## Decisions (owner, 2026-11-18)

1. Phase 1: **approved**; built in feat/studio-starter-phase1.
2. "How booking works": describe only what production does; no confirmation emails, texts or other messaging while
   those are off; never "coming soon".
3. Photos: **approved for a future phase**. Curate ≈12 commercially usable, freely licensed photos with source, license,
   attribution and permitted uses recorded (docs/PHOTO_LIBRARY_CANDIDATES.md); separate from Phase 1; no existing
   customer website changes automatically.
4. (2026-11-19) Label the hours "Online booking hours": the record is when online booking offers times, not opening
   hours. HVAC starters stay text-led (no stock photo; an owner photo still wins) until licensed HVAC imagery is
   approved (site-starter.js textLedStarter).
