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
node scripts/build-info.mjs "$OUT" >/dev/null

rm -rf "$STATE"
# Every wrangler call starts a new process (seconds each), so the migrations go in ONE call (same files, same order)
# and the seed below is collected and applied once, just before the site starts. Startup grew with every migration.
SEED_SQL="$STATE.seed.sql"
SEED_KV="$STATE.kv.tsv"
: > "$SEED_SQL"
: > "$SEED_KV"
for migration in migrations/*.sql; do
  cat "$migration"
  printf '\n'
done > "$STATE.migrations.sql"
npx wrangler d1 execute ONBOARDING_DB --local --persist-to "$STATE" -c test/e2e/wrangler.e2e.toml --file "$STATE.migrations.sql" >/dev/null

# Seed fake data (hashes only for sessions):
#   e2e-pool  — fully set up, Google "connected" (encrypted fake token for the mock), one past booking
#   e2e-other — business created, calendar not connected yet
#   e2e-auto  — set up; one unbooked lead (resume link) and one future booking (confirm link)
hash() { node -e "process.stdout.write(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$1"; }
NOW=$(node -e 'process.stdout.write(String(Date.now()))')
FAR=$((NOW + 86400000))
PAST=$((NOW - 172800000))
d1() {
  local q="$1"
  q="${q%"${q##*[![:space:]]}"}" # trailing whitespace off; then end the block with exactly one semicolon
  [[ "$q" == *";" ]] || q="$q;"
  printf '%s\n' "$q" >> "$SEED_SQL"
}
# Fake Google token records for the GOOGLE_TOKENS KV namespace: collected (key, base64 value) and written in one bulk call.
kvput() { printf '%s\t%s\n' "$1" "$(printf '%s' "$2" | base64 | tr -d '\n')" >> "$SEED_KV"; }
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
    ('seed-lead-confirm', '$E2E_AUTO_CUSTOMER', 'Casey Confirm', 'casey@example.net', '555-010-0102', 'Leak check', 'booked', 'x', $NOW, $NOW),
    ('seed-lead-cancel', '$E2E_AUTO_CUSTOMER', 'Corey Cancel', 'corey@example.net', '555-010-0103', 'Filter repair', 'booked', 'x', $NOW, $NOW);
  INSERT INTO appointments (id, customer, lead_id, start_at, end_at, status, google_event_id, created_at, updated_at) VALUES
    ('0123456789abcdef0123456789abcdef', '$E2E_AUTO_CUSTOMER', 'seed-lead-confirm', $((NOW + 259200000)), $((NOW + 262800000)), 'booked', 'seed-event-2', $NOW, $NOW),
    ('fedcba9876543210fedcba9876543210', '$E2E_AUTO_CUSTOMER', 'seed-lead-cancel', $((NOW + 345600000)), $((NOW + 349200000)), 'booked', 'seed-event-3', $NOW, $NOW);
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
    ('$E2E_DESIGN_CUSTOMER', 'E2E Design Pools', 'America/New_York', '', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW),
    ('$E2E_DESIGN_M_CUSTOMER', 'E2E Design Pools', 'America/New_York', '', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-design.example', '$E2E_DESIGN_CUSTOMER', $NOW), ('owner@e2e-design-m.example', '$E2E_DESIGN_M_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_DESIGN_SESSION_TOKEN")', 'owner@e2e-design.example', $NOW, $FAR), ('$(hash "$E2E_DESIGN_M_SESSION_TOKEN")', 'owner@e2e-design-m.example', $NOW, $FAR);
  INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES
    ('$E2E_DESIGN_CUSTOMER', '', 'Pool service', '', '[{\"name\":\"Weekly pool care\",\"price\":\"\"}]', '[\"Charleston\"]', $NOW),
    ('$E2E_DESIGN_M_CUSTOMER', '', 'Pool service', '', '[{\"name\":\"Weekly pool care\",\"price\":\"\"}]', '[\"Charleston\"]', $NOW);
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_ADS_CUSTOMER', 'E2E Ads Pools', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-ads.example', '$E2E_ADS_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_ADS_SESSION_TOKEN")', 'owner@e2e-ads.example', $NOW, $FAR);
  INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, updated_at) VALUES
    ('$E2E_ADS_CUSTOMER', 'cus_E2EADS', 'sub_E2EADS', 'founding', 'active', 49900, 'usd', $FAR, $NOW);
  INSERT INTO ad_profiles (customer, industry, services, service_area, customer_value_cents, monthly_budget_cents, updated_at) VALUES
    ('$E2E_ADS_CUSTOMER', 'Pool service', '[\"Weekly pool cleaning\"]', '{\"zips\":[\"29403\"]}', 30000, 30000, $NOW);
  INSERT INTO ad_budget_approvals (id, customer, monthly_cents, approved_by, approved_at) VALUES ('e2e-ads-budget', '$E2E_ADS_CUSTOMER', 30000, 'owner@e2e-ads.example', $NOW);
  -- One of the business's own website photos (a 1×1 PNG), already approved as a Meta ad image (no AI, no cost).
  INSERT INTO website_assets (id, customer, content_type, bytes, size, created_at) VALUES ('e2ead5000000000000000000000ad5e2', '$E2E_ADS_CUSTOMER', 'image/png', X'89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082', 69, $NOW);
  INSERT INTO ad_creatives (id, customer, kind, provider, status, prompt, storage_key, mime, created_at, updated_at) VALUES ('e2e-ads-img', '$E2E_ADS_CUSTOMER', 'image', 'website_asset', 'approved', 'Your website photo', 'asset:e2ead5000000000000000000000ad5e2', 'image/png', $NOW, $NOW);
  INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('$E2E_ADS_CUSTOMER', 1, 'admin@e2e.example', $NOW);
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_IMPORT_CUSTOMER', 'E2E Import Pools', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-import.example', '$E2E_IMPORT_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_IMPORT_SESSION_TOKEN")', 'owner@e2e-import.example', $NOW, $FAR);
  INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, updated_at) VALUES
    ('$E2E_IMPORT_CUSTOMER', 'cus_E2EIMPORT', 'sub_E2EIMPORT', 'founding', 'active', 49900, 'usd', $FAR, $NOW);
  INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('$E2E_IMPORT_CUSTOMER', 1, 'admin@e2e.example', $NOW);
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_OPENAI_CUSTOMER', 'E2E ChatGPT Pools', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-openai.example', '$E2E_OPENAI_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_OPENAI_SESSION_TOKEN")', 'owner@e2e-openai.example', $NOW, $FAR);
  INSERT INTO ad_profiles (customer, website, industry, services, service_area, customer_value_cents, monthly_budget_cents, updated_at) VALUES
    ('$E2E_OPENAI_CUSTOMER', 'https://e2e-chatgpt-pools.example', 'Pool service', '[\"Pool repair\",\"Green pool cleanup\"]', '{\"zips\":[\"29403\"]}', 30000, 30000, $NOW);
  INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, updated_at) VALUES
    ('$E2E_OPENAI_CUSTOMER', 'cus_E2EOPENAI', 'sub_E2EOPENAI', 'founding', 'active', 49900, 'usd', $FAR, $NOW);
  INSERT INTO ad_budget_approvals (id, customer, monthly_cents, approved_by, approved_at) VALUES ('e2e-openai-budget', '$E2E_OPENAI_CUSTOMER', 60000, 'owner@e2e-openai.example', $NOW);
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_AREA_CUSTOMER', 'E2E Area Pools', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-area.example', '$E2E_AREA_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_AREA_SESSION_TOKEN")', 'owner@e2e-area.example', $NOW, $FAR);
  -- Established advertisers (ads.spec.js Journey A, one per browser project): connect the ads-existing sign-in whose
  -- test account already holds campaigns.
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_ADVERTISER_CUSTOMER', 'E2E Harbor Advertiser', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW),
    ('$E2E_ADVERTISER_M_CUSTOMER', 'E2E Harbor Advertiser Mobile', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-advertiser.example', '$E2E_ADVERTISER_CUSTOMER', $NOW), ('owner@e2e-advertiser-m.example', '$E2E_ADVERTISER_M_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_ADVERTISER_SESSION_TOKEN")', 'owner@e2e-advertiser.example', $NOW, $FAR), ('$(hash "$E2E_ADVERTISER_M_SESSION_TOKEN")', 'owner@e2e-advertiser-m.example', $NOW, $FAR);
  INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, updated_at) VALUES
    ('$E2E_ADVERTISER_CUSTOMER', 'cus_E2EADV', 'sub_E2EADV', 'founding', 'active', 49900, 'usd', $FAR, $NOW),
    ('$E2E_ADVERTISER_M_CUSTOMER', 'cus_E2EADVM', 'sub_E2EADVM', 'founding', 'active', 49900, 'usd', $FAR, $NOW);
  INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('$E2E_ADVERTISER_CUSTOMER', 1, 'admin@e2e.example', $NOW), ('$E2E_ADVERTISER_M_CUSTOMER', 1, 'admin@e2e.example', $NOW);
  -- First-time advertisers (ads.spec.js Journey B, one per browser project): no ad account, start from a template.
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_STARTER_CUSTOMER', 'E2E Coastal Air', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW),
    ('$E2E_STARTER_M_CUSTOMER', 'E2E Coastal Air Mobile', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-starter.example', '$E2E_STARTER_CUSTOMER', $NOW), ('owner@e2e-starter-m.example', '$E2E_STARTER_M_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_STARTER_SESSION_TOKEN")', 'owner@e2e-starter.example', $NOW, $FAR), ('$(hash "$E2E_STARTER_M_SESSION_TOKEN")', 'owner@e2e-starter-m.example', $NOW, $FAR);
  INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, updated_at) VALUES
    ('$E2E_STARTER_CUSTOMER', 'cus_E2ESTART', 'sub_E2ESTART', 'founding', 'active', 49900, 'usd', $FAR, $NOW),
    ('$E2E_STARTER_M_CUSTOMER', 'cus_E2ESTARTM', 'sub_E2ESTARTM', 'founding', 'active', 49900, 'usd', $FAR, $NOW);
  INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('$E2E_STARTER_CUSTOMER', 1, 'admin@e2e.example', $NOW), ('$E2E_STARTER_M_CUSTOMER', 1, 'admin@e2e.example', $NOW);
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$E2E_DELETE_CUSTOMER', 'E2E Delete Pools', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('e2e-acct', 'E2E Account Pools', 'America/New_York', '', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW),
    ('e2e-acct-m', 'E2E Account Mobile', 'America/New_York', '', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES
    ('e2e-acct', '', 'Pool service', '', '[]', '[]', $NOW), ('e2e-acct-m', '', 'Pool service', '', '[]', '[]', $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-acct.example', 'e2e-acct', $NOW), ('owner@e2e-acct-m.example', 'e2e-acct-m', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_ACCT_OLD_SESSION_TOKEN")', 'owner@e2e-acct.example', $((NOW - 3600000)), $FAR);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@e2e-delete.example', '$E2E_DELETE_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_DELETE_SESSION_TOKEN")', 'owner@e2e-delete.example', $((NOW - 3600000)), $FAR);
  INSERT INTO subscriptions (customer, stripe_customer_id, stripe_subscription_id, plan_id, status, mrr_cents, currency, current_period_end, last_event_at, updated_at) VALUES
    ('$E2E_DELETE_CUSTOMER', 'cus_E2EDEL', 'sub_E2EDEL', 'founding', 'active', 49900, 'usd', $FAR, 0, $NOW);
  INSERT INTO leads (id, customer, name, email, phone, need, zip, status, token_hash, created_at, updated_at) VALUES
    ('seed-lead-delete', '$E2E_DELETE_CUSTOMER', 'Dee Delete', 'dee@example.net', '555-010-0107', 'Pool opening', '29403', 'new', 'x', $NOW, $NOW);"

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
# Website Studio editor tests: two businesses (desktop / mobile project) with the same AI-designed draft (no AI call).
EDITOR_DRAFT=$(node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('test/e2e/editor-draft.json','utf8'))).replace(/'/g, \"''\"))")
for E in "$E2E_EDITOR_CUSTOMER:$E2E_EDITOR_SESSION_TOKEN" "$E2E_EDITOR_M_CUSTOMER:$E2E_EDITOR_M_SESSION_TOKEN"; do
  EC=${E%%:*}
  ET=${E#*:}
  d1 "
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$EC', 'Editor Pools', 'America/New_York', '', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@$EC.example', '$EC', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$ET")', 'owner@$EC.example', $NOW, $FAR);
  INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES
    ('$EC', '(843) 555-0110', 'Pool service', '', '[{\"name\":\"Weekly pool care\",\"price\":\"\$280+\"}]', '[\"Charleston\"]', $NOW);
  INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES ('$EC', '$EDITOR_DRAFT', NULL, NULL, $NOW);
  "
done

# Publish/restore test: its own business whose site is already published (version 1 = "Pool care in Charleston").
PUBLISHED=$(node -e "const d=JSON.parse(require('fs').readFileSync('test/e2e/editor-draft.json','utf8')); delete d.site; process.stdout.write(JSON.stringify(d).replace(/'/g, \"''\"))")
d1 "
INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
  ('$E2E_PUBLISH_CUSTOMER', 'Publish Pools', 'America/New_York', '', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@$E2E_PUBLISH_CUSTOMER.example', '$E2E_PUBLISH_CUSTOMER', $NOW);
INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_PUBLISH_SESSION_TOKEN")', 'owner@$E2E_PUBLISH_CUSTOMER.example', $NOW, $FAR);
INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES
  ('$E2E_PUBLISH_CUSTOMER', '(843) 555-0111', 'Pool service', '', '[{\"name\":\"Weekly pool care\",\"price\":\"\$280+\"}]', '[\"Charleston\"]', $NOW);
INSERT INTO website_versions (customer, version, content, created_at) VALUES ('$E2E_PUBLISH_CUSTOMER', 1, '$PUBLISHED', $NOW);
INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES ('$E2E_PUBLISH_CUSTOMER', '$PUBLISHED', 1, $NOW, $NOW);
"

# Website Studio full journey: a fresh HVAC business per browser project (no website yet; calendar + hours ready).
for E in "$E2E_FLOW_CUSTOMER:$E2E_FLOW_SESSION_TOKEN" "$E2E_FLOW_M_CUSTOMER:$E2E_FLOW_M_SESSION_TOKEN"; do
  FC=${E%%:*}
  FT=${E#*:}
  d1 "
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$FC', 'Northwind Air', 'America/Chicago', '', '08:00', '18:00', '1,2,3,4,5', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@$FC.example', '$FC', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$FT")', 'owner@$FC.example', $NOW, $FAR);
  INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES
    ('$FC', '(612) 555-0142', 'HVAC', '', '[]', '[\"Minneapolis\"]', $NOW);
  "
done

# Teach Your AI: a pool business per browser project (visits the customer; towns + ZIP list for coverage rules).
for E in "$E2E_TEACH_CUSTOMER:$E2E_TEACH_SESSION_TOKEN" "$E2E_TEACH_M_CUSTOMER:$E2E_TEACH_M_SESSION_TOKEN"; do
  TC=${E%%:*}
  TT=${E#*:}
  d1 "
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$TC', 'Harbor Pools', 'America/New_York', '29464,29466,29401', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO service_settings (customer, appointment_mode, updated_at) VALUES ('$TC', 'at_customer', $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@$TC.example', '$TC', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$TT")', 'owner@$TC.example', $NOW, $FAR);
  INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES
    ('$TC', '(843) 555-0130', 'Pool service', '', '[{\"name\":\"Weekly pool care\",\"price\":\"\$160/month\"},{\"name\":\"Green pool cleanup\",\"price\":\"\"}]', '[\"Mount Pleasant\",\"Charleston\"]', $NOW);
  "
done

# Visual tour: one fictional business with bookings, receptionist conversations and an open callback request.
d1 "$(node test/e2e/seed-tour.mjs "$E2E_TOUR_CUSTOMER" "$(hash "$E2E_TOUR_SESSION_TOKEN")" "$NOW")"

# Follow-ups: a business per browser project, texting registration APPROVED (as an admin records it) with its own
# sender, default preferences (answers to their texts aren't held by quiet hours), one lead with texting consent.
for E in "$E2E_TEXTS_CUSTOMER:$E2E_TEXTS_SESSION_TOKEN:$E2E_TEXTS_SENDER:$E2E_TEXTS_ACCOUNT_SID" "$E2E_TEXTS_M_CUSTOMER:$E2E_TEXTS_M_SESSION_TOKEN:$E2E_TEXTS_M_SENDER:$E2E_TEXTS_M_ACCOUNT_SID"; do
  IFS=: read -r TC TT TS TA <<< "$E"
  d1 "
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$TC', 'Texts Pools', 'America/New_York', '', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@$TC.example', '$TC', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$TT")', 'owner@$TC.example', $NOW, $FAR);
  INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES
    ('$TC', '(843) 555-0120', 'Pool service', '', '[{\"name\":\"Weekly pool care\",\"price\":\"\$280\"}]', '[\"Charleston\"]', $NOW);
  INSERT INTO sms_registrations (customer, legal_name, business_type, status, approved_at, sender_phone, updated_at) VALUES ('$TC', 'Texts Pools LLC', 'llc', 'approved', $NOW, '$TS', $NOW);
  INSERT INTO sms_accounts (customer, account_sid, auth_token_enc, status, created_at, updated_at) VALUES ('$TC', '$TA', 'unreadable-in-e2e', 'active', $NOW, $NOW);
  INSERT INTO leads (id, customer, name, email, phone, need, status, token_hash, created_at, updated_at) VALUES
    ('lead-$TC', '$TC', 'Morgan Lane', 'morgan@example.net', '$E2E_TEXTS_LEAD_PHONE', 'Green pool cleanup', 'new', 'x', $NOW, $NOW);
  INSERT INTO sms_consents (lead_id, customer, wording, consented_at) VALUES ('lead-$TC', '$TC', 'site-form-sms-v1', $NOW);
  INSERT INTO lead_threads (lead_id, customer, source, stage, created_at, updated_at) VALUES ('lead-$TC', '$TC', 'website_form', 'contacted', $NOW, $NOW);
  INSERT INTO thread_messages (id, customer, lead_id, direction, channel, author, body, status, created_at, updated_at) VALUES
    ('seed-ack-$TC', '$TC', 'lead-$TC', 'out', 'email', 'auto', 'Texts Pools got your message', 'sent', $NOW, $NOW);
  "
done

# Receptionist voice seeds: one business per browser project, receptionist on; the voice admin is a member of the
# desktop business (customer_users.email is the key: one business per member). ONE wrangler call for all of it.
VOICE_SQL=""
for E in "$E2E_VOICE_CUSTOMER:$E2E_VOICE_SESSION_TOKEN" "$E2E_VOICE_M_CUSTOMER:$E2E_VOICE_M_SESSION_TOKEN"; do
  VC=${E%%:*}
  VT=${E#*:}
  VOICE_SQL="$VOICE_SQL
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$VC', 'Voice Pools', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@$VC.example', '$VC', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$VT")', 'owner@$VC.example', $NOW, $FAR);
  INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES ('$VC', '(843) 555-0188', 'Pool service', 'Pool care.', '[{\"name\":\"Weekly pool care\",\"price\":\"\$280/month\"}]', '[\"Charleston\"]', $NOW);
  INSERT INTO receptionist_settings (customer, enabled, mode, greeting, updated_at) VALUES ('$VC', 1, 'ai_first', 'Hi! Thanks for calling Voice Pools.', $NOW);
  INSERT INTO website_versions (customer, version, content, created_at) VALUES ('$VC', 1, '$PUBLISHED', $NOW);
  INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES ('$VC', '$PUBLISHED', 1, $NOW, $NOW);"
done
VS=$E2E_VOICE_SWITCH_CUSTOMER
d1 "$VOICE_SQL
  INSERT INTO customer_users (email, customer, created_at) VALUES ('$E2E_VOICE_ADMIN_EMAIL', '$E2E_VOICE_CUSTOMER', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_VOICE_ADMIN_SESSION_TOKEN")', '$E2E_VOICE_ADMIN_EMAIL', $NOW, $FAR);
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$VS', 'Switch Pools', 'America/New_York', '29403', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@switch.example', '$VS', $NOW);
  INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES ('$VS', '(843) 555-0177', 'Pool service', 'Pool care.', '[{\"name\":\"Weekly pool care\",\"price\":\"\$280/month\"}]', '[\"Charleston\"]', $NOW);
  INSERT INTO receptionist_settings (customer, enabled, mode, greeting, updated_at) VALUES ('$VS', 1, 'ai_first', 'Hi! Thanks for calling Switch Pools.', $NOW);
  INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('$VS', 1, '$E2E_PLATFORM_ADMIN', $NOW);
  INSERT INTO receptionist_voice_settings (customer, provider, voice_id, voice_name, personality, pace, language, previous, version, updated_by, updated_at) VALUES ('$VS', 'openai', 'cedar', 'Cedar', 'warm', 'normal', 'en', NULL, 1, 'ref:seed', $NOW);
  INSERT INTO receptionist_conversations (id, customer, channel, state, transcript, created_at, updated_at) VALUES ('conv-$VS-test', '$VS', 'voice', '{\"voice\":{\"provider\":\"retell\",\"startedAt\":$((NOW - 120000)),\"endedAt\":$((NOW - 60000)),\"test\":true,\"metrics\":{\"micLive\":1,\"audioReceived\":1}},\"tools\":[{\"name\":\"find_available_times\",\"ok\":true},{\"name\":\"book_appointment\",\"ok\":true,\"simulated\":true}],\"booked\":{\"simulated\":true}}', '[]', $((NOW - 120000)), $((NOW - 60000)));
  INSERT INTO receptionist_calls (call_id, customer, conversation_id, provider, created_at, ended_at) VALUES ('call_seed_$VS', '$VS', 'conv-$VS-test', 'retell', $((NOW - 120000)), $((NOW - 60000)));"

for C in "$E2E_CUSTOMER" "$E2E_SPARE_CUSTOMER" "$E2E_HOME_CUSTOMER" "$E2E_AUTO_CUSTOMER" "$E2E_ADS_CUSTOMER" "$E2E_AREA_CUSTOMER" "$E2E_IMPORT_CUSTOMER" "$E2E_OPENAI_CUSTOMER" "$E2E_ADVERTISER_CUSTOMER" "$E2E_ADVERTISER_M_CUSTOMER" "$E2E_STARTER_CUSTOMER" "$E2E_STARTER_M_CUSTOMER" "$E2E_DELETE_CUSTOMER" e2e-acct e2e-acct-m "$E2E_DESIGN_CUSTOMER" "$E2E_DESIGN_M_CUSTOMER" "$E2E_EDITOR_CUSTOMER" "$E2E_EDITOR_M_CUSTOMER" "$E2E_TEXTS_CUSTOMER" "$E2E_TEXTS_M_CUSTOMER" "$E2E_TOUR_CUSTOMER" "$E2E_FLOW_CUSTOMER" "$E2E_FLOW_M_CUSTOMER" "$E2E_PUBLISH_CUSTOMER" "$E2E_TEACH_CUSTOMER" "$E2E_TEACH_M_CUSTOMER" "$E2E_VOICE_CUSTOMER" "$E2E_VOICE_M_CUSTOMER" "$E2E_VOICE_SWITCH_CUSTOMER"; do
  kvput "google:$C" "$(record "$C")"
done

# studio-hardening seeds (Agent A): one business per browser project with the editor's AI-designed draft (no AI call)
# and a calendar record, for studio-hardening.spec.js (full screen + Back/Forward, editor state, photo usage).
for E in "$E2E_STUDIO_H_CUSTOMER:$E2E_STUDIO_H_SESSION_TOKEN" "$E2E_STUDIO_H_M_CUSTOMER:$E2E_STUDIO_H_M_SESSION_TOKEN"; do
  HC=${E%%:*}
  HT=${E#*:}
  d1 "
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
    ('$HC', 'Harden Pools', 'America/New_York', '', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
  INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@$HC.example', '$HC', $NOW);
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$HT")', 'owner@$HC.example', $NOW, $FAR);
  INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES
    ('$HC', '(843) 555-0112', 'Pool service', '', '[{\"name\":\"Weekly pool care\",\"price\":\"\$280+\"}]', '[\"Charleston\"]', $NOW);
  INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES ('$HC', '$EDITOR_DRAFT', NULL, NULL, $NOW);
  "
  kvput "google:$HC" "$(record "$HC")"
done

# Assisted enrollment (enrollment.spec.js): two sales representatives and one whose access the spec revokes (roles as a
# platform admin grants them), and two owners WITHOUT a business who claim what staff set up for them.
d1 "
  INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES
    ('$(hash "$E2E_SALES_REP_SESSION_TOKEN")', '$E2E_SALES_REP_EMAIL', $NOW, $FAR),
    ('$(hash "$E2E_SALES_REP2_SESSION_TOKEN")', '$E2E_SALES_REP2_EMAIL', $NOW, $FAR),
    ('$(hash "$E2E_SALES_REVOKED_SESSION_TOKEN")', '$E2E_SALES_REVOKED_EMAIL', $NOW, $FAR),
    ('$(hash "$E2E_SALES_OWNER_SESSION_TOKEN")', '$E2E_SALES_OWNER_EMAIL', $NOW, $FAR),
    ('$(hash "$E2E_SALES_OWNER2_SESSION_TOKEN")', '$E2E_SALES_OWNER2_EMAIL', $NOW, $FAR);
  INSERT INTO commercial_roles (email, role, granted_by, granted_at) VALUES
    ('$E2E_SALES_REP_EMAIL', 'sales_rep', '$E2E_PLATFORM_ADMIN', $NOW),
    ('$E2E_SALES_REP2_EMAIL', 'sales_rep', '$E2E_PLATFORM_ADMIN', $NOW),
    ('$E2E_SALES_REVOKED_EMAIL', 'sales_rep', '$E2E_PLATFORM_ADMIN', $NOW);
"

# Control Center demo (control-center.spec.js): a bookable TEST business with a calendar record; faults are injected
# through the Google mock (/__faults), never in the app.
d1 "
INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
  ('$E2E_CC_CUSTOMER', 'Control Demo Pools', 'America/New_York', '', '06:00', '22:00', '0,1,2,3,4,5,6', $NOW, $NOW, $NOW);
INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@$E2E_CC_CUSTOMER.example', '$E2E_CC_CUSTOMER', $NOW);
INSERT INTO test_businesses (customer, is_test, marked_by, marked_at) VALUES ('$E2E_CC_CUSTOMER', 1, '$E2E_PLATFORM_ADMIN', $NOW);
"
kvput "google:$E2E_CC_CUSTOMER" "$(record "$E2E_CC_CUSTOMER")"

# AI spending limits for this TEST server only (server/ai-budget.js): the production defaults ($1 per business, 60 Retell
# minutes, open calls counted at 15 min) would refuse mocked voice and chat calls of parallel specs during one run.
d1 "
INSERT INTO ai_budget_settings (key, value, updated_by, updated_at) VALUES
  ('platform_micros', 100000000, 'e2e', $NOW), ('public_micros', 100000000, 'e2e', $NOW), ('business_micros', 100000000, 'e2e', $NOW), ('retell_minutes', 1000, 'e2e', $NOW),
  ('openai_minutes', 1000, 'e2e', $NOW), ('elevenlabs_minutes', 1000, 'e2e', $NOW);
"

# Business details (business-details.spec.js): per-day hours saved in Settings, and a public address on the booking page.
d1 "
INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
  ('$E2E_DETAILS_CUSTOMER', 'Harbor Studio', 'America/New_York', '', '09:00', '17:00', '1,2,3,4,5', $NOW, $NOW, $NOW);
INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@$E2E_DETAILS_CUSTOMER.example', '$E2E_DETAILS_CUSTOMER', $NOW);
INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_DETAILS_SESSION_TOKEN")', 'owner@$E2E_DETAILS_CUSTOMER.example', $NOW, $FAR);
INSERT INTO business_addresses (customer, street, unit, city, state, zip, public, updated_at) VALUES
  ('$E2E_DETAILS_CUSTOMER', '12 Harbor St', 'Suite 2', 'Charleston', 'SC', '29401', 1, $NOW);
"
kvput "google:$E2E_DETAILS_CUSTOMER" "$(record "$E2E_DETAILS_CUSTOMER")"

# Email sign-in (email-signin.spec.js): a member's business, and one sign-in link that expired a minute ago.
d1 "
INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
  ('$E2E_EMAILAUTH_CUSTOMER', 'Lantern Window Cleaning', 'America/New_York', '', '08:00', '17:00', '1,2,3,4,5', $NOW, $NOW, $NOW);
INSERT INTO customer_users (email, customer, created_at) VALUES ('$E2E_EMAILAUTH_OWNER', '$E2E_EMAILAUTH_CUSTOMER', $NOW);
INSERT INTO email_login_tokens (id, email_hash, link_hash, code_hash, browser_hash, next, attempts, created_at, expires_at) VALUES
  ('e2e-expired', '$(hash "email-login:$E2E_EMAILAUTH_LINK")', '$(hash "$E2E_EMAILAUTH_EXPIRED_LINK")', 'none', 'none', '/dashboard', 0, $((NOW - 960000)), $((NOW - 60000)));
"
# Phone line (phone.spec.js): a seeded line (no Twilio purchase), one verified phone that rings, one missed call with its
# callback task. Nothing calls Twilio: the spec only reads and saves settings.
d1 "
INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at) VALUES
  ('$E2E_PHONE_CUSTOMER', 'Dial Pools', 'America/New_York', '', '09:00', '17:00', '1,2,3,4,5', $NOW, $NOW, $NOW);
INSERT INTO customer_users (email, customer, created_at) VALUES ('owner@$E2E_PHONE_CUSTOMER.example', '$E2E_PHONE_CUSTOMER', $NOW);
INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES ('$(hash "$E2E_PHONE_SESSION_TOKEN")', 'owner@$E2E_PHONE_CUSTOMER.example', $NOW, $FAR);
INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at) VALUES ('$E2E_PHONE_CUSTOMER', '', 'pool', '', '[]', '[]', $NOW);
INSERT INTO phone_lines (id, customer, number, source, status, created_at, updated_at) VALUES ('pl_e2e', '$E2E_PHONE_CUSTOMER', '+18435550160', 'website', 'active', $NOW, $NOW);
INSERT INTO phone_destinations (id, customer, number, label, verified_at, created_at) VALUES ('pd_e2e', '$E2E_PHONE_CUSTOMER', '+18435550161', 'Owner cell', $NOW, $NOW);
INSERT INTO receptionist_requests (id, customer, conversation_id, kind, phone, note, created_at, updated_at) VALUES ('rq_e2e_call', '$E2E_PHONE_CUSTOMER', 'call:CA00000000000000000000000000000e2e', 'callback', '+18435550162', 'Missed phone call', $NOW, $NOW);
INSERT INTO phone_calls (call_sid, customer, line_id, caller, caller_state, source, route, outcome, duration_seconds, request_id, started_at, ended_at, updated_at) VALUES
  ('CA00000000000000000000000000000e2e', '$E2E_PHONE_CUSTOMER', 'pl_e2e', '+18435550162', 'known', 'website', 'team', 'callback', 31, 'rq_e2e_call', $((NOW - 600000)), $((NOW - 569000)), $NOW);
"
# A connected calendar, so the dashboard opens on its tabs (Settings) instead of onboarding.
kvput "google:$E2E_PHONE_CUSTOMER" "$(record "$E2E_PHONE_CUSTOMER")"

# Global default history (voice-rollout.spec.js, promotion): version 1 staged ElevenLabs and pinned every business of
# the time to Retell (a settings row, no inherit row); version 2 rolled the default back to Retell but the pins were
# kept (changed since). So every seeded business is a ROLLOUT PIN on Retell (same behaviour as before for every other
# spec: Retell everywhere, businesses created later follow Retell) and "Promote to 100%" has something to release.
d1 "
INSERT INTO receptionist_voice_settings (customer, provider, voice_id, voice_name, personality, pace, language, previous, version, updated_by, updated_at)
  SELECT id, 'retell', NULL, NULL, 'standard', 'normal', 'en', NULL, 1, 'ref:seed', $NOW FROM customers
   WHERE id != '$E2E_VOICE_SWITCH_CUSTOMER' AND id NOT IN (SELECT customer FROM receptionist_voice_settings);
INSERT INTO receptionist_voice_defaults (version, provider, previous, mode, pinned, switched, set_by, set_at) VALUES
  (1, 'elevenlabs', 'retell', 'staged', (SELECT json_group_array(json_object('customer', id, 'version', 1, 'provider', 'retell')) FROM customers WHERE id != '$E2E_VOICE_SWITCH_CUSTOMER'), '[]', 'ref:seed', $((NOW - 7200000))),
  (2, 'retell', 'elevenlabs', 'rollback', '[]', '[]', 'ref:seed', $((NOW - 3600000)));
"

# Apply the collected seed (one D1 call) and the token records (one KV bulk call).
npx wrangler d1 execute ONBOARDING_DB --local --persist-to "$STATE" -c test/e2e/wrangler.e2e.toml --file "$SEED_SQL" >/dev/null
node -e "
const fs = require('fs')
const rows = fs.readFileSync(process.argv[1], 'utf8').split('\\n').filter(Boolean).map((l) => { const [key, b64] = l.split('\\t'); return { key, value: Buffer.from(b64, 'base64').toString('utf8') } })
fs.writeFileSync(process.argv[2], JSON.stringify(rows))
" "$SEED_KV" "$STATE.kv.json"
npx wrangler kv bulk put "$STATE.kv.json" --binding GOOGLE_TOKENS --local --persist-to "$STATE" -c test/e2e/wrangler.e2e.toml >/dev/null

exec npx wrangler pages dev "$OUT" --ip 127.0.0.1 --port "$E2E_PORT" \
  --compatibility-date 2026-11-08 --persist-to "$STATE" --show-interactive-dev-session=false \
  --d1 ONBOARDING_DB=e2e-onboarding --kv GOOGLE_TOKENS=GOOGLE_TOKENS \
  --binding GOOGLE_CLIENT_ID="$E2E_GOOGLE_CLIENT_ID" \
  --binding GOOGLE_CLIENT_SECRET=e2e-fake-client-secret \
  --binding GOOGLE_REDIRECT_URI="http://127.0.0.1:$E2E_PORT/api/google/oauth/callback" \
  --binding TOKEN_ENCRYPTION_KEY="$E2E_TOKEN_ENCRYPTION_KEY" \
  --binding ADMIN_API_TOKEN="$E2E_ADMIN_API_TOKEN" \
  --binding ADS_ENABLED=true \
  --binding GOOGLE_CALLS_ENABLED=true \
  --binding ACCEPTANCE_SESSIONS_ENABLED=true \
  --binding STRIPE_SECRET_KEY="$E2E_STRIPE_SECRET_KEY" \
  --binding STRIPE_WEBHOOK_SECRET="$E2E_STRIPE_WEBHOOK_SECRET" \
  --binding STRIPE_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding GOOGLE_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding GOOGLE_ADS_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding GBP_ENABLED=true \
  --binding GBP_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding DNS_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding SITE_IMPORT_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding AI_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding RECEPTIONIST_ANTHROPIC_API_KEY=sk-ant-e2e-fake-key-not-a-secret \
  --binding ACCOUNT_DELETION_ENABLED=true \
  --binding PLATFORM_ADMIN_EMAILS="$E2E_PLATFORM_ADMIN,$E2E_VOICE_ADMIN_EMAIL" \
  --binding RESEARCH_FOUNDER_EMAIL="$E2E_PLATFORM_ADMIN" \
  --binding RETELL_API_KEY=retell_e2e_fake_key_not_a_secret_0123456789 \
  --binding RETELL_AGENT_ID=agent_e2efake000001 \
  --binding RETELL_WS_SECRET=e2e_ws_secret_not_a_secret_0123456789abcdef \
  --binding RETELL_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding TWILIO_ACCOUNT_SID=ACe2e00000000000000000000000000000 \
  --binding TWILIO_AUTH_TOKEN="$E2E_TWILIO_AUTH_TOKEN" \
  --binding TWILIO_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding MESSAGE_TEST_RECIPIENTS="$E2E_TEXTS_LEAD_PHONE,$E2E_SELF_SERVE_EMAIL,founder-mobile@e2e-selfserve.example,$E2E_JOURNEY_EMAIL,$E2E_JOURNEY_M_EMAIL,$E2E_EMAILAUTH_OWNER,$E2E_EMAILAUTH_NEW,$E2E_EMAILAUTH_LINK,$E2E_EMAILAUTH_PHONE,$E2E_EMAILAUTH_PHONE_M,$E2E_SALES_OWNER_EMAIL,$E2E_SALES_OWNER2_EMAIL" \
  --binding AUTH_EMAIL_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding FOLLOWUP_AI=true \
  --binding CRON_SECRET="$E2E_CRON_SECRET" \
  --binding QA_INGEST_TOKEN="$E2E_QA_INGEST_TOKEN" \
  --binding RECEPTIONIST_VOICE_BUSINESSES="$E2E_VOICE_M_CUSTOMER" \
  --binding PHONE_ENABLED=true \
  --binding META_APP_ID="$E2E_META_APP_ID" \
  --binding META_APP_SECRET="$E2E_META_APP_SECRET" \
  --binding META_WEBHOOK_VERIFY_TOKEN="$E2E_META_VERIFY_TOKEN" \
  --binding META_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding META_SANDBOX_AD_ACCOUNTS=act_111 \
  --binding OPENAI_ADS_ENABLED=true \
  --binding OPENAI_ADS_VERIFY_BUSINESSES="$E2E_OPENAI_CUSTOMER" \
  --binding OPENAI_ADS_API_MOCK_ORIGIN="http://127.0.0.1:$E2E_GOOGLE_MOCK_PORT" \
  --binding VOICE_LAB_ENABLED=true
