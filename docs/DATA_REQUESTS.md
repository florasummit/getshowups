# Handling privacy requests (access / deletion)

The privacy policy (https://getshowups.com/privacy) promises that people can email brandon@getshowups.com to access or
delete their information. There is no self-service tool: requests are handled manually with the steps below.

Rules
- Verify the requester first: reply to the address on record (or have the business owner confirm) before sharing or
  deleting anything. Never send someone else's data to a new address.
- Work only from your own terminal. Do not paste results (emails, phones, names) into tickets, chat, or AI tools.
- Every `--remote` write is a production change: take a backup first (step 0) and double-check the `WHERE` clause.
- Reply to the requester when done (target: within 30 days) and keep a short note of the date and what was removed,
  without copying the personal data itself.

Setup: `cd ~/getshowups` (wrangler is logged in as brandon@getshowups.com).
Shorthands used below:

```bash
DB=getshowups-onboarding
KV=91c042f5aa7a40c0bc5203496a21b05b        # GOOGLE_TOKENS namespace
q() { npx wrangler d1 execute "$DB" --remote --command "$1"; }
```

## 0. Back up before deleting

```bash
npx wrangler d1 time-travel info "$DB"     # note the bookmark; restore with: time-travel restore --bookmark=...
```

## A. A person who booked through a business's booking page

They are identified by email (or phone). Find their records:

```bash
EMAIL='person@example.com'                 # lowercase
q "SELECT id, customer, name, status, datetime(created_at/1000,'unixepoch') AS created FROM leads WHERE lower(email)='$EMAIL';"
q "SELECT a.id, a.customer, datetime(a.start_at/1000,'unixepoch') AS start, a.status, a.google_event_id
   FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE lower(l.email)='$EMAIL';"
q "SELECT id, template, status FROM email_outbox WHERE lower(to_email)='$EMAIL';"
```

Access request: export the rows above and send them to the verified requester.

Deletion request:

```bash
q "DELETE FROM messages WHERE lead_id IN (SELECT id FROM leads WHERE lower(email)='$EMAIL');"
q "DELETE FROM sms_consents WHERE lead_id IN (SELECT id FROM leads WHERE lower(email)='$EMAIL');"
q "DELETE FROM appointment_confirmations WHERE appointment_id IN (SELECT a.id FROM appointments a JOIN leads l ON l.id = a.lead_id WHERE lower(l.email)='$EMAIL');"
q "DELETE FROM appointments WHERE lead_id IN (SELECT id FROM leads WHERE lower(email)='$EMAIL');"
q "DELETE FROM events WHERE id IN (SELECT 'lead:' || id FROM leads WHERE lower(email)='$EMAIL');"
q "DELETE FROM leads WHERE lower(email)='$EMAIL';"
q "DELETE FROM email_outbox WHERE lower(to_email)='$EMAIL';"
```

- Calendar events: the appointment also exists as an event on the business's own Google Calendar (title
  "<name>: <need>", id `gsu<appointment id>`). That calendar belongs to the business: ask the business to delete the
  event(s), and tell the requester you have done so.
- Analytics rows (`events`) contain no contact details; the `lead:` rows are removed above for completeness.

## B. A business owner closing their account (full deletion)

Find the business id from the owner's email:

```bash
OWNER='owner@example.com'
q "SELECT customer FROM customer_users WHERE email='$OWNER';"
CUST='business-id'                          # e.g. poolthru-llc
q "SELECT id, name, status FROM customers WHERE id='$CUST';"
q "SELECT
   (SELECT count(*) FROM customer_users WHERE customer='$CUST') users,
   (SELECT count(*) FROM leads WHERE customer='$CUST') leads,
   (SELECT count(*) FROM appointments WHERE customer='$CUST') appts,
   (SELECT count(*) FROM subscriptions WHERE customer='$CUST') subs;"
npx wrangler kv key list --namespace-id "$KV" --remote --prefix "google:$CUST"
npx wrangler kv key list --namespace-id "$KV" --remote --prefix "google-archive:$CUST:"
```

Deletion, in this order:

1. Billing: if `subscriptions` has a row, cancel the subscription and delete the customer in the Stripe dashboard first.
2. Google access: the owner can remove "GetShowUps" at https://myaccount.google.com/connections. Then delete our
   stored connection (this deletes our copy; it does not affect other businesses):
   ```bash
   npx wrangler kv key delete "google:$CUST" --namespace-id "$KV" --remote
   # and each google-archive:$CUST:<time> key listed above
   ```
   Do not revoke a token on the owner's behalf if the same Google account also connects another active business
   (revoking can end that business's access too).
3. Database rows:
   ```bash
   q "DELETE FROM messages WHERE customer='$CUST';"
   q "DELETE FROM sms_consents WHERE customer='$CUST';"
   q "DELETE FROM appointment_confirmations WHERE customer='$CUST';"
   q "DELETE FROM customer_settings WHERE customer='$CUST';"
   q "DELETE FROM appointments WHERE customer='$CUST';"
   q "DELETE FROM leads WHERE customer='$CUST';"
   q "DELETE FROM email_outbox WHERE customer='$CUST';"
   q "DELETE FROM account_invites WHERE customer='$CUST';"
   q "DELETE FROM onboarding_invites WHERE customer='$CUST';"
   q "DELETE FROM subscriptions WHERE customer='$CUST';"
   q "DELETE FROM events WHERE customer='$CUST';"
   q "DELETE FROM sessions WHERE email IN (SELECT email FROM customer_users WHERE customer='$CUST');"
   q "DELETE FROM customer_users WHERE customer='$CUST';"
   q "DELETE FROM customers WHERE id='$CUST';"
   ```
   `admin_audit` is kept as the security record of admin actions (it holds no lead contact details).
4. Verify: re-run the counts query above (all 0) and the KV listings (empty).

## What remains after deletion

- D1 Time Travel keeps point-in-time history (7 days on the Workers Free plan, 30 days on Paid), then it ages out.
- Local backup exports in `~/getshowups-backups/` (delete any that contain the person's data).
- Cloudflare request logs (short retention, no form contents).
- Copies outside GetShowUps: the business's Google Calendar and any emails Google sent.
- Delivered messages: Resend (email) and Twilio (text) keep their own delivery logs for their retention period.
