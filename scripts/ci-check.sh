#!/usr/bin/env bash
# One bounded, nonblocking look at a PR's CI (never --watch): prints state and exits 0 pass · 1 fail · 2 pending/unknown.
# Usage: scripts/ci-check.sh <pr>
set -u
cd "$(dirname "$0")/.."
out=$(perl -e 'alarm 25; exec @ARGV' scripts/gh.sh pr checks "$1" 2>&1)
echo "$out" | awk -F'\t' '{print $1": "$2" "$3}'
if echo "$out" | grep -qE $'\t(fail|cancel)'; then exit 1; fi
if echo "$out" | grep -qE $'^verify\tpass' && ! echo "$out" | grep -qE $'\tpending'; then exit 0; fi
exit 2
