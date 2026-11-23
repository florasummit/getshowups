# Enterprise organizations: design (not built)

Status 2026-11-23: design only. Enterprise is sold by agreement (pricing → Contact sales → a lead of the `getshowups`
business, server/enterprise.js). No organization code, table or migration exists. Nothing here may be described to
customers as live.

## What the current model supports

- One business = one `customers` row = one tenant. Every record, connection, limit and billing row hangs off its id.
- `customer_users.email` is the PRIMARY KEY: **one sign-in email belongs to exactly one business, with one role
  (owner)**. `requireSession()` resolves `session.customer` from it and dashboard routes take no customer parameter.
  This is the isolation guarantee, and the reason one person cannot switch between businesses today.
- Google Calendar (KV) and Ads (`ad_connections`, KV `ads:*`) connections are already per business and independent.
- `subscriptions.customer` is the primary key: one Stripe subscription per business. Complimentary and test account
  types exist (0034); consolidated billing does not.
- `audit_log` is append-only and hash-chained, with actor and resource. Deletion works per business.

So many separate workspaces work today, each with its own sign-in email. A parent organization can be added **above**
`customers` with new tables only; no tenant table needs to change.

## Proposed model (additive tables)

| Table | Holds |
| --- | --- |
| `organizations` | id, name, status, plan (`enterprise`), account limit from the contract |
| `organization_businesses` | customer (PK: at most one organization per business), organization, added_at, added_by |
| `organization_users` | (organization, email) PK, role, invited_by, status |
| `organization_grants` | (organization, email, customer) PK: which businesses a delegated admin may open, and the permission |

**Owner and delegated admins.** Roles: `owner` (members, businesses, billing; at least one always remains), `admin`
(all businesses, no billing or ownership), `manager` (granted businesses only), `viewer` (granted businesses, read
only). Invitations reuse the single-use, email-bound pattern in server/accounts.js.

**Business access.** `customer_users` stays the direct-owner path, unchanged. A workspace switch is a server-side
choice stored on the session row and re-checked against `organization_businesses` + grants on **every** request, so
removal takes effect immediately. Dashboard routes keep taking no customer parameter. `requireSession()` gains the
permission, and writes state the one they need (fail closed). Platform-admin access stays separate.

**Independent connections.** Google Ads and Calendar stay per business, connected by consent at that business. The
organization never holds or shares a token. Disconnecting one business never revokes a grant another still uses
(`revokeUnlessInUse`). Ads budgets and holds stay per business. A Google Ads manager account is a later option.

**Consolidated reporting.** A read-only sum of the existing per-business definitions (server/ads/funnel.js,
server/revenue.js), computed over the businesses the viewer may see. Counts and money only, no customer contact
details; missing data stays null; test businesses excluded. Large organizations need a cron rollup within D1 limits.

**Consolidated billing.** One Stripe customer and subscription per organization in a new `organization_billing`
table, applied by verified webhook. `hostingStatus()` would return the organization's standing for its businesses,
never both (a business with its own running subscription must end it first). Usage and ad spend stay out unless
contracted. Failed payment follows the existing hold rules. Until then, contracts are invoiced by hand.

**Audit and removal.** Every membership, grant, switch, business add/remove and billing change uses `audit()` with the
organization as resource. Removing a person ends their access and sessions. Removing a business **detaches** it
(workspace, data and connections stay with its owner; billing moves by agreement). Ending an organization detaches
all businesses and deletes nothing; deletion stays the gated per-business workflow. New tables join `ERASED_TABLES`
or the retention list.

## Order of work, and decisions needed first

1. Tables + membership + audited workspace switch (tests: cross-organization and revoked-access isolation on every
   dashboard route). 2. Delegated roles. 3. Reporting. 4. Billing.

Founder decisions: who owns a business's data when it leaves; whether an organization may connect a calendar on a
business's behalf; per-business versus flat pricing; contracted support terms; legal terms for agencies.
