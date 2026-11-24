# Rotating TOKEN_ENCRYPTION_KEY

Protects: stored Google, Ads, Meta and GoHighLevel credentials (KV), owner AI keys and texting account tokens (D1), click ids,
and the signature of links in customer messages. Code: withEitherKey (server/google-oauth.js), server/rekey.js.
Tested with synthetic data in test/rekey.test.js. **Never yet performed in production.** Every step is an owner approval.

When: suspected exposure (now), a departing person with access, otherwise yearly.

1. Keep the current key value offline (password manager). Without it there is no way back.
2. New key: `openssl rand -base64 32`. In Cloudflare: TOKEN_ENCRYPTION_KEY_PREVIOUS = the current value, then
   TOKEN_ENCRYPTION_KEY = the new value. Deploy once. Both keys now read; only the new one writes.
3. Check a booking page shows times (it reads a calendar credential).
4. `POST /api/admin/rekey` with the admin token. Expect `unreadable: 0`; run again, expect `rewritten: 0`.
5. Leave the previous key for 30 days: links already sent to customers are signed with it.
6. Delete TOKEN_ENCRYPTION_KEY_PREVIOUS, deploy, repeat step 3.

Roll back before step 4: swap the two values and deploy. After step 4: swap, deploy, run rekey again.
If the key is lost: businesses reconnect Google; links in old messages stop working; nothing else is lost.
Other secrets (GOOGLE_CLIENT_SECRET, ADMIN_API_TOKEN, CRON_SECRET, provider keys) hold no stored data: create the new value
at the provider, set it, deploy, check, then revoke the old one. CRON_SECRET must change in the scheduler Worker too.
