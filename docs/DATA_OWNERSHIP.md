# Data ownership: GetShowUps ↔ GoHighLevel

GetShowUps is the **source of truth**. GoHighLevel (GHL) is an optional, one-way **copy** a business
can turn on. GHL never becomes the customer-facing website, booking page, or dashboard.

## Who owns what

| Data | Owner | GHL gets |
| --- | --- | --- |
| Leads (name, email, phone, need, ZIP, service address) | GetShowUps | One contact per lead (upsert) |
| Bookings / appointments | GetShowUps (+ Google Calendar) | Opportunity stage `booked` only; no GHL appointment |
| Show-up and job outcomes, reported job value | GetShowUps | Opportunity stage + `monetaryValue` (self-reported, not revenue) |
| Email (confirmations, reminders, follow-ups) | GetShowUps | Nothing |
| SMS | GetShowUps by default; GHL workflow if owner sets `smsVia: 'ghl'` | Workflow enrollment once per lead |

Nothing is read back from GHL (Private Integration Tokens have no webhooks). Edits made in GHL do not
change GetShowUps records.

## Sync rules

- One contact and one opportunity per lead, tracked in `ghl_links`; retries never duplicate.
- Stage map (owner-chosen stage ids): new → booked → showed / noShow → completed.
  Status: open, open, open / lost, won.
- Workflow enrollment happens at most once per lead per workflow, and only for recipients allowed by
  the launch gate (`recipientAllowed()`), because a GHL workflow may text the lead.
- When `smsVia = 'ghl'`, `smsHandledByGhl()` is true and the GetShowUps scheduler must send **no** SMS
  for that business, so a lead never receives texts from both systems.
- Sync is best-effort: a GHL failure never blocks a lead, booking, or outcome in GetShowUps.

## Credentials and privacy

- Per-business PIT (sub-account scoped) stored AES-GCM encrypted in KV `ghl:<customer>`; the stored
  record carries its customer id and is ignored under any other key.
- GET `/api/dashboard/ghl` returns status and ids only, never the token. Saving verifies the token
  with one read call (pipelines) first; 401/403 → `invalid_token`.
- Logs and responses carry allowlisted error codes only: never the token or lead details.
- Disconnect deletes the KV record. Copies already in GHL stay there and are the business's own data
  in their GHL account; deleting them is done in GHL.

## Required GHL setup (per business)

- A sub-account Private Integration Token with scopes: `contacts.write`, `opportunities.write`,
  `opportunities.readonly`. Rotate every 90 days (reconnect in GetShowUps after rotation).
- A pipeline with five stages mapped to new / booked / showed / no-show / completed.
- Optional: a workflow (for SMS) whose trigger is enrollment by API.
