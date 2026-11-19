# Website Studio UX hardening (Agent A, 2026-11-19) — feat/studio-ux-hardening

## Plan (written before building)

Rule for every item: **published sites do not change.** `test/render-golden.test.js` must pass with the frozen
fixtures and goldens untouched; new renderer behaviour only for content that carries new, newly stored data.

1. **Photo usage, deletion, hiding, replacement** (server/assets.js, functions/api/dashboard/website/assets.js,
   SiteStudio Photos panel).
   - One reference walk (`photoUsage`) per business: draft (with page · section names for the Studio format), the LIVE
     version, every saved version (restore), logo history (current + earlier logos), AI-designer undo and draft
     checkpoints. Reads content (logo, hero, photos, `content.design` hero/about images, `content.site` image refs,
     phone copies of used photos), never text search.
   - Delete only when nothing recoverable uses it (unchanged rule, now also counting `content.design` images, which
     were missed). The phone copy of a deleted photo goes with it when nothing else uses it.
   - **Hide** (soft delete) a photo that only history uses (saved versions / undo / checkpoints, not the draft or the
     live site): it leaves the photo list and every picker, bytes kept so restores still work. Undo with Show.
     Migration 0030 (`website_asset_hidden`, additive, idempotent; NOT applied to production). Before 0030 is applied
     Hide answers `not_available` and nothing else changes.
   - **Replace everywhere in the draft**: swap one photo for another in every draft slot (Studio sections, opening,
     gallery, older-format hero/photos/design images). One undoable edit, autosaved like any edit; the live site
     changes only with the normal publish.
   - UI: "Used on: …" per photo, confirmation before delete / hide / replace; same-origin + session-scoped routes;
     another business's id → 404.
2. **Phone-sized images for the older design format**: Studio sites already use `content.variants` (800w copy). The
   older editor (WebsiteEditor, `content.design` sites) now makes the same phone copy on upload and marks the content
   `responsiveImages: true`. `site-designed.js` emits `srcset` for owner photos **only** when that flag is stored and a
   copy exists, so every stored content without the flag renders through the unchanged code path.
3. **Full screen and Back**: Escape (also when focus is inside the preview frame) and the visible "Exit full screen"
   button leave full screen; full screen, the photo/button panel and the section menu each take one browser-history
   entry, so Back closes the top layer first and Forward never re-opens a closed one. Focus returns to the control
   that opened the layer.
4. **Editor state preservation**: per business and per browser tab (sessionStorage, try/catch): page, selected
   section, side-panel tab, Edit/Preview mode, preview size and preview scroll. Unsaved edits (localStorage per
   business) come back automatically after a tab switch, Back/Forward or reload when the server copy hasn't changed
   since; when it has, the owner is asked, and keeping them goes through the 409 conflict choice (never a silent
   overwrite). Pending edits save immediately when the browser tab is hidden. The preview keeps its scroll position
   when it re-renders after an edit.
5. **UX audit** at 1440×900 and 390×844: findings below with severity, repro, expected/actual, impact, fix, coverage.
6. **Tests**: unit (usage walk, hide/unhide/delete isolation, replace helper, opt-in srcset + goldens), Playwright
   (`studio-hardening.spec.js`, its own seeded businesses per browser project).

## Findings (fixed or deferred only)

Screens checked at 1440×900 and 390×844 (Pixel 7 project in CI). Screenshots: run
`STUDIO_SHOTS=test-results/studio-ux npx playwright test studio-hardening --project=desktop -g audit` →
`test-results/studio-ux/{1440,390}-{1-editor,2-full-screen,3-button-panel,4-photos,5-sections}.png` (not committed).

| # | Severity | Defect | Repro | Expected / actual | Customer impact | Fix | Coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | High | Full screen on a phone squeezed the website to a few pixels wide | 390 px → Full screen | Website fills the width / two-column grid left ~16 px for it (`390-2-full-screen.png`) | Full screen unusable on phones | One column under 980 px in full screen | e2e: iframe width in full screen (both projects) |
| 1 | High | Photo used by an older-format design deletable; such a photo 404s on the live site | Live `content.design` with `heroImage: asset:X` (X not the main photo or gallery) → Photos → Remove | Kept + served / deleted, and `/site-assets/X` refused publicly | Broken first-screen photo on a live site; delete that couldn't be undone | `usedBy` counts `content.design` hero/about images | unit: usage, public serving, delete refused |
| 2 | High | Browser Back from full screen or an open panel left Studio | Full screen (or click a button in the preview) → Back | Layer closes, still in Studio / dashboard navigated away | Owner thrown out mid-edit; thinks work was lost | Each layer is one history entry; Forward into a closed layer steps back | e2e: Back/Forward for full screen, panel, ⋯ menu |
| 3 | High | Unsaved edits lost on a dashboard tab switch | Type in Studio → click Overview within 0.8 s → back to Website | Edits there / only a "restore?" prompt, and only on the same business key | Silent-looking loss of the last edit | Per-business local copy auto-restored when the server copy is unchanged (notice + Discard); hidden tab saves at once | e2e: tab switch + reload |
| 4 | High | Old local copy could overwrite a newer server draft | Edit, close, change the site elsewhere, come back, "Restore them" | Conflict choice / applied on top of the newer copy with the new base (silent overwrite) | Newer work from another tab or the designer replaced | Restore keeps the copy's own base → 409 → "Load the latest / Keep mine" | e2e: older copy → conflict |
| 5 | Medium | Preview jumped to the top after every edit | Scroll the preview down, edit any field | Stays / back to top | Owner loses their place on every keystroke-batch | Scroll kept per page (this tab), restored on re-render; panel not closed by that restore | e2e: scroll kept |
| 6 | Medium | Escape did nothing when focus was inside the preview | Full screen → click the website → Escape | Exits / nothing (frame keys don't reach the page) | Keyboard users stuck in full screen | Frame forwards Escape (panel first, then full screen); focus back on the Full screen button | e2e (desktop) |
| 7 | Medium | Page, section, panel tab, mode and preview size reset on reload / tab switch | Edit the About page in Style → reload | Same place / Home + first tab | Re-navigation after every reload | sessionStorage per business (try/catch) | e2e |
| 8 | Medium | Photos: no way to see where a photo is used; blocked delete with a generic message; no replace | Photos tab | "Used on: Home · Hero, your live website, 2 saved versions" + Replace / Delete / Hide / generic error | Owners can't clean up or swap photos safely | Usage list, Replace everywhere in the draft (undoable, draft only), Delete only when unused (confirm), Hide for history-only photos (confirm, kept for restores) | unit + e2e |
| 9 | Medium | Older-format sites sent full-size photos to phones | `content.design` site with an uploaded photo on a phone | 800 px copy / 1600 px original | Slower first screen on mobile data | Upload makes the phone copy; renderer offers it only when the content opted in (`responsiveImages: true`) | unit: opt-in, byte-identical without it |
| 10 | Low | Section ⋯ menu: focus not returned after Escape | Open ⋯ → Escape | Focus on ⋯ / lost to body | Keyboard users lose their place | Focus returns to the menu button | e2e |
| 11 | Low | Upload error said "photo limit (60)" | 120 files stored → upload | Correct / wrong number | Confusing | Message without a number | unit (source check) |

Deferred (not fixed here): leaving Studio by a dashboard tab doesn't ask first (edits are kept and come back, so
no data is lost); Escape from inside the frame on touch devices (no keyboard focus there; the Exit button and Back
work); phone composition order on AI designs (renderer change for existing sites → needs renderer versioning).

## Renderer paths changed (published sites)

- `server/site-designed.js` `imageFor(ref, small)` / `phoneCopy`: a `srcset` is added to an owner photo only when the
  stored content has `responsiveImages === true` AND a `content.variants` copy for that photo. Stored content without
  the flag (every existing site, PoolThru, bob-electrical, toys-for-us, every golden fixture) takes the unchanged
  branch: `imageFor` returns the same `{ src, alt }` object as before and `imgTag` prints the same tag.
- `server/site-render-v2.js`, `server/site-render.js`: not changed.
- `server/assets.js usedBy`: not a renderer change; it now also lets `/site-assets/<id>` serve a photo the live
  `content.design` shows (before, those requests were refused).
- `test/render-golden.test.js` passes with fixtures and goldens untouched (no `UPDATE_RENDER_GOLDEN`).
