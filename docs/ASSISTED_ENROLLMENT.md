# Assisted enrollment (founder- and representative-led sign-up)

Code: `server/enrollment.js`, `server/roles.js`, `server/staff-context.js`, `server/enrollment-hooks.js`, routes
`/api/sales/{me,roles,enrollments}` and `/api/claim`, screens `src/admin/Enrollments.jsx` (Admin → Sales) and
`src/claim/Claim.jsx` (`/claim`). Migration `0047_assisted_enrollment.sql`. Tests: `test/assisted-enrollment.test.js`,
`test/e2e/enrollment.spec.js`.

It is one more way into the SAME systems as self-service: the business is created by `createCustomer`, billed through
the ordinary `createCheckout` and Stripe webhook, configured through the ordinary dashboard routes and setup screens,
and handed over through the ordinary account invitation (`server/accounts.js`). Public sign-up stays exactly as closed
as it is: nothing here opens an enrollment path to the public.

## Roles (server/roles.js)

| Role | Comes from | May |
| --- | --- | --- |
| Platform admin | `PLATFORM_ADMIN_EMAILS` (unchanged) | everything; grant/revoke staff roles; assign enrollments |
| Sales representative | `commercial_roles` row (`sales_rep`) | only enrollments assigned to them: view, edit, workspace, payment link, setup, invitation, abandon |
| Onboarding | `commercial_roles` row (`onboarding`) | any enrollment before its handoff: view, setup, invitation. Never payment, assignment or roles |

`rolesOf(env, email)` and `requireRole(request, env, roles, { write })` read roles on every request (no cache): a
revocation or reassignment takes effect on the next request. A role never makes anyone a business member, and
membership never grants a role. Reps and onboarding see only Admin → Sales; every other admin route keeps answering 403
(`requirePlatformAdmin` is unchanged). Affiliates/partners have no login. Grants/revocations are audited
(`commercial.role_granted` / `commercial.role_revoked`). Before 0047 only platform admins have a role.

## The call, step by step (one screen: Admin → Sales)

1. **Prospect**: business name, owner name and email, phone, plan, time zone, notes. Every field refuses anything that
   looks like a card number (`looksLikeCard`: 13–19 digits) before it is stored.
2. **Create workspace**: `createCustomer` with NO owner membership and a `self_signups` row for the chosen plan, so the
   business is an unpaid self-serve business: hosting `unpaid` (no public website, not bookable, no paid tools:
   `server/eligibility.js`), provider spend blocked (`assistedUnpaid` in `server/business-accounts.js`: no paid
   receptionist/ads), and staff can't start AI website generation before payment. The phone said on the call goes into
   the business details. Attribution: `server/enrollment-hooks.js` `attributeAssisted` (seam for stream C's
   `recordAttribution`; channel `sales_rep` or `founder`).
3. **Payment link**: `createCheckout(..., { assisted })`: Stripe customer first (idempotency key), duplicate-subscription
   refusal, open-session reuse, `sandboxCheckoutAllowed` and live rules all unchanged. Stripe's page shows price and
   monthly billing; the submit button carries the recurring authorization ("…charge the price shown above … every
   month … until you cancel …"); `STRIPE_CHECKOUT_TERMS=true` adds Stripe's terms-of-service consent checkbox (needs a
   Terms URL in the Stripe Dashboard first). The representative copies the link or emails it (outbox + launch gate).
   Checkout returns to `/claim?paid=1|0` (the owner has no account yet).
4. **Paid**: ONLY the verified Stripe webhook (`handleEvent` → `syncEnrollmentFor`). The enrollment view re-derives the
   stage from the stored subscription; there is no "mark paid" action. Payment lifts the restrictions through the
   existing hosting logic.
5. **Set up**: "Open setup" opens `/dashboard?enrollment=<id>` = the owner's own setup screens in configure mode
   (`server/staff-context.js`): the staff member's own session plus the enrollment id (header `X-GSU-Enrollment`; reads
   may also name it in `?enrollment=` or the tab's `__Host-gsu_staff` cookie so previews and images show the business).
   Checked on every request: role, assignment, stage (not claimed/abandoned), route allowlist (`STAFF_PATHS`: setup,
   settings, website, receptionist settings). Every staff write is audited (`enrollment.staff_write`, route + role).
   Refused in configure mode: billing, people, export, deletion, AI keys, ads, domains, leads/appointments, finishing
   onboarding, turning the receptionist on (the owner's decisions), connecting a Google Calendar (the owner connects
   their own from a single-use link the setup screen creates).
6. **Ready to hand off?**: the same definitions as self-service: onboarding steps (`progress`), launch readiness
   (`readiness`), setup check (`setupCheck`), plus payment, invitation and phone (`phoneHook`: "Phone: not available
   yet" until the telephony module is connected). Required before the invitation: paid, business details, services,
   booking hours.
7. **Ownership invitation**: `issueInvite(..., { kind: 'claim' })`: the existing single-use, hashed, 7-day,
   revocable, resendable invitation bound to business + owner email, emailed through the outbox (`ownership_invite`)
   and shown as a link for the call. The ordinary `?invite=` acceptance refuses it (`claim_required`) so the terms can't
   be skipped.
8. **Claim** (`/claim`): the owner signs in (Google today; stream A's email sign-in plugs into `SignInChoice`). The
   signed-in VERIFIED email must equal the invited one ("You're signed in as X. This invitation is for Y" + switch
   account, never a claim). An email that already owns a business is told so; nothing is merged. Terms accepted
   (`CLAIM_TERMS_VERSION` + time recorded), then ONE batch: enrollment claimed + owner row in `customer_users` +
   invitation used (+ onboarding finished when every other step is done). Staff access ends (`assignment_closed_at`).
   Audited (`enrollment.claimed`, actor type owner). The owner lands on `/dashboard` at the first step not done (usually
   connecting their calendar), never repeating what staff did.

## Abandoned and unpaid

An unpaid enrollment older than `ABANDON_AFTER_DAYS` (14, `server/enrollment.js`) is shown as "Unpaid, maybe
abandoned". Staff can send a new payment link (reopens it) or mark it abandoned (revokes a pending invitation). Nothing
is deleted automatically; the unpaid workspace costs nothing (no hosting, no provider spend, no AI).

## Switches

- `STRIPE_CHECKOUT_TERMS` (off unless exactly `true`): ask for Stripe's terms consent on assisted checkouts. Needs a
  Terms of Service URL configured in the Stripe Dashboard (approval).
- No switch opens anything to the public. Phone card entry is NOT built (docs/PHONE_PAYMENTS.md).

## Approvals still needed

- Apply migration 0047 to production (before merging).
- A Terms of Service page for `/claim` and Stripe (today the claim lists the handoff terms and links the privacy policy).
- Retention period for prospects that never became a workspace (docs/DATA_RETENTION.md).
- Live billing (`STRIPE_LIVE_ENABLED`): until then payment links work only for testers/test businesses, as today.
