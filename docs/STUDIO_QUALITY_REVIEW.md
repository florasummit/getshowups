# Website Studio quality review (2026-11-18) — proposals, nothing built yet

Evidence: desktop (1366×860) and phone (Pixel 7) renders of the 9 frozen render fixtures (test/fixtures/render: the
deterministic starter site for six industries, a 5-page site, legacy and `content.design` sites) and the live PoolThru
site (AI-designed, read-only). Layout checks (test/e2e/site-layout.spec.js) pass for all of them: no sideways scroll,
headline and booking button on the first screen. The problems are quality and conversion, not breakage.

## What a new customer gets today

There are **three generation paths with three quality levels**:

| Path | Who gets it | Result |
| --- | --- | --- |
| Onboarding "Create a new website" (Workers AI → `content.design`) | every new customer | older design system; not the Studio editor's format |
| "I'm starting fresh" starter (`site-starter.js`, no AI) | Studio without a key | clean but thin: hero, services, text, area, CTA |
| AI designer (owner's own Claude/OpenAI key) | owners who bring a key | richest (PoolThru): multi-section, composition, motion |

Most customers will never bring their own AI key, so most get the first two.

## Findings (by impact on bookings and trust)

1. **Thin, generic first screen.** The starter hero is the owner's typed headline, one short line and one button. On
   desktop about 40% of the first screen is empty padding. Phone number, service area, hours and "how booking works"
   are not on the first screen. For home services, a visible phone number and area are basic trust and conversion
   signals.
2. **Imagery doesn't fit, or isn't there.** The library has 20 CC0 photos. All trades (electrician, plumber, HVAC,
   roofer) share 4 "tools" photos. An electrician gets antique hand tools (axes, ice tongs). Wellness and professional
   businesses have no photos, so the hero's right half is empty and looks unfinished rather than deliberately text-led.
3. **Sparse page structure.** Home = hero › services › text › area › CTA. Service cards without descriptions show as
   near-empty boxes. There's no "how booking works", FAQ, hours, or what-to-expect section, although the records hold
   most of that (policies, hours, towns, appointment mode).
4. **Phone composition on AI designs.** PoolThru on phones puts the photo between the two buttons, so "See services"
   is split from "Book". The cause is the composition's derived phone order.
5. **The onboarding path doesn't produce a Studio site.** New customers start in the older format. Studio editing,
   section controls and later improvements apply poorly to it, and the format split doubles the work.
6. **Compatibility.** Live sites render per request; #68's goldens now flag any change. A golden change for an
   existing content system needs the renderer-versioning step proposed in docs/STATUS.md before it ships.

## The three highest-impact improvements (proposed; approval before building)

### 1. One conversion-first site for every new customer (biggest lever)

- **What:** onboarding produces the Studio (`content.site`) format, built from records with a complete, proven structure:
  - **first screen:** headline, area and phone, with "Book online" and "Call" side by side, plus a one-line booking
    promise ("Pick a time online in about a minute");
  - service cards with descriptions and prices from the records;
  - "How booking works" in 3 steps;
  - hours and service area;
  - FAQ from the records (policies, appointment mode);
  - final booking CTA.
- **How:** AI writes prose only, as today (claims and invented-number filters apply). With no AI available, the
  deterministic starter fills the same structure.
- **Retires:** the older onboarding format for NEW sites only; existing sites are untouched.
- **Measure:** first-screen checks extended (phone and area visible; the two CTAs adjacent on phone), goldens for new
  fixtures only, plus a before/after screenshot set per industry.
- **Size:** medium. site-starter + onboarding website step + design-checks; no migration.

### 2. Imagery that fits — or a text-led design that looks intentional

- **What:**
  - Split "trades" photos by trade (electrical, plumbing, HVAC, roofing, painting, handyman): about 12 new CC0 photos,
    vetted like the current library (no people, no logos).
  - Add photos for wellness and professional.
  - When no fitting photo exists, use a full-width typographic hero with service chips and an accent panel instead of
    a half-empty grid.
  - Ask for 3 photos of your own work during onboarding (owner photos always beat stock), with a phone-camera
    shortcut.
- **Measure:** a per-industry screenshot review; a fixture with no photo must fill the first screen.
- **Size:** small to medium (assets plus one hero variant).

### 3. Targeted section editing ("Improve this section") + phone composition rules

- **What:**
  - In Studio's section bar, rewrite ONE section (tone, length, or a free instruction) through the existing pipeline
    (`validateSpec` → design-checks). Every other section is byte-identical (asserted by test), with undo as today.
  - Uses the owner's key; the included model only if approved.
  - Fix phone ordering so a composition's buttons stay together and media follows them (PoolThru case).
- **Size:** medium. A designer action scoped to one section id, plus a composition phone-order rule. Published sites
  change only on publish. Any renderer CSS change for the phone rule goes through goldens and renderer versioning.

## Not recommended now

- More templates or palettes: they don't fix structure, imagery or conversion.
- Rewriting the renderer or data model: the spec/validator/renderer split is sound; improve what it is fed.
