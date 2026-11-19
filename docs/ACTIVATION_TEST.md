# Real-person 20-minute activation test (sandbox) — script

Primary acceptance criterion (docs/LAUNCH_READINESS.md §2a): a nontechnical owner who has never seen GetShowUps goes
from "Get started" to a **published website and a confirmed test booking on their own Google Calendar in ≤ 20 min**,
unassisted, on their own device. Status: **prepared, not run.** Run it after the #80–#82 release.

## Before the session (approvals marked ⚠)

| # | Step | Who |
| --- | --- | --- |
| P1 | Tester: has never seen GetShowUps; uses their own Google account and phone or laptop; agrees in writing to screen recording | Owner |
| P2 | Business: one they can describe honestly, or a clearly fictional one. **Never a real customer's business** | Owner |
| P3 | ⚠ Add the tester's email to `MESSAGE_TEST_RECIPIENTS` (lets their sandbox checkout through and lets the confirmation reach them; nobody else). Redeploy to apply | Owner approval |
| P4 | Stripe stays in test mode; give the tester test card 4242 4242 4242 4242, any future date, any CVC | Observer |
| P5 | Observer prepares: stopwatch, the sheet below, `/admin/review` open in a separate window (not visible to the tester) | Observer |

**This run is permitted test onboarding, not public signup.** Genuine public signup stays closed throughout: the
tester gets through only because their email is on the approved test list (sandbox checkout allowed by
`sandboxCheckoutAllowed`, test card, Stripe test mode). Nothing is changed for anyone else, and the result must never
be reported as "signup works for the public". Observer control check, before and after the session, from a
browser that is NOT signed in as the tester: `/api/enrollment` returns `{"open":false}`, and the home page buttons
read "Request early access". A second, non-listed Google account at `/dashboard?plan=founding` must still be told
"Online sign-up opens soon" at the plan step (no business created: `signup_not_open`).

**Known skew while enrollment is closed:** the public site shows "Request early access" to everyone (it can't know the
tester is allowed), and `/dashboard?plan=founding` says enrollment isn't open, with "Continue with Google" below.
Give the tester the link `https://getshowups.com/dashboard?plan=founding` and the one sentence "sign in with Google
there"; record T1 as not representative. Once live billing opens, rerun T1 from the home page.

The observer does not help unless the tester is stuck > 2 minutes, then gives the smallest hint and logs it.

## Timer sheet (start the clock when the tester first sees getshowups.com)

| Step | What the tester does | Done when | Split (mm:ss) | Help? | Hesitations / words used |
| --- | --- | --- | --- | --- | --- |
| T1 | Finds and clicks the sign-up button | Google sign-in screen shown | | | |
| T2 | Google sign-in | Back on GetShowUps, asked for business name | | | |
| T3 | Business name → plan → sandbox checkout (test card) | Payment step done | | | |
| T4 | Details, services (+ prices), service ZIPs | Calendar step shown | | | |
| T5 | Connects Google Calendar (including Google's "unverified app" screen — J-2) | "Calendar connected" | | | |
| T6 | Booking hours | Hours confirmed | | | |
| T7 | Website: "I'm starting fresh" (or import), previews | Preview seen | | | |
| T8 | Address step | Done | | | |
| T9 | Publishes (confirmation) | Live site link shown | | | |
| T10 | Opens their own site on a phone, books a time as a customer | Booking confirmed on screen | | | |
| T11 | Finds the event on their Google Calendar | Event seen — **stop the clock** | | | |
| | **Total** | target ≤ 20:00 | | count | |

## Evidence to collect (no customer data in notes)

- Screen recording (tester's consent), the filled sheet, total time, number of hints.
- `/admin/review` for the new business: open incidents during the run (should be none), the onboarding checklist.
- Booking: appointment created (admin detail shows counts only); the Google event exists (tester confirms).
- Confirmation email: did it arrive in the tester's inbox, and how long after booking (target: within a minute,
  immediate dispatch in #81)? With founder alerts on (separate approval), whether any alert fired.
- Exact copy that confused the tester (their words), any error message shown (code + screen).

## Recovery observations (do these only if they happen naturally; never force a failure on a real account)

| Situation | What to note |
| --- | --- |
| Tester closes the tab or the phone sleeps mid-setup | Did reopening /dashboard resume at the right step? Anything re-asked? |
| Google sign-in cancelled or wrong account picked | Was the error clear, did "try again" work? |
| Calendar consent: unverified-app warning | Did they continue? Time spent on that screen |
| Browser Back during Studio/onboarding | Did they lose work? (#80: Back closes panels/full screen first) |
| Checkout abandoned and retried | Did it resume the open session (no second charge attempt)? |

## After the session

1. Admin marks the business **test** (`/admin` → business → Mark test; audited) so it stays out of metrics and
   live operations. Do not delete it.
2. ⚠ Remove the tester's email from `MESSAGE_TEST_RECIPIENTS` (approval) unless a second run is planned.
3. Fill §2a of docs/LAUNCH_READINESS.md with **measured** splits (keep targets separate); each confusion → a small PR.
4. Pass: total ≤ 20:00, zero hints, published site, booking on calendar. Otherwise: list the slowest two steps and fix.
