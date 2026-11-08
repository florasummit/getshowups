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

exec npx wrangler pages dev "$OUT" --ip 127.0.0.1 --port "$E2E_PORT" \
  --compatibility-date 2026-11-08 --persist-to "$STATE" --show-interactive-dev-session=false \
  --d1 ONBOARDING_DB=e2e-onboarding --kv GOOGLE_TOKENS \
  --binding GOOGLE_CLIENT_ID="$E2E_GOOGLE_CLIENT_ID" \
  --binding GOOGLE_CLIENT_SECRET=e2e-fake-client-secret \
  --binding GOOGLE_REDIRECT_URI="http://127.0.0.1:$E2E_PORT/api/google/oauth/callback" \
  --binding TOKEN_ENCRYPTION_KEY="$E2E_TOKEN_ENCRYPTION_KEY" \
  --binding ADMIN_API_TOKEN="$E2E_ADMIN_API_TOKEN"
