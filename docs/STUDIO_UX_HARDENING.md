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

## Findings

(filled in below after the audit)
