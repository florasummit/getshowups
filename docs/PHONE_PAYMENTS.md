# Taking payment on a sales call (research, 2026-11-26)

Decision built today: the owner pays on a **Stripe-hosted Checkout page** from a personalized link the representative
copies or emails during the call (docs/ASSISTED_ENROLLMENT.md). Card numbers, expiry dates and CVCs never enter
GetShowUps: not our pages, servers, logs, notes or AI. Card entry by our staff over the phone (MOTO) is **not built and
stays disabled**; no code accepts card data.

Sources: Stripe's public help and docs pages, read 2026-11-26. Recheck the account's Dashboard compliance settings and
terms before relying on any of this.

## What Stripe says about phone (MOTO) payments

| Question | Finding | Source |
| --- | --- | --- |
| Available by default? | No. Phone/mail payments (Dashboard manual entry, API MOTO, Terminal MOTO) must be requested from Stripe support and enabled on the account. | [Manually entered card payments](https://support.stripe.com/questions/manually-entered-card-payments), [When to categorize as MOTO](https://support.stripe.com/questions/mail-order-telephone-order-(moto)-transactions-when-to-categorize-transactions-as-moto) |
| Dashboard "virtual terminal" | Staff can type a card into the Stripe Dashboard once enabled; such payments are marked MOTO automatically. Stripe positions it for exceptional cases, not routine processing. | [Manually entered card payments](https://support.stripe.com/questions/manually-entered-card-payments), [Virtual terminal](https://stripe.com/resources/more/what-is-a-virtual-terminal) |
| PCI scope | Hosted Checkout / Payment Links keep us at the lightest level (SAQ A: no card data in our environment). Dashboard manual entry moves us to **SAQ C-VT** (limited, non-recurring use; storing card data electronically is prohibited; Stripe can't verify how card data is handled outside Stripe, so protecting it is our responsibility). Card data through our own servers or form would be SAQ D territory. Stripe describes an SAQ A route only where a third-party phone-capture service sends the digits straight to Stripe and the merchant never hears/sees them. | [PCI compliance guide](https://stripe.com/guides/pci-compliance), [What is PCI compliance?](https://support.stripe.com/questions/what-is-pci-compliance), [Manually entered card payments](https://support.stripe.com/questions/manually-entered-card-payments) |
| Fees | Manually entered (MOTO) card payments cost more (US standard: 3.4% + $0.30 vs 2.9% + $0.30). For a subscription only the first, manually entered payment carries the MOTO rate. | [Manually entered card payments](https://support.stripe.com/questions/manually-entered-card-payments) |
| SCA / 3D Secure | MOTO is outside SCA: no customer authentication happens, so there is no 3DS liability shift; fraud and "I didn't authorize this" disputes stay with the merchant. | [Strong Customer Authentication](https://stripe.com/guides/strong-customer-authentication), [Card-not-present transactions](https://stripe.com/resources/more/what-are-card-not-present-transactions) |
| Saving the card for recurring charges | Supported (e.g. Terminal MOTO "save directly"), but we would need the customer's recorded agreement to future charges ourselves (amount, frequency, cancellation), since they never see a Stripe page. | [Save a card with MOTO for future payments](https://docs.stripe.com/terminal/features/mail-telephone-orders/save-directly) |

## Why the hosted link, and what MOTO would add

The hosted link gives us: SAQ A scope, Stripe's own price/frequency display, 3DS where the bank asks for it (liability
shift), the customer's own action as the authorization (plus our authorization text on the submit button and optional
Stripe terms consent, `STRIPE_CHECKOUT_TERMS`), the standard fee, and nothing new to secure. It works on a call: the
owner opens the link on their phone while the representative waits, and "Paid" appears when Stripe's webhook arrives.

Turning on MOTO would add: a Stripe enablement request; SAQ C-VT (annual self-assessment, staff training, a rule that
no one writes digits down, call recording must not capture card numbers); higher fees on the first payment; dispute
liability without 3DS; and our own recorded recurring-charge consent. None of that is needed for the product as sold.

## If the founder ever wants it (approval items, nothing built)

1. Ask Stripe to enable Dashboard manual entry (or a SAQ A phone-capture provider); decide who may use it.
2. Complete SAQ C-VT; written card-handling procedure; no call recording of card digits.
3. Recorded consent script for recurring charges (price, monthly, how to cancel), stored with the enrollment.
4. Even then, entry happens in Stripe's Dashboard, never in GetShowUps; GetShowUps keeps learning "paid" only from
   the verified webhook.
