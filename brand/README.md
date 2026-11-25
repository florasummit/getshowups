# GetShowUps brand assets (canonical)

**Use these files. Never redraw, recolour, re-space or recreate the icon or the wordmark.** The sources are the SVG files in `icon/` and `logo/`; everything else is generated from them.

## The logo
- **Icon:** Calendar + Growth, concept A "Refined" (approved 2026-11-25).
  - A compact orange calendar outline (17 × 16, radius 3). Its top-right corner opens for a white check, which sweeps up through that corner at 45° and ends in a solid, pointed arrowhead beyond the outline ("booked, and growing").
  - The whole composition, arrow included, is centred on the near-black rounded square: 32 × 32 grid, corner radius 8.
  - Strokes: calendar 2.2, check 2.4, round caps and joins. The arrowhead is a filled triangle.
  - The geometry comes from `source/icon.py`; never edit the SVG paths by hand.
  - Flat colours only: no gradients, shadows or transparency effects.
- **Wordmark:** "GetShow" in ink plus "Ups" in orange, Inter weight 750, letter-spacing −0.02em. It is unchanged since 2026-11-21.
- **Lockup:** icon 28 px, a 10 px gap, wordmark at 18.4 px, text centred on the icon (as in `src/components/Logo.jsx`). Scale the lockup as one unit.

## Files
| Need | File |
| --- | --- |
| Icon, editable source | `icon/getshowups-icon.svg` |
| Icon on dark product surfaces (raised #22242A) | `icon/getshowups-icon-raised.svg` |
| Icon, square full-bleed (app stores, iOS) | `icon/getshowups-icon-square.svg` |
| Mark without background, for dark backgrounds | `icon/getshowups-mark-transparent-on-dark.svg` |
| Mark without background, for light backgrounds (ink check) | `icon/getshowups-mark-transparent-on-light.svg` |
| Full logo for light backgrounds (wordmark as outlines) | `logo/getshowups-logo-on-light.svg` |
| Full logo for dark backgrounds | `logo/getshowups-logo-on-dark.svg` |
| Icon PNG, 16–1024 px | `png/icon/getshowups-icon-<size>.png` (16, 32, 48, 64, 128, 180, 192, 256, 512, 1024) |
| Square / maskable app icons | `png/icon/getshowups-icon-square-{180,512,1024}.png`, `png/icon/getshowups-icon-maskable-512.png` |
| Transparent mark PNG | `png/icon/getshowups-mark-transparent-on-{dark,light}-1024.png` |
| Favicon | `png/icon/favicon.ico` (16/32/48) |
| Full logo, high resolution (2400 px wide) | `png/logo/getshowups-logo-on-{light,dark}-{transparent,background}-2400w.png` |
| Social sharing image (1200×630) | `social/getshowups-og-1200x630.png` (dark), `social/getshowups-og-light-1200x630.png` |
| Previous logo, rejected concepts | `archive/` (do not use) |

**Web copies:** `public/favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `og-image.png` and `site.webmanifest` are what getshowups.com serves.

**In the product:** use `<Logo />` (`src/components/Logo.jsx`). It is the only in-app logo, used in the header, footer, dashboard, onboarding, admin and sign-in.

## Colours
| Token | Hex | Use |
| --- | --- | --- |
| Brand orange | `#FF6A1A` | Calendar outline, primary accent fills |
| Icon background | `#111113` | Icon tile (files). In the product, the tile follows `--line-strong` `#0B0B0C`; on dark surfaces it follows `--c7` `#22242A` |
| Check / arrow | `#FFFFFF` | On the dark tile. Use ink `#111216` only on the transparent-on-light mark |
| Wordmark ink (light bg) | `#111216` | "GetShow" |
| Wordmark accent (light bg) | `#C2410C` | "Ups" (AA contrast on white) |
| Wordmark on dark | `#FFFFFF` + `#FF8A47` | "GetShow" + "Ups" |
| Dark stage | `#101114` | Dark backgrounds, social image |

## Typography
- **Inter** (`public/site-fonts/inter.woff2`, OFL): wordmark at 750, product text, bold upright headings.
- **Space Grotesk** (`public/site-fonts/space-grotesk.woff2`, OFL): small labels and numerals only. Never in the logo.

## Usage
- Leave clear space around the logo of at least half the icon's height on every side.
- Minimum sizes: icon 16 px; full logo 96 px wide.
- On light backgrounds use the light logo; on dark backgrounds, the dark one. Don't place the logo on photos or busy textures.
- Don't stretch, rotate, outline, recolour, add effects, rearrange the lockup or retype the wordmark.
- Ads, videos and decks take the files above directly (SVG where possible, otherwise the 2400w PNG).
- Customer businesses keep their own logos and website icons. This brand never replaces them.

## Changing the brand (rare; needs the founder's approval)
1. Change the geometry in `source/icon.py` and run `python3 brand/source/icon.py` (writes every `icon/*.svg`). Then mirror the paths in `src/components/Logo.jsx` and `test/e2e/flagship.spec.js` (`test/brand.test.js` fails until they match).
2. Rebuild the outlined logos: `uv run --with fonttools --with brotli --with uharfbuzz python brand/source/outline-wordmark.py`.
3. Rebuild the rasters and web copies: `node scripts/build-brand.mjs`. This also stamps a new icon version (`?v=`) on every icon link (`index.html`, the manifest, `server/brand.js`), so browsers fetch the new favicon instead of keeping the cached one.
4. Move the old files to `archive/`.
