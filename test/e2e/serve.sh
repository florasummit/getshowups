#!/usr/bin/env bash
# Starts the full site (static build + Pages Functions on workerd) for Playwright.
# Uses throwaway local D1/KV state and FAKE credentials only. Never production secrets.
set -euo pipefail
cd "$(dirname "$0")/../.."
source test/e2e/fixtures.env

STATE=.wrangler/e2e-state
OUT=.wrangler/e2e-dist

# Empty booking URL (even if .env.local sets one) so the default build is deterministic.
VITE_GHL_BOOKING_URL= npx vite build --outDir "$OUT" --emptyOutDir --logLevel warn

rm -rf "$STATE"
for migration in migrations/*.sql; do
  npx wrangler d1 execute ONBOARDING_DB --local --persist-to "$STATE" \
    -c test/e2e/wrangler.e2e.toml --file "$migration" >/dev/null
done

# Seed fake data (hashes only for sessions):
#   e2e-pool  — fully set up, Google "connected" (encrypted fake token for the mock), one past booking
#   e2e-other — business created, calendar not connected yet
hash() { node -e "process.stdout.write(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$1"; }
NOW=$(node -e 'process.stdout.write(String(Date.now()))')
FAR=$((NOW + 86400000))
PAST=$((NOW - 172800000))
d1() { npx wrangler d1 execute ONBOARDING_DB --local --persist-to "$STATE" -c test/e2e/wrangler.e2e.toml --command "$1" >/dev/null; }
d1 "
  INSERT INTO customers (id, name, timezone, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_CUSTOMER', '$E2E_CUSTOMER_NAME', 'America/New_York', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW),
    ('$E2E_OTHER_CUSTOMER', '$E2E_OTHER_CUSTOMER_NAME', 'America/Los_Angeles', '09:00', '17:00', '1,2,3,4,5', NULL, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES
    ('$E2E_USER_EMAIL', '$E2E_CUSTOMER', $NOW), ('$E2E_OTHER_USER_EMAIL', '$E2E_OTHER_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES
    ('$(hash "$E2E_SESSION_TOKEN")', '$E2E_USER_EMAIL', $NOW, $FAR),
    ('$(hash "$E2E_LOGOUT_SESSION_TOKEN")', '$E2E_USER_EMAIL', $NOW, $FAR),
    ('$(hash "$E2E_OTHER_SESSION_TOKEN")', '$E2E_OTHER_USER_EMAIL', $NOW, $FAR);
  INSERT INTO customers (id, name, timezone, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_SPARE_CUSTOMER', 'E2E Spare Co', 'America/Chicago', '08:00', '18:00', '1,2,3,4,5', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-spare.example', '$E2E_SPARE_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES
    ('$(hash "$E2E_ADMIN_SESSION_TOKEN")', '$E2E_PLATFORM_ADMIN', $NOW, $FAR);
  INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES
    ('seed-lead-past', '$E2E_CUSTOMER', 'Pat Past', 'pat@example.net', '555-010-0100', 'Filter repair', 'booked', 'x', $PAST, $PAST);
  INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES
    ('seed-appt-past', '$E2E_CUSTOMER', 'seed-lead-past', $PAST, $((PAST + 3600000)), 'booked', 'seed-event', $PAST, $PAST);"

RECORD=$(K="$E2E_TOKEN_ENCRYPTION_KEY" C="$E2E_CUSTOMER" node --input-type=module -e "
  import { encrypt } from './server/google-oauth.js'
  const refreshToken = await encrypt({ TOKEN_ENCRYPTION_KEY: process.env.K }, 'mock-refresh-seeded')
  process.stdout.write(JSON.stringify({ customer: process.env.C, googleSub: 'seed', email: 'cal@e2e-pool.example',
    scope: 'openid email https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy',
    refreshToken, connectedAt: new Date().toISOString() }))")
npx wrangler kv key put "google:$E2E_CUSTOMER" "$RECORD" --binding GOOGLE_TOKENS --local --persist-to "$STATE" \
  -c test/e2e/wrangler.e2e.toml >/dev/null
SPARE=$(printf '%s' "$RECORD" | sed "s/\"customer\":\"$E2E_CUSTOMER\"/\"customer\":\"$E2E_SPARE_CUSTOMER\"/")
npx wrangler kv key put "google:$E2E_SPARE_CUSTOMER" "$SPARE" --binding GOOGLE_TOKENS --local --persist-to "$STATE" \
  -c test/e2e/wrangler.e2e.toml >/dev/null

exec npx wrangler pages dev "$OUT" --ip 127.0.0.1 --port "$E2E_PORT" \
  --compatibility-date 2026-11-08 --persist-to "$STATE" --show-interactive-dev-session=false \
  --d1 ONBOARDING_DB=e2e-onboarding --kv GOOGLE_TOKENS=GOOGLE_TOKENS \
  --binding GOOGLE_CLIENT_ID="$E2E_GOOGLE_CLIENT_ID" \
  --binding GOOGLE_CLIENT_SECRET=e2e-fake-client-secret \
  --binding GOOGLE_REDIRECT_URI="http://127.0.0.1:$E2E_PORT/api/google/oauth/callback" \
  --binding TOKEN_ENCRYPTION_KEY="$E2E_TOKEN_ENCRYPTION_KEY" \
  --binding ADMIN_API_TOKEN="$E2E_ADMIN_API_TOKEN" \
  --binding GOOGLE_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding PLATFORM_ADMIN_EMAILS="$E2E_PLATFORM_ADMIN"
