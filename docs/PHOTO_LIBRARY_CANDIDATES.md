# Photo library candidates (2026-11-18) — curated list, nothing added to the site yet

Owner decision 2026-11-18: approved for a FUTURE phase (Studio plan Phase 3), kept separate from Phase 1. No existing
customer website changes automatically: new photos would only be offered to NEW starter/AI designs, and only through
the existing rules (CC0 library, generic scenes, no identifiable people or logos, never in an "Our work" gallery, the
owner's own photo always wins).

## Why
The review (docs/STUDIO_QUALITY_REVIEW.md) found every trade sharing 4 "tools" photos (an electrician gets antique
axes) and no photos at all for wellness and professional businesses.

## How these were chosen
- Source and licence identical to today's library (server/stock-photos.js): StockSnap via the Openverse catalogue,
  filtered to `license=cc0`. Searched 2026-11-18; records below are Openverse's metadata for each image.
- Vetted from thumbnails for: fits the trade, no people, no visible brand/logo, works cropped wide (hero) and
  square (cards). Full-resolution check is a step of the import (below), not done yet.

## Licence summary (applies to every row)
| | |
| --- | --- |
| Licence | CC0 1.0 Universal (public domain dedication) — https://creativecommons.org/publicdomain/zero/1.0/ |
| Commercial use | Allowed, including on customer websites we host |
| Attribution | Not required. We still record creator + source (as for the current library) |
| Modification | Allowed (cropping, resizing, phone-sized copies) |
| Not granted by CC0 | Trademark, publicity or privacy rights → hence "no people, no logos" |
| Not allowed by our own rules | Presenting a stock photo as the business's own work; using it in "Our work" galleries |

## Selected (12)
| # | Use | Openverse id | Title | Creator | Source page |
| --- | --- | --- | --- | --- | --- |
| 1 | Electrical | d270adbd | Cables Wires (wires from a wall box, renovation) | Michal Jarmoluk | https://stocksnap.io/photo/cables-wires-NTBTAJYIOK |
| 2 | Electrical | 4fdefb45 | Light Switch (plain wall switch, copy space) | Matt Bango | https://stocksnap.io/photo/light-switch-GCFFRMA9VR |
| 3 | Plumbing | e513bc47 | Taps Gold (brass kitchen taps) | Studio 7042 | https://stocksnap.io/photo/taps-gold-WIFG1MZOKJ |
| 4 | Plumbing | 0ebabd34 | Sink Faucet (modern chrome faucet) | Fernando Arcos | https://stocksnap.io/photo/sink-faucet-XVEZZZGCXA |
| 5 | Roofing | 0b83e8bf | Roof Shingle (close-up of roof tiles) | Bernard Spragg | https://stocksnap.io/photo/roof-shingle-RIUJONCXNY |
| 6 | Painting | d9e49a4c | Paint Can (four open paint tins from above) | Sarah Pflug | https://stocksnap.io/photo/paint-can-QLGZGI5CHV |
| 7 | Painting | 5c084972 | Wall Paint (peeling paint on a wall) | Samuel Schneider | https://stocksnap.io/photo/wall-paint-IQ2PF1A1GQ |
| 8 | Handyman | bf73c9b1 | Drills Drill (drill-bit set in a case) | Marcin Milewski | https://stocksnap.io/photo/drills-drill-NQHDCWGEOH |
| 9 | Handyman / carpentry | bd9d7152 | Carpenter Workshop (workshop interior, warm light) | James Frid | https://stocksnap.io/photo/carpenter-workshop-YPM6VH3FCW |
| 10 | Wellness | 89b3bebb | Spa Wellness (stones, towels, orchids) | Healthy Living | https://stocksnap.io/photo/spa-wellness-PL9R5H2KKH |
| 11 | Wellness | 6da3e69e | Flatlay Spa (orchid, stones, salt) | Healthy Living | https://stocksnap.io/photo/flatlay-spa-2HEUUNACGX |
| 12 | Professional | 4a2ae3ff | Office Desk (minimal white desk and chair) | Bench Accounting | https://stocksnap.io/photo/office-desk-N7FUTW0RY5 |

Backups: 0fb59147 "Hydro Meter" (electrical; worn wall), 3335d4e4 "Drainage Pipes" (plumbing;
industrial), aaaa9fda "Office Desk" by Markus Spiske (professional; a phone is visible — check for a logo).
Rejected: ab8e50aa "Metal Abstract" (reads as a heat sink, not heating/cooling).

## Gaps (decision)
- **HVAC:** no fitting CC0 photo found on StockSnap (searched thermostat, air conditioner, vent, radiator, heating).
  Options: keep HVAC text-led (the planned intentional text-led hero), or approve a second CC0 source (e.g. other
  Openverse providers that are CC0) with the same vetting.
- Two photos per trade is thin for variety; enough for Phase 3's first step.

## Import steps (future phase, needs its own PR)
1. Re-check each source page's licence at download time (record the date); download the original from the source page.
2. Full-resolution review: no people, faces, reflections of people, logos, brand names, licence plates or readable
   addresses; reject otherwise.
3. Produce the same files as today (`public/site-stock/<id>.jpg` ≤1600 px + `-sm.jpg`), add manifest rows with
   licence, licence URL, creator, source.
4. Map to industries in site-design.js for NEW designs only; render goldens must stay byte-identical (existing stored
   content references existing stock ids only, which are never changed or removed).
