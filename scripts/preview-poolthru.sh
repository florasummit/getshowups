#!/usr/bin/env bash
# Local, isolated preview of the PoolThru website draft on the real site engine (wrangler pages dev).
# Uses a throwaway local database seeded only with PoolThru's public business details and the draft in
# docs/poolthru/website-draft.json, plus FAKE credentials and a local calendar stand-in. Nothing here reads
# or writes production, and no real booking can be made (the calendar is a local mock).
#   npm run preview:poolthru  →  http://127.0.0.1:8795/p/poolthru-llc
set -euo pipefail
cd "$(dirname "$0")/.."
source test/e2e/fixtures.env
PORT=8795
MOCK=8796
STATE=.wrangler/preview-state
OUT=.wrangler/preview-dist
DRAFT=$(node -e "process.stdout.write(JSON.stringify(require('./docs/poolthru/website-draft.json')).replace(/'/g, \"''\"))")
SERVICES=$(node -e "const d=require('./docs/poolthru/website-draft.json');process.stdout.write(JSON.stringify(d.services.map(s=>({name:s.name,price:s.price}))).replace(/'/g, \"''\"))")

VITE_GHL_BOOKING_URL= npx vite build --outDir "$OUT" --emptyOutDir --logLevel warn
rm -rf "$STATE"
for m in migrations/*.sql; do npx wrangler d1 execute ONBOARDING_DB --local --persist-to "$STATE" -c test/e2e/wrangler.e2e.toml --file "$m" >/dev/null; done
NOW=$(node -e 'process.stdout.write(String(Date.now()))')
npx wrangler d1 execute ONBOARDING_DB --local --persist-to "$STATE" -c test/e2e/wrangler.e2e.toml --command "
  INSERT INTO customers (id, name, timezone, service_zips, day_start, day_end, workdays, hours_confirmed_at, created_at, updated_at)
    VALUES ('poolthru-llc', 'Poolthru LLC', 'America/New_York', '29403', '09:00', '17:00', '1,2,3,4,5', $NOW, $NOW, $NOW);
  INSERT INTO business_profiles (customer, phone, industry, description, services, cities, updated_at)
    VALUES ('poolthru-llc', '(678) 855-8825', 'Pool service', '', '$SERVICES', '[\"Charleston\"]', $NOW);
  INSERT INTO website_versions (customer, version, content, created_at) VALUES ('poolthru-llc', 1, '$DRAFT', $NOW);
  INSERT INTO websites (customer, draft, live_version, published_at, updated_at) VALUES ('poolthru-llc', '$DRAFT', 1, $NOW, $NOW);" >/dev/null
RECORD=$(K="$E2E_TOKEN_ENCRYPTION_KEY" node --input-type=module -e "
  import { encrypt } from './server/google-oauth.js'
  const refreshToken = await encrypt({ TOKEN_ENCRYPTION_KEY: process.env.K }, 'mock-refresh-preview')
  process.stdout.write(JSON.stringify({ customer: 'poolthru-llc', googleSub: 'preview', email: 'calendar@preview.example', scope: 'openid email https://www.googleapis.com/auth/calendar.events.owned https://www.googleapis.com/auth/calendar.freebusy', refreshToken, connectedAt: new Date().toISOString() }))")
npx wrangler kv key put "google:poolthru-llc" "$RECORD" --binding GOOGLE_TOKENS --local --persist-to "$STATE" -c test/e2e/wrangler.e2e.toml >/dev/null

E2E_GOOGLE_MOCK_PORT=$MOCK E2E_PORT=$PORT node test/e2e/mock-google.mjs &
trap 'kill %1 2>/dev/null' EXIT
echo "PoolThru preview: http://127.0.0.1:$PORT/p/poolthru-llc   (Ctrl+C to stop)"
npx wrangler pages dev "$OUT" --ip 127.0.0.1 --port "$PORT" \
  --compatibility-date 2026-11-08 --persist-to "$STATE" --show-interactive-dev-session=false \
  --d1 ONBOARDING_DB=e2e-onboarding --kv GOOGLE_TOKENS=GOOGLE_TOKENS \
  --binding GOOGLE_CLIENT_ID="$E2E_GOOGLE_CLIENT_ID" --binding GOOGLE_CLIENT_SECRET=preview-fake-secret \
  --binding GOOGLE_REDIRECT_URI="http://127.0.0.1:$PORT/api/google/oauth/callback" \
  --binding TOKEN_ENCRYPTION_KEY="$E2E_TOKEN_ENCRYPTION_KEY" --binding ADMIN_API_TOKEN="$E2E_ADMIN_API_TOKEN" \
  --binding GOOGLE_API_MOCK_ORIGIN="http://127.0.0.1:$MOCK"
