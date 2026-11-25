# Sales tax: accountant decision package (cover sheet)

> 2026-11-25: the plan is called Growth; website chat receptionist is advertised inside the $499 (F9 is partly answered).

Prepared 2026-11-19 for the owner to send to the accountant / tax attorney together with
[docs/SALES_TAX_ANALYSIS.md](SALES_TAX_ANALYSIS.md) (the full analysis, sources and labels). **Not tax advice.** No tax
has been registered, no live Stripe price exists, Stripe automatic tax is off. Labels are carried over unchanged:
**[VERIFIED]** official source read (or our own records), **[PRELIMINARY]** our reading or a secondary source,
**[OPEN]** needs the advisor or an owner fact.

## 1. Facts the owner must fill in before sending (none are recorded in the repo)

| # | Fact | Answer (owner) |
| --- | --- | --- |
| F1 | Legal entity name and type (the analysis assumes "Flora Summit LLC"; confirm) | |
| F2 | State and date of formation | |
| F3 | Principal operating address (where the business is run; becomes the Stripe Tax "head office") | |
| F4 | Every state where the owner, any employee or any contractor works for GetShowUps, and since when | |
| F5 | Any office, equipment or other property outside F3 | |
| F6 | Expected states of the first 10 customers (best guess) | |
| F7 | Whether any customer will use the plan at more than one location | |
| F8 | Planned launch month (relevant to California's 2027-01-01 change) | |
| F9 | Whether the AI receptionist (chat/voice), email/text messaging or ad management will be **inside** the $499 at launch or later (see §3) | |

## 2. What is being sold (from the product, [VERIFIED] against our code and public pricing on 2026-11-19)

One flat, **non-itemised** charge of **$499/month**, billed in advance via Stripe; no setup fee, no trial; buyers are
businesses buying for business use, anywhere in the US.

| Component | In the $499 today | Note |
| --- | --- | --- |
| Booking and lead software (hosted, same for every customer) | Yes | Core of the offer |
| Generated website (built by software from the owner's records; owner edits it) | Yes | No human design work |
| Website hosting (GetShowUps address or the owner's domain) | Yes | |
| Human support ("direct help from the founding team") | Yes | Not priced separately |
| Advertising management | No, advertised as "coming soon" | |
| Advertising spend | Never | Paid by the business directly to Google/Meta |
| Email/text reminders and follow-ups | No, advertised as "coming soon" | |
| AI receptionist (website chat, browser voice) | **Not advertised; built, and an owner can switch it on in the dashboard** | See §3; owner must decide F9 |

## 3. One inconsistency for the owner to resolve first

The analysis (§2 G) treats the AI receptionist as "not live and not in the plan". In the product it is built, appears as
a dashboard tab for every business, and the owner can switch it on themselves (it then adds a "Chat or talk with us"
link to their website). The draft Terms (§1) also list "chat and voice receptionist we host for you" as part of the
Service. If paying customers can use it inside the $499, the advisor should know (analysis §3 G: telecom-type taxes and
fees may apply to voice; **[OPEN]**). Decide F9, then either keep it out of paid plans at launch or tell the advisor it
is included.

## 4. Decisions already made by the owner (do not re-open)

| Decision | Date |
| --- | --- |
| No live price until tax treatment, jurisdictions and exclusive configuration are confirmed in writing | 2026-11-18 |
| **Tax-exclusive** pricing where legally applicable ($499 + tax where due); wording per Q9 | 2026-11-19 |
| Refund policy: **discretionary** (affects how refunds of collected tax are handled; Q12) | owner policy |

## 5. Positions to confirm or reject (analysis section in brackets)

| Topic | Current position | Label |
| --- | --- | --- |
| Classification | One SaaS product for business use; website, hosting, support integral (Option 1) (§4) | **[PRELIMINARY]** recommendation |
| SaaS taxability | Roughly 20 states + DC tax SaaS in some form; rules for business use vary (OH, CT 1%, IA, TX 80%) (§3 A) | **[PRELIMINARY]** |
| Website build | Software-generated, may be part of SaaS rather than a design service; WA taxes website development since 2025-10-01 (§3 B) | **[OPEN]** |
| Hosting | Usually not taxed alone; TX, MD, gross-receipts states differ (§3 C) | **[PRELIMINARY]** / CA **[OPEN]** |
| Bundling | SSUTA bundled-transaction rule vs "true object" test; CA rules pending (§4) | **[PRELIMINARY]** / CA **[OPEN]** |
| Physical nexus | Depends on F2–F5 (§1) | **[OPEN]** |
| Economic nexus | None reached: no live sales, all subscriptions sandbox (§1) | **[VERIFIED]** (own records) |
| Thresholds | 17 customers in one state reach $100k/yr; CA, TX, NY need 84 (§5) | Arithmetic; thresholds **[PRELIMINARY]** except CA **[VERIFIED]** |
| California from 2027-01-01 | SaaS becomes taxable as a digital product (SB 122, CDTFA L-1036) (§6) | Law **[VERIFIED]**; our plan taxable **[PRELIMINARY]**; bundle treatment **[OPEN]** (emergency regulations still being drafted) |
| Sourcing | Customer's address; CDTFA order: billing, shipping, payment instrument, mailing (§6) | CA **[VERIFIED]**; our choice **[OPEN]** |
| Ad spend | Outside our receipts while businesses pay Google/Meta directly (§3 F) | **[PRELIMINARY]** |

## 6. Questions needing WRITTEN answers (same numbering as analysis §8)

1. Given F1–F5, in which states do we have physical nexus today?
2. Is the plan one SaaS product (website, hosting, support integral) or a bundle? Is the generated website "design
   services" anywhere?
3. Is Option 1 (tax the whole $499 where SaaS is taxable) acceptable? If not, what allocation method and records hold up?
4. Treatment in OH, CT, IA, TX, MD, WA, NY, PA, HI, NM and the states in F6.
5. California: taxable from 2027-01-01? Do our sales count toward $500,000? Register before the first California sale?
   Bundles pending the emergency regulations?
6. Washington: anything taxable today (website development / digital automated service)? Effect of the reported 2029 repeal?
7. Which registrations at launch, which states to monitor, and is Stripe Tax threshold monitoring adequate given the
   differing measures?
8. Sourcing: billing vs service address; customers with several locations (F7); evidence to keep.
9. Tax-exclusive pricing: required disclosure wording on the pricing page, in the Terms and in Checkout.
10. If the AI receptionist (voice), messaging or ad management join the plan (F9), what changes? Separate line items?
11. Confirm ad spend stays outside our receipts.
12. Filing frequency and who files; exemption certificates; **how a discretionary refund affects tax already
    collected/remitted**; any voluntary disclosure (no live sales yet).
13. Income side: state income/franchise and gross-receipts taxes (WA B&O, OH CAT, TX franchise) from sales into those states.

## 7. What engineering does only after the written answers (nothing done now)

- Stripe Tax head office (F3), registrations only where the advisor says, threshold monitoring.
- One tax code chosen by the advisor (`txcd_10103001` SaaS – Business Use exists; `txcd_10701400` if hosting is split).
- Live price $499.00 USD monthly, `tax_behavior: exclusive` (cannot be changed after creation).
- Checkout: `automatic_tax[enabled]=true`, billing-address collection (we do not collect a billing address today),
  optional tax ID; one small PR with tests, deployed only with approval.
- Wording "plus applicable sales tax" on pricing page, Terms, Checkout (legal track).
- Existing sandbox subscriptions untouched.
