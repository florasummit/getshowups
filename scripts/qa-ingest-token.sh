#!/bin/sh
# QA ingestion token: generate ONE random token and store it in the two places that need it, without ever printing it,
# writing it to a file, or putting it in shell history. Needs approval (production secret). docs/QA_CI_SETUP.md.
#
#   scripts/qa-ingest-token.sh            # plan only: prints what it would do, changes nothing
#   scripts/qa-ingest-token.sh --apply    # generate + store (also used to ROTATE: both places get the new value)
#
# 1. Cloudflare Pages (production) secret QA_INGEST_TOKEN, via stdin to wrangler. Takes effect on the NEXT deployment.
# 2. GitHub: the value is put on the macOS clipboard; you paste it as the secret QA_INGEST_TOKEN of the environment
#    `qa-ingest` (Settings → Environments), press Enter here, and the clipboard is cleared.
# Revoke: npx wrangler pages secret delete QA_INGEST_TOKEN --project-name getshowups, then redeploy (endpoint → 503).
set -eu
PROJECT=getshowups
if [ "${1:-}" != "--apply" ]; then
  echo "Plan (nothing changed):"
  echo "  1. generate 32 random bytes (base64url, 43 chars) in memory"
  echo "  2. npx wrangler pages secret put QA_INGEST_TOKEN --project-name $PROJECT   (value on stdin)"
  echo "  3. copy the same value to the clipboard for GitHub → Settings → Environments → qa-ingest → secret QA_INGEST_TOKEN"
  echo "  4. clear the clipboard; forget the value"
  echo "Then redeploy Pages (any merge to main) and check: curl -s -X POST https://getshowups.com/api/qa/runs → 401 (was 503)."
  echo "Run again with --apply (approval required)."
  exit 0
fi
command -v pbcopy >/dev/null || { echo "pbcopy not found (macOS only)"; exit 1; }
T=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")
[ "${#T}" -eq 43 ] || { echo "token generation failed"; exit 1; }
if ! printf %s "$T" | npx wrangler pages secret put QA_INGEST_TOKEN --project-name "$PROJECT" >/dev/null 2>&1; then
  T=; echo "Cloudflare: storing the secret FAILED (nothing else done)"; exit 1
fi
echo "Cloudflare: QA_INGEST_TOKEN stored for $PROJECT (production). Effective after the next deployment."
printf %s "$T" | pbcopy
T=
echo "GitHub: the token is on the clipboard. Paste it now as the secret QA_INGEST_TOKEN of environment 'qa-ingest',"
printf "then press Enter to clear the clipboard... "
read -r _
pbcopy </dev/null
echo "Clipboard cleared. The token was not printed or saved anywhere else."
