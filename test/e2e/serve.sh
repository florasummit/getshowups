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
#   e2e-auto  — set up; one unbooked lead (resume link) and one future booking (confirm link)
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
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_JOURNEY_CUSTOMER', 'E2E Journey Pools', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('$E2E_JOURNEY_EMAIL', '$E2E_JOURNEY_CUSTOMER', $NOW);
  INSERT INTO plans (id, name, stripe_price_id, trial_days, entitlements, active, created_at) VALUES
    ('founding', 'GetShowUps Founding', 'price_E2EFOUNDING', 0, '{}', 1, $NOW);
  INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES
    ('seed-lead-past', '$E2E_CUSTOMER', 'Pat Past', 'pat@example.net', '555-010-0100', 'Filter repair', 'booked', 'x', $PAST, $PAST);
  INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES
    ('seed-appt-past', '$E2E_CUSTOMER', 'seed-lead-past', $PAST, $((PAST + 3600000)), 'booked', 'seed-event', $PAST, $PAST);
  INSERT INTO customers (id, name, timezone, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_AUTO_CUSTOMER', 'E2E Auto Co', 'America/New_York', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES
    ('seed-lead-resume', '$E2E_AUTO_CUSTOMER', 'Riley Resume', 'riley@example.net', '555-010-0101', 'Pool opening', 'new', 'x', $NOW, $NOW),
    ('seed-lead-confirm', '$E2E_AUTO_CUSTOMER', 'Casey Confirm', 'casey@example.net', '555-010-0102', 'Leak check', 'booked', 'x', $NOW, $NOW);
  INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES
    ('0123456789abcdef0123456789abcdef', '$E2E_AUTO_CUSTOMER', 'seed-lead-confirm', $((NOW + 259200000)), $((NOW + 262800000)), 'booked', 'seed-event-2', $NOW, $NOW);
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_HOME_CUSTOMER', 'E2E Home Service', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO service_settings (customer, appointment_mode, updated_at) VALUES ('$E2E_HOME_CUSTOMER', 'at_customer', $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-home.example', '$E2E_HOME_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_HOME_SESSION_TOKEN")', 'owner@e2e-home.example', $NOW, $FAR);
  INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES
    ('seed-lead-visit', '$E2E_HOME_CUSTOMER', 'Val Visit', 'val@example.net', '555-010-0105', 'Green pool cleanup', '29403', 'booked', 'x', $PAST, $PAST),
    ('seed-lead-visit-2', '$E2E_HOME_CUSTOMER', 'Mo Mobile', 'mo@example.net', '555-010-0106', 'Filter check', '29403', 'booked', 'x', $PAST, $PAST);
  INSERT INTO lead_addresses (lead_id, customer, street, unit, city, state, zip, created_at) VALUES
    ('seed-lead-visit', '$E2E_HOME_CUSTOMER', '7 Harbor Way', '', 'Charleston', 'SC', '29403', $PAST),
    ('seed-lead-visit-2', '$E2E_HOME_CUSTOMER', '9 Marsh Rd', '', 'Charleston', 'SC', '29403', $PAST);
  INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES
    ('seed-appt-visit', '$E2E_HOME_CUSTOMER', 'seed-lead-visit', $PAST, $((PAST + 3600000)), 'booked', 'seed-event-3', $PAST, $PAST),
    ('seed-appt-visit-2', '$E2E_HOME_CUSTOMER', 'seed-lead-visit-2', $((PAST - 3600000)), $PAST, 'booked', 'seed-event-4', $PAST, $PAST);
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_ADS_CUSTOMER', 'E2E Ads Pools', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-ads.example', '$E2E_ADS_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_ADS_SESSION_TOKEN")', 'owner@e2e-ads.example', $NOW, $FAR);
  INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, updated_at) VALUES
    ('$E2E_ADS_CUSTOMER', 'cus_E2EADS', 'sub_E2EADS', 'founding', 'active', 49900, 'usd', $FAR, $NOW);
  INSERT INTO ad_profiles (customer, industry, services, service_area, customer_value_cents, monthly_budget_cents, updated_at) VALUES
    ('$E2E_ADS_CUSTOMER', 'Pool service', '[\"Weekly pool cleaning\"]', '{\"zips\":[\"29403\"]}', 30000, 30000, $NOW);
  INSERT INTO ad_budget_approvals (id, customer, monthly_cents, approved_by, approved_at) VALUES ('e2e-ads-budget', '$E2E_ADS_CUSTOMER', 30000, 'owner@e2e-ads.example', $NOW);
  INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('$E2E_ADS_CUSTOMER', 1, 'admin@e2e.example', $NOW);"

# One seeded Google connection per business (its own refresh token → its own mock calendar), like real
# businesses that each connect their own Google account.
record() {
  K="$E2E_TOKEN_ENCRYPTION_KEY" C="$1" node --input-type=module -e "
  import { encrypt } from './server/google-oauth.js'
  const refreshToken = await encrypt({ TOKEN_ENCRYPTION_KEY: process.env.K }, 'mock-refresh-seeded-' + process.env.C)
  process.stdout.write(JSON.stringify({ customer: process.env.C, googleSub: 'seed', email: 'cal@e2e-pool.example',
    scope: 'openid email https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy',
    refreshToken, connectedAt: new Date().toISOString() }))"
}
for C in "$E2E_CUSTOMER" "$E2E_SPARE_CUSTOMER" "$E2E_HOME_CUSTOMER" "$E2E_AUTO_CUSTOMER" "$E2E_ADS_CUSTOMER"; do
  npx wrangler kv key put "google:$C" "$(record "$C")" --binding GOOGLE_TOKENS --local --persist-to "$STATE" \
    -c test/e2e/wrangler.e2e.toml >/dev/null
done

exec npx wrangler pages dev "$OUT" --ip 127.0.0.1 --port "$E2E_PORT" \
  --compatibility-date 2026-11-08 --persist-to "$STATE" --show-interactive-dev-session=false \
  --d1 ONBOARDING_DB=e2e-onboarding --kv GOOGLE_TOKENS=GOOGLE_TOKENS \
  --binding GOOGLE_CLIENT_ID="$E2E_GOOGLE_CLIENT_ID" \
  --binding GOOGLE_CLIENT_SECRET=e2e-fake-client-secret \
  --binding GOOGLE_REDIRECT_URI="http://127.0.0.1:$E2E_PORT/api/google/oauth/callback" \
  --binding TOKEN_ENCRYPTION_KEY="$E2E_TOKEN_ENCRYPTION_KEY" \
  --binding ADMIN_API_TOKEN="$E2E_ADMIN_API_TOKEN" \
  --binding ADS_ENABLED=true \
  --binding ADS_BUSINESSES="$E2E_CUSTOMER,$E2E_HOME_CUSTOMER,$E2E_ADS_CUSTOMER,$E2E_JOURNEY_CUSTOMER" \
  --binding STRIPE_SECRET_KEY="$E2E_STRIPE_SECRET_KEY" \
  --binding STRIPE_WEBHOOK_SECRET="$E2E_STRIPE_WEBHOOK_SECRET" \
  --binding STRIPE_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding GOOGLE_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding GOOGLE_ADS_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding DNS_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding AI_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding PLATFORM_ADMIN_EMAILS="$E2E_PLATFORM_ADMIN"
